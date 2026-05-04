// Minimal PTT client for Cloudflare Workers.
// Scope: connect → login → dump screen → logout. Nothing else.
//
// Strategy: skip the full terminal emulator. Decode bytes (Big5 before login,
// UTF-8 after), strip ANSI escape sequences, accumulate into a rolling text
// buffer, and substring-match against the six known login prompts ported from
// kevinptt0323/ptt-client/src/sites/ptt/bot.ts:225-267.

const PTT_WS_URL = "https://ws.ptt.cc/bbs/";
const PTT_ORIGIN = "https://term.ptt.cc";

const KEY_ENTER = "\r";
const ANSI_RE = /\x1b\[[\??!>]?[0-9;]*[@A-Za-z`]|\x1b[\(\)][AB012]|\x07/g;
const HTTP_NOISE_RE = /^HTTP\/1\.\d \d+ [^\r\n]*\r?\n\r?\n/;
const ROLLING_BUFFER_LIMIT = 32 * 1024;

const enum Charset {
  Big5 = "big5",
  Utf8 = "utf-8",
}

export type LoginResult =
  | { ok: true; screen: string; elapsed_ms: number }
  | { ok: false; reason: string; screen: string; elapsed_ms: number };

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "").replace(HTTP_NOISE_RE, "");
}

class PttSocket {
  private ws: WebSocket | null = null;
  private chunks: Promise<void>[] = [];
  private buffer = "";
  private charset: Charset = Charset.Big5;
  private decoder: TextDecoder;
  private closed = false;
  private waiters: Array<() => void> = [];

  constructor() {
    this.decoder = new TextDecoder(Charset.Big5, { fatal: false, ignoreBOM: true });
  }

  async connect(): Promise<void> {
    const resp = await fetch(PTT_WS_URL, {
      headers: { Upgrade: "websocket", Origin: PTT_ORIGIN },
    });
    if (resp.status !== 101 || !resp.webSocket) {
      throw new Error(`PTT WS handshake failed: status=${resp.status}`);
    }
    const ws = resp.webSocket;
    try {
      (ws as unknown as { binaryType: string }).binaryType = "arraybuffer";
    } catch {
      /* fall through to Blob branch */
    }
    ws.accept();
    ws.addEventListener("message", (e: MessageEvent) => this.onMessage(e.data));
    ws.addEventListener("close", () => {
      this.closed = true;
      this.notify();
    });
    ws.addEventListener("error", () => {
      this.closed = true;
      this.notify();
    });
    this.ws = ws;
  }

  private onMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      this.feed(new Uint8Array(data));
    } else if (typeof Blob !== "undefined" && data instanceof Blob) {
      const p = data.arrayBuffer().then((ab) => this.feed(new Uint8Array(ab)));
      this.chunks.push(p);
    } else if (typeof data === "string") {
      this.appendText(data);
    }
  }

  private feed(bytes: Uint8Array): void {
    const text = this.decoder.decode(bytes, { stream: true });
    this.appendText(text);
  }

  private appendText(text: string): void {
    this.buffer += stripAnsi(text);
    if (this.buffer.length > ROLLING_BUFFER_LIMIT) {
      this.buffer = this.buffer.slice(this.buffer.length - ROLLING_BUFFER_LIMIT);
    }
    this.notify();
  }

  private notify(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const cb of w) cb();
  }

  async drain(): Promise<void> {
    while (this.chunks.length > 0) {
      const pending = this.chunks;
      this.chunks = [];
      await Promise.allSettled(pending);
    }
  }

  switchCharset(cs: Charset): void {
    this.charset = cs;
    this.decoder = new TextDecoder(cs, { fatal: false, ignoreBOM: true });
  }

  send(text: string): void {
    if (!this.ws) throw new Error("socket not connected");
    const enc =
      this.charset === Charset.Utf8
        ? new TextEncoder().encode(text)
        : encodeAsciiBytes(text);
    this.ws.send(enc);
  }

  get screen(): string {
    return this.buffer;
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(code = 1000, reason = "done"): void {
    if (this.ws && !this.closed) {
      try {
        this.ws.close(code, reason);
      } catch {
        /* noop */
      }
    }
    this.closed = true;
  }

  async waitFor(
    predicate: (buf: string) => boolean,
    timeoutMs: number,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await this.drain();
      if (predicate(this.buffer)) return true;
      if (this.closed) return false;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 200);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    return false;
  }
}

// PTT username/password are ASCII; encode as raw bytes with no charset.
function encodeAsciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export class PttBot {
  private sock = new PttSocket();
  private loggedIn = false;

  async connect(): Promise<void> {
    await this.sock.connect();
    const ok = await this.sock.waitFor(
      (buf) =>
        buf.includes("請輸入") || buf.includes("代號") || buf.includes("guest"),
      10_000,
    );
    if (!ok) {
      throw new Error(
        `Did not see login prompt within 10s. Screen tail: ${this.sock.screen.slice(
          -300,
        )}`,
      );
    }
  }

  async login(
    username: string,
    password: string,
    kick = true,
  ): Promise<LoginResult> {
    const start = Date.now();
    if (this.loggedIn) {
      return { ok: false, reason: "already logged in", screen: "", elapsed_ms: 0 };
    }
    // Trailing comma triggers PTT's UTF-8 negotiation.
    this.sock.send(`${username},${KEY_ENTER}${password}${KEY_ENTER}`);

    const seen = { kick: false, tooOften: false, cleanup: false, anyKey: false };
    let charsetSwitched = false;
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      const buf = this.sock.screen;

      if (buf.includes("密碼不對或無此帳號")) {
        return failure("wrong_password", buf, start);
      }
      if (buf.includes("請稍後再試")) {
        return failure("server_busy", buf, start);
      }

      if (!charsetSwitched && buf.includes("登入中")) {
        this.sock.switchCharset(Charset.Utf8);
        charsetSwitched = true;
      }

      if (!seen.kick && buf.includes("您想刪除其他重複登入的連線嗎")) {
        this.sock.send(`${kick ? "y" : "n"}${KEY_ENTER}`);
        seen.kick = true;
      } else if (
        !seen.tooOften &&
        buf.includes("請勿頻繁登入以免造成系統過度負荷")
      ) {
        this.sock.send(KEY_ENTER);
        seen.tooOften = true;
      } else if (
        !seen.cleanup &&
        buf.includes("您要刪除以上錯誤嘗試的記錄嗎")
      ) {
        this.sock.send(`y${KEY_ENTER}`);
        seen.cleanup = true;
      } else if (!seen.anyKey && buf.includes("按任意鍵繼續")) {
        this.sock.send(KEY_ENTER);
        seen.anyKey = true;
      }

      if (buf.includes("我是") || buf.includes("主功能表")) {
        this.loggedIn = true;
        return {
          ok: true,
          screen: buf.slice(-2000),
          elapsed_ms: Date.now() - start,
        };
      }

      await new Promise((r) => setTimeout(r, 250));
      if (this.sock.isClosed()) {
        return failure("socket_closed", this.sock.screen, start);
      }
    }
    return failure("timeout", this.sock.screen, start);
  }

  dumpScreen(): string {
    return this.sock.screen;
  }

  async logout(): Promise<void> {
    if (!this.loggedIn) return;
    this.sock.send(`G${KEY_ENTER}Y${KEY_ENTER}`);
    await new Promise((r) => setTimeout(r, 800));
    this.sock.send(KEY_ENTER);
    this.loggedIn = false;
  }

  close(): void {
    this.sock.close();
  }
}

function failure(reason: string, screen: string, startedAt: number): LoginResult {
  return {
    ok: false,
    reason,
    screen: screen.slice(-2000),
    elapsed_ms: Date.now() - startedAt,
  };
}
