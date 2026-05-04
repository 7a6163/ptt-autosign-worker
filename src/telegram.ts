// Thin Telegram Bot API wrapper. Throws on non-2xx so the caller can decide
// whether a notify failure should fail the whole sign-in run.

const API_BASE = "https://api.telegram.org";

export async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  const resp = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `Telegram sendMessage ${resp.status}: ${body.slice(0, 300)}`,
    );
  }
}
