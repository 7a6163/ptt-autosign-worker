// Minimal PTT client for Cloudflare Workers.
// Scope: connect → login → dump screen → logout.
//
// Charset note: PTT speaks Big5 before login and UTF-8 after a successful
// login negotiation (triggered by the trailing comma we send with the
// username). Rather than detect the boundary and flip a single decoder, we
// run BOTH decoders in parallel against the raw byte stream and concat the
// stripped buffers when looking for prompt markers. This mirrors the dual-
// decode approach in kevinptt0323/ptt-client/src/sites/ptt/bot.ts:94-101 and
// removes a class of timing bugs around the charset switch.

const PTT_WS_URL = "https://ws.ptt.cc/bbs/";
const PTT_ORIGIN = "https://term.ptt.cc";

const KEY_ENTER = "\r";
const ANSI_RE = /\x1b\[[\??!>]?[0-9;]*[@A-Za-z`]|\x1b[\(\)][AB012]|\x07/g;
const HTTP_NOISE_RE = /^HTTP\/1\.\d \d+ [^\r\n]*\r?\n\r?\n/;
const ROLLING_BUFFER_LIMIT = 32 * 1024;
// PTT post-login banner: `歡迎您再度拜訪，上次您是從 <IP> 連往本站。`
// First-time logins print `歡迎您第一次拜訪本站` and intentionally don't match.
// Char class covers IPv4, IPv6, and IPv4-mapped IPv6; length-bounded to avoid
// eating CJK if PTT changes the trailing phrase.
const LAST_LOGIN_IP_RE =
  /歡迎您再度拜訪[，,]\s*上次您是從\s+([0-9A-Fa-f:.]{2,45})\s+連往本站/;

export type LoginResult =
  | { ok: true; screen: string; elapsed_ms: number; lastLoginIp: string | null }
  | { ok: false; reason: string; screen: string; elapsed_ms: number };

export type UserInfo = {
  loginCount: number | null;
  mailStatus: string | null;
  rawScreen: string;
};

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "").replace(HTTP_NOISE_RE, "");
}

function appendStripped(buf: string, text: string): string {
  let next = buf + stripAnsi(text);
  if (next.length > ROLLING_BUFFER_LIMIT) {
    next = next.slice(next.length - ROLLING_BUFFER_LIMIT);
  }
  return next;
}

// PTT sees ASCII-only username/password and the few control sequences we
// send after login (G, Y, \r). UTF-8 is a strict superset for those bytes,
// so a TextEncoder would also work; this stays explicit to avoid charset
// confusion if anyone passes Chinese into send() later.
function encodeAsciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

class PttSocket {
  private ws: WebSocket | null = null;
  private chunks: Promise<void>[] = [];
  private big5Decoder = new TextDecoder("big5", {
    fatal: false,
    ignoreBOM: true,
  });
  private utf8Decoder = new TextDecoder("utf-8", {
    fatal: false,
    ignoreBOM: true,
  });
  private big5Buffer = "";
  private utf8Buffer = "";
  private closed = false;
  private waiters: Array<() => void> = [];

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
      // String frames are rare; treat as already-decoded UTF-8 text.
      this.utf8Buffer = appendStripped(this.utf8Buffer, data);
      this.notify();
    }
  }

  private feed(bytes: Uint8Array): void {
    this.big5Buffer = appendStripped(
      this.big5Buffer,
      this.big5Decoder.decode(bytes, { stream: true }),
    );
    this.utf8Buffer = appendStripped(
      this.utf8Buffer,
      this.utf8Decoder.decode(bytes, { stream: true }),
    );
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

  send(text: string): void {
    if (!this.ws) throw new Error("socket not connected");
    this.ws.send(encodeAsciiBytes(text));
  }

  /** Substring-match candidate: union of both decoded views. */
  get screen(): string {
    return this.big5Buffer + "\n" + this.utf8Buffer;
  }

  get big5View(): string {
    return this.big5Buffer;
  }

  get utf8View(): string {
    return this.utf8Buffer;
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
      if (predicate(this.screen)) return true;
      if (this.closed) return false;
      // Race-safe wait: register the waiter BEFORE re-checking the
      // predicate. If a frame arrived in the gap between the outer
      // predicate() call and this push, the re-check inside the executor
      // catches it and wakes immediately. The 200ms watchdog remains as a
      // safety net in case notify() is ever bypassed.
      await new Promise<void>((resolve) => {
        let woken = false;
        const wake = () => {
          if (woken) return;
          woken = true;
          resolve();
        };
        this.waiters.push(wake);
        if (predicate(this.screen)) wake();
        setTimeout(wake, 200);
      });
    }
    return false;
  }
}

export class PttBot {
  private sock = new PttSocket();
  private loggedIn = false;

  async connect(): Promise<void> {
    await this.sock.connect();
    const ok = await this.sock.waitFor(
      (buf) =>
        buf.includes("請輸入") ||
        buf.includes("代號") ||
        buf.includes("guest"),
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
      return {
        ok: false,
        reason: "already logged in",
        screen: "",
        elapsed_ms: 0,
      };
    }
    // Trailing comma triggers PTT's UTF-8 mode for post-login output.
    this.sock.send(`${username},${KEY_ENTER}${password}${KEY_ENTER}`);

    const seen = { kick: false, tooOften: false, cleanup: false, anyKey: false };
    // 15s budget keeps the per-account worst-case under the Cloudflare Free
    // plan's 30s scheduled-handler wall-clock. PTT login normally completes
    // in 2–7s; padding above that is just dead clock.
    const deadline = Date.now() + 15_000;

    while (Date.now() < deadline) {
      const buf = this.sock.screen;

      if (buf.includes("密碼不對或無此帳號")) {
        return failure("wrong_password", buf, start);
      }
      if (buf.includes("請稍後再試")) {
        return failure("server_busy", buf, start);
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

      // Use the most specific marker only. PTT writes `我是XXXXX` to the
      // bottom status bar mid-stream during login, so a bare `我是` check
      // can fire before the main menu finishes rendering.
      if (buf.includes("【主功能表】")) {
        this.loggedIn = true;
        // Drain pending Blob frames before regex so the welcome banner
        // (printed just before 主功能表) is fully decoded into utf8View.
        await this.sock.drain();
        const lastLoginIp = this.extractLastLoginIp();
        // Return the UTF-8 view since the post-login screen is UTF-8.
        return {
          ok: true,
          screen: this.sock.utf8View.slice(-2000),
          elapsed_ms: Date.now() - start,
          lastLoginIp,
        };
      }

      await new Promise((r) => setTimeout(r, 250));
      if (this.sock.isClosed()) {
        return failure("socket_closed", buf, start);
      }
    }
    return failure("timeout", this.sock.screen, start);
  }

  /** Returns both Big5 and UTF-8 decoded views, separated by a marker. */
  dumpScreen(): string {
    return (
      "[BIG5]\n" + this.sock.big5View + "\n[UTF-8]\n" + this.sock.utf8View
    );
  }

  /**
   * Best-effort user-info query: T → Q → targetId → parse → escape back.
   * Returns null fields when the regex fails so sign-in reporting can degrade
   * gracefully. PyPtt-equivalent: ptt.get_user(target_id).
   */
  async getUser(targetId: string): Promise<UserInfo> {
    const empty: UserInfo = {
      loginCount: null,
      mailStatus: null,
      rawScreen: "",
    };
    if (!this.loggedIn) return empty;

    // Navigate: main menu → talk menu.
    this.sock.send(`T${KEY_ENTER}`);
    const talkOk = await this.sock.waitFor(
      (b) => b.includes("查詢網友") || b.includes("(Q)") || b.includes("休閒聊天"),
      2_000,
    );
    if (!talkOk) return empty;

    // Talk menu → user query.
    this.sock.send(`Q${KEY_ENTER}`);
    const queryPromptOk = await this.sock.waitFor(
      // Don't fall back to bare `代號` — the rolling buffer still holds the
      // initial login prompt `請輸入代號…`, which would match instantly.
      (b) => b.includes("請輸入使用者代號"),
      2_000,
    );
    if (!queryPromptOk) {
      await this.escapeToMain();
      return empty;
    }

    // Submit target id and let the info screen render.
    this.sock.send(`${targetId}${KEY_ENTER}`);
    await new Promise((r) => setTimeout(r, 800));

    const buf = this.sock.utf8View;
    const loginMatch = buf.match(/登入次數》\s*(\d+)/);
    const mailMatch = buf.match(/信箱[^》]*》\s*([^\r\n《]+?)\s{2,}/);

    const info: UserInfo = {
      loginCount: loginMatch ? parseInt(loginMatch[1], 10) : null,
      mailStatus: mailMatch ? mailMatch[1].trim() : null,
      rawScreen: buf.slice(-1500),
    };

    await this.escapeToMain();
    return info;
  }

  /**
   * Extract the last-login IP from the post-login welcome banner. Returns
   * null on first-time logins or when PTT changes the wording.
   */
  private extractLastLoginIp(): string | null {
    const m = this.sock.utf8View.match(LAST_LOGIN_IP_RE);
    return m ? m[1] : null;
  }

  /**
   * Best-effort: send ArrowLeft (←) until we see the main menu marker.
   * Avoid `q` here — on the main menu, `q` initiates a logout dialog, which
   * would race with the explicit logout() call afterward.
   */
  private async escapeToMain(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      if (this.sock.screen.includes("【主功能表】")) return;
      this.sock.send("\x1B[D"); // ANSI: cursor left = "back" in PTT menus
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async logout(): Promise<void> {
    if (!this.loggedIn) return;
    this.sock.send(`G${KEY_ENTER}Y${KEY_ENTER}`);
    await new Promise((r) => setTimeout(r, 500));
    this.sock.send(KEY_ENTER);
    this.loggedIn = false;
  }

  close(): void {
    this.sock.close();
  }
}

function failure(
  reason: string,
  screen: string,
  startedAt: number,
): LoginResult {
  return {
    ok: false,
    reason,
    screen: screen.slice(-2000),
    elapsed_ms: Date.now() - startedAt,
  };
}
