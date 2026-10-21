import { describe, expect, it } from "vitest";
import { PttBot, PttSocket } from "../src/ptt";

// A scripted PTT: `respond` sees each keystroke batch the bot sends and
// replies through `send`, like the real server would over the socket.
function fakePtt(respond: (input: string) => void) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.addEventListener("message", async (e) => {
    const d = e.data as string | ArrayBuffer | Blob; // binary arrives as Blob on this end
    respond(
      typeof d === "string"
        ? d
        : new TextDecoder().decode(d instanceof Blob ? await d.arrayBuffer() : d),
    );
  });
  const sock = new PttSocket();
  sock.attach(client);
  return {
    bot: new PttBot(sock),
    send: (text: string) => server.send(new TextEncoder().encode(text)),
    hangUp: () => server.close(1000, "bye"),
  };
}

describe("PttBot.login", () => {
  it("answers a repeated any-key prompt and keeps the banner IP", async () => {
    let enters = 0;
    const { bot, send } = fakePtt((input) => {
      if (input.startsWith("alice,")) {
        send("歡迎您再度拜訪，上次您是從 1.2.3.4 連往本站。\r\n按任意鍵繼續");
      } else if (input === "\r") {
        send(++enters === 1 ? "按任意鍵繼續" : "\x1b[1;37m【主功能表】\x1b[m");
      }
    });

    const r = await bot.login("alice", "pw");

    expect(r).toMatchObject({ ok: true, lastLoginIp: "1.2.3.4" });
    expect(enters).toBe(2);
  });

  it("answers a prompt once even when PTT is slow to move on", async () => {
    const replies: string[] = [];
    const { bot, send } = fakePtt((input) => {
      if (input.startsWith("alice,")) return send("您想刪除其他重複登入的連線嗎？[Y/n]");
      replies.push(input);
      setTimeout(() => send("【主功能表】"), 700);
    });

    expect(await bot.login("alice", "pw")).toMatchObject({ ok: true });
    expect(replies).toEqual(["y\r"]);
  });

  it("returns a null IP on a first-time login", async () => {
    const { bot, send } = fakePtt((input) => {
      if (input.startsWith("alice,")) send("歡迎您第一次拜訪本站\r\n【主功能表】");
    });

    expect(await bot.login("alice", "pw")).toMatchObject({ ok: true, lastLoginIp: null });
  });

  it("reports wrong_password even when PTT hangs up right after", async () => {
    const { bot, send, hangUp } = fakePtt(() => {
      send("密碼不對或無此帳號");
      hangUp();
    });

    expect(await bot.login("alice", "pw")).toMatchObject({ ok: false, reason: "wrong_password" });
  });

  it("reports socket_closed when PTT hangs up silently", async () => {
    const { bot, hangUp } = fakePtt(() => hangUp());

    expect(await bot.login("alice", "pw")).toMatchObject({ ok: false, reason: "socket_closed" });
  });
});

describe("PttBot.getUser", () => {
  it("reads user info, then backs out to the main menu", async () => {
    let lefts = 0;
    const { bot, send } = fakePtt((input) => {
      if (input.startsWith("alice,")) send("【主功能表】");
      else if (input === "T\r") send("【休閒聊天】 (Q)uery 查詢網友");
      else if (input === "Q\r") send("請輸入使用者代號：");
      else if (input === "alice\r")
        send("《登入次數》\x1b[1m1234\x1b[m 次  《信箱狀況》最近無新信件  ");
      else if (input === "\x1b[D") send(++lefts === 1 ? "【休閒聊天】" : "【主功能表】");
    });
    await bot.login("alice", "pw");

    const info = await bot.getUser("alice");

    expect(info).toEqual({ loginCount: 1234, mailStatus: "最近無新信件" });
    // Old bug: the login screen's 【主功能表】 made escapeToMain() return without a key.
    expect(lefts).toBe(2);
  });
});
