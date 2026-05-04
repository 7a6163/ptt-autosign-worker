// Phase 0 spike — answer one question:
//   "Does Cloudflare Workers' egress complete a WebSocket handshake to ws.ptt.cc?"
//
// No login. No credentials. Just open the WS, capture the BBS welcome banner
// (the first few seconds of frames), Big5-decode it, and return a JSON report.
//
// Deploy:   npx wrangler deploy
// Test:     curl https://ptt-autosign-worker.<your-subdomain>.workers.dev/spike
//   or:     npm run dev   then   curl http://localhost:8787/spike

const PTT_WS_URL = "https://ws.ptt.cc/bbs/";
const PTT_ORIGIN = "https://term.ptt.cc";
const CAPTURE_MS = 5000;

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
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/spike") {
      return new Response(
        "GET /spike — opens a WebSocket to ws.ptt.cc and reports the handshake + first frames",
        { status: 404 },
      );
    }
    const report = await runSpike();
    return new Response(JSON.stringify(report, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },
} satisfies ExportedHandler;

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
      headers: {
        Upgrade: "websocket",
        Origin: PTT_ORIGIN,
      },
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
    // Prefer ArrayBuffer over Blob so the message handler stays sync.
    // Workers may ignore this on some compat dates; we fall back to Blob below.
    try {
      (ws as unknown as { binaryType: string }).binaryType = "arraybuffer";
    } catch {
      /* runtime doesn't support setter — handle Blob in listener */
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

    // Drain any in-flight Blob -> ArrayBuffer reads before snapshotting.
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
        report.decoded = new TextDecoder("big5", { fatal: false })
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
