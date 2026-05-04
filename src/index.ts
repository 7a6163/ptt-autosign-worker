// Entrypoints:
//   scheduled() — invoked by Cron Trigger; runs sign-in for every account in PTT_ACCOUNTS.
//   GET /run?secret=<RUN_TOKEN> — manual cron-equivalent trigger for testing.
//   GET /spike — Phase 0 connectivity probe (no login).

import { PttBot } from "./ptt";
import type { UserInfo } from "./ptt";
import { sendTelegram } from "./telegram";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  PTT_ACCOUNTS: string; // JSON: [{"id":"alice","password":"..."}, ...]
  RUN_TOKEN: string; // gate for /run
}

const PTT_WS_URL = "https://ws.ptt.cc/bbs/";
const PTT_ORIGIN = "https://term.ptt.cc";
const CAPTURE_MS = 5000;
const INTER_ACCOUNT_DELAY_MS = 2000;

type SignInResult = {
  id: string;
  ok: boolean;
  reason?: string;
  loginCount: number | null;
  mailStatus: string | null;
  elapsed_ms: number;
};

type SpikeReport = {
  url: string;
  origin: string;
  handshake: { status: number; subprotocol: string | null } | null;
  frameCount: number;
  totalBytes: number;
  firstFrameHex: string;
  decoded: string;
  error: string | null;
  elapsed_ms: number;
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/spike") {
      return json(await runSpike());
    }

    if (url.pathname === "/run") {
      const secret = url.searchParams.get("secret") ?? "";
      if (!env.RUN_TOKEN || secret !== env.RUN_TOKEN) {
        return new Response("forbidden", { status: 403 });
      }
      return json(await runDailySignIn(env));
    }

    return new Response(
      "Routes:\n  GET /spike\n  GET /run?secret=\n",
      { status: 404 },
    );
  },

  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runDailySignIn(env).then((r) => {
      console.log("daily sign-in summary:", JSON.stringify(r));
    }));
  },
} satisfies ExportedHandler<Env>;

// ---------- daily sign-in ----------

async function runDailySignIn(env: Env): Promise<{
  accounts: SignInResult[];
  errors: string[];
}> {
  const accounts = parseAccounts(env.PTT_ACCOUNTS);
  const errors: string[] = [];
  const results: SignInResult[] = [];

  if (accounts.length === 0) {
    errors.push("PTT_ACCOUNTS is empty or malformed");
    return { accounts: [], errors };
  }

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const result = await signInOne(acc.id, acc.password);
    results.push(result);
    console.log(
      `[${acc.id}] ok=${result.ok} reason=${result.reason ?? "-"} elapsed=${result.elapsed_ms}ms`,
    );

    try {
      await sendTelegram(
        env.TELEGRAM_BOT_TOKEN,
        env.TELEGRAM_CHAT_ID,
        formatMessage(result),
      );
    } catch (e) {
      const msg = `telegram send failed for ${acc.id}: ${(e as Error).message}`;
      console.warn(msg);
      errors.push(msg);
    }

    if (i < accounts.length - 1) {
      await new Promise((r) => setTimeout(r, INTER_ACCOUNT_DELAY_MS));
    }
  }

  return { accounts: results, errors };
}

async function signInOne(id: string, password: string): Promise<SignInResult> {
  const bot = new PttBot();
  try {
    await bot.connect();
    const login = await bot.login(id, password, true);
    if (!login.ok) {
      return {
        id,
        ok: false,
        reason: login.reason,
        loginCount: null,
        mailStatus: null,
        elapsed_ms: login.elapsed_ms,
      };
    }

    let info: UserInfo = { loginCount: null, mailStatus: null, rawScreen: "" };
    try {
      info = await bot.getUser(id);
    } catch (e) {
      console.warn(`getUser failed for ${id}: ${(e as Error).message}`);
    }

    try {
      await bot.logout();
    } catch (e) {
      console.warn(`logout failed for ${id}: ${(e as Error).message}`);
    }

    return {
      id,
      ok: true,
      loginCount: info.loginCount,
      mailStatus: info.mailStatus,
      elapsed_ms: login.elapsed_ms,
    };
  } catch (e) {
    return {
      id,
      ok: false,
      reason: `exception: ${(e as Error).message}`,
      loginCount: null,
      mailStatus: null,
      elapsed_ms: 0,
    };
  } finally {
    bot.close();
  }
}

function formatMessage(r: SignInResult): string {
  const date = new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
  if (r.ok) {
    let msg = `✅ PTT ${htmlEscape(r.id)} 已成功簽到\n`;
    if (r.loginCount !== null) msg += `📆 已登入 ${r.loginCount} 天\n`;
    if (r.mailStatus) msg += `📫 ${htmlEscape(r.mailStatus)}\n`;
    msg += `#ptt #${date}`;
    return msg;
  }
  return `❌ PTT ${htmlEscape(r.id)} 簽到失敗\n原因：${htmlEscape(r.reason ?? "unknown")}\n#ptt #${date}`;
}

function parseAccounts(raw: string | undefined): Array<{ id: string; password: string }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is { id: string; password: string } =>
        a && typeof a.id === "string" && typeof a.password === "string" && a.id.length > 0,
    );
  } catch {
    return [];
  }
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ---------- dev probes ----------

async function runSpike(): Promise<SpikeReport> {
  const start = Date.now();
  const report: SpikeReport = {
    url: PTT_WS_URL,
    origin: PTT_ORIGIN,
    handshake: null,
    frameCount: 0,
    totalBytes: 0,
    firstFrameHex: "",
    decoded: "",
    error: null,
    elapsed_ms: 0,
  };

  try {
    const resp = await fetch(PTT_WS_URL, {
      headers: { Upgrade: "websocket", Origin: PTT_ORIGIN },
    });

    report.handshake = {
      status: resp.status,
      subprotocol: resp.headers.get("sec-websocket-protocol"),
    };

    if (resp.status !== 101 || !resp.webSocket) {
      const body = await resp.text().catch(() => "");
      report.error = `Handshake failed: status=${resp.status}; body=${body.slice(0, 400)}`;
      report.elapsed_ms = Date.now() - start;
      return report;
    }

    const ws = resp.webSocket;
    try {
      (ws as unknown as { binaryType: string }).binaryType = "arraybuffer";
    } catch {
      /* fall through to Blob branch */
    }
    ws.accept();

    const frames: Uint8Array[] = [];
    const pending: Promise<void>[] = [];
    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      ws.addEventListener("message", (e: MessageEvent) => {
        const data = e.data;
        if (data instanceof ArrayBuffer) {
          const buf = new Uint8Array(data);
          frames.push(buf);
          report.frameCount++;
          report.totalBytes += buf.byteLength;
        } else if (typeof Blob !== "undefined" && data instanceof Blob) {
          pending.push(
            (async () => {
              const buf = new Uint8Array(await data.arrayBuffer());
              frames.push(buf);
              report.frameCount++;
              report.totalBytes += buf.byteLength;
            })(),
          );
        } else if (typeof data === "string") {
          const buf = new TextEncoder().encode(data);
          frames.push(buf);
          report.frameCount++;
          report.totalBytes += buf.byteLength;
        } else {
          report.error = `unexpected frame type: ${Object.prototype.toString.call(data)}`;
        }
      });
      ws.addEventListener("close", finish);
      ws.addEventListener("error", finish);
      setTimeout(() => {
        try {
          ws.close(1000, "spike done");
        } catch {
          /* noop */
        }
        finish();
      }, CAPTURE_MS);
    });

    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }

    if (frames.length > 0) {
      const first = frames[0];
      const slice = first.slice(0, 256);
      report.firstFrameHex = Array.from(slice)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");

      const all = new Uint8Array(report.totalBytes);
      let off = 0;
      for (const f of frames) {
        all.set(f, off);
        off += f.byteLength;
      }
      try {
        report.decoded = new TextDecoder("big5", { fatal: false, ignoreBOM: true })
          .decode(all)
          .slice(0, 1200);
      } catch (e) {
        report.decoded = `[big5 decode error: ${(e as Error).message}]`;
      }
    }
  } catch (e) {
    const err = e as Error;
    report.error = `${err.name}: ${err.message}`;
  }

  report.elapsed_ms = Date.now() - start;
  return report;
}
