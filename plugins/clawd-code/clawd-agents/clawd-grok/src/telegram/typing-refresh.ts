import type { Api } from "grammy";

/** Telegram clears typing after ~5s; refresh before that so the indicator stays visible. */
const TYPING_REFRESH_MS = 3500;

/** Repeats `sendChatAction(typing)` until `stop()` is called. No-op when `enabled` is false. */
export function startTypingRefresh(
  api: Api,
  chatId: number | string,
  messageThreadId: number | undefined,
  enabled: boolean,
): () => void {
  if (!enabled) return () => {};
  const tick = () => void api.sendChatAction(chatId, "typing", { message_thread_id: messageThreadId }).catch(() => {});
  tick();
  const id = setInterval(tick, TYPING_REFRESH_MS);
  return () => clearInterval(id);
}
