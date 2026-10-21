import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { formatMessage, parseAccounts } from "../src/index";
import type { Env, SignInResult } from "../src/index";

const env: Env = {
  TELEGRAM_BOT_TOKEN: "bot",
  TELEGRAM_CHAT_ID: "1",
  PTT_ACCOUNTS: "[]",
  RUN_TOKEN: "t0k",
};
function call(path: string, init: RequestInit = {}, e: Env = env) {
  return worker.fetch(new Request(`https://w.test${path}`, init), e);
}

describe("routes", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["unknown path", "/x", {}, env, 404],
    ["no token", "/run", { method: "POST" }, env, 403],
    [
      "wrong token",
      "/run",
      { method: "POST", headers: { authorization: "Bearer nope" } },
      env,
      403,
    ],
    ["token in query string", "/run?secret=t0k", { method: "POST" }, env, 403],
    [
      "RUN_TOKEN unset",
      "/run",
      { method: "POST", headers: { authorization: "Bearer " } },
      { ...env, RUN_TOKEN: "" },
      403,
    ],
    ["GET /run", "/run", { headers: { authorization: "Bearer t0k" } }, env, 405],
  ] as const)("%s → %i", async (_name, path, init, e, status) => {
    expect((await call(path, init, e)).status).toBe(status);
  });

  it("alerts Telegram when PTT_ACCOUNTS is malformed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    const res = await call(
      "/run",
      { method: "POST", headers: { authorization: "Bearer t0k" } },
      {
        ...env,
        PTT_ACCOUNTS: "not json",
      },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      accounts: [],
      errors: ["PTT_ACCOUNTS is empty or malformed"],
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botbot/sendMessage");
    const body = JSON.parse(init!.body as string);
    expect(body.text).toContain("簽到未執行");
    expect(body).not.toHaveProperty("message_thread_id");
  });

  it("posts into the Telegram topic when TELEGRAM_TOPIC_ID is set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    await call(
      "/run",
      { method: "POST", headers: { authorization: "Bearer t0k" } },
      {
        ...env,
        PTT_ACCOUNTS: "not json",
        TELEGRAM_TOPIC_ID: "42",
      },
    );

    expect(JSON.parse(fetchSpy.mock.calls[0][1]!.body as string).message_thread_id).toBe(42);
  });
});

describe("parseAccounts", () => {
  it("keeps only well-formed accounts", () => {
    expect(
      parseAccounts('[{"id":"a","password":"p"},{"id":"","password":"x"},{"id":1},null]'),
    ).toEqual([{ id: "a", password: "p" }]);
  });

  it.each([undefined, "", "not json", '{"id":"a","password":"p"}'])("returns [] for %j", (raw) => {
    expect(parseAccounts(raw)).toEqual([]);
  });
});

describe("formatMessage", () => {
  const base: SignInResult = {
    id: "alice",
    ok: true,
    loginCount: 1234,
    mailStatus: "最近無新信件",
    lastLoginIp: "1.2.3.4",
    elapsed_ms: 1,
  };

  it("formats a full success", () => {
    expect(formatMessage(base)).toMatch(
      /^✅ PTT alice 已成功簽到\n📆 已登入 1234 天\n📫 最近無新信件\n🌐 上次登入來源 1\.2\.3\.4\n#ptt #\d{8}$/,
    );
  });

  it("omits lines for missing fields", () => {
    expect(
      formatMessage({ ...base, loginCount: null, mailStatus: null, lastLoginIp: null }),
    ).toMatch(/^✅ PTT alice 已成功簽到\n#ptt #\d{8}$/);
  });

  it("HTML-escapes PTT-derived text on failure", () => {
    expect(formatMessage({ ...base, id: "<b>", ok: false, reason: "a&b" })).toMatch(
      /^❌ PTT &lt;b&gt; 簽到失敗\n原因：a&amp;b\n#ptt #\d{8}$/,
    );
  });
});
