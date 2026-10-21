// Thin Telegram Bot API wrapper. Throws on non-2xx so the caller can decide
// whether a notify failure should fail the whole sign-in run.

const API_BASE = "https://api.telegram.org";

export async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
  topicId?: string,
): Promise<void> {
  const resp = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      // Forum topic in a supergroup; omitted → the chat's General topic.
      ...(topicId ? { message_thread_id: Number(topicId) } : {}),
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    // A hung request would otherwise stall every later account in the loop.
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Telegram sendMessage ${resp.status}: ${body.slice(0, 300)}`);
  }
}
