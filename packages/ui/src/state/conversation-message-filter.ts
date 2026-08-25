/**
 * Decides which conversation messages render in the consumer transcript while
 * retaining internal action output in transport and diagnostic state.
 */
import type { ConversationMessage } from "../api";

function normalizeCallbackHistory(history: readonly string[]): string {
  const normalized: string[] = [];
  for (const entry of history) {
    const text = entry.trim();
    if (!text || normalized.at(-1) === text) continue;
    normalized.push(text);
  }
  return normalized.join("\n");
}

function isLegacyViewsInventory(message: ConversationMessage): boolean {
  const text = message.text.trim();
  if (!/^available_views:\s*(?:\n|$)/.test(text)) return false;

  // Existing authenticated devices may restore rows written before the
  // structural visibility field existed. Keep this matcher deliberately
  // limited to the complete VIEWS inventory envelope; generic callback text
  // may be a valid assistant reply and must remain visible.
  if (message.actionCallbackHistory?.length) {
    return text === normalizeCallbackHistory(message.actionCallbackHistory);
  }
  return (
    /^views\[\d+\]\{id,label,type,path,available\}:/m.test(text) ||
    /^\s*count:\s*0\s*$/m.test(text)
  );
}

/**
 * Whether a message should appear in the rendered transcript. User turns always
 * render; an assistant turn renders when it has visible text, structured
 * blocks, or media attachments — image-only generated replies carry empty text
 * but a populated `attachments` array.
 */
export function shouldKeepConversationMessage(
  message: ConversationMessage,
): boolean {
  if (message.role !== "assistant") return true;
  if (message.transcriptVisibility === "internal") return false;
  if (message.attachments?.length) return true;
  if (message.blocks?.length) return true;
  if (isLegacyViewsInventory(message)) return false;
  // A zero-token interrupted receipt carries no text but is the turn's durable
  // terminal state; hiding it would leave its user turn visually unanswered.
  if (message.interrupted === true) return true;
  return message.text.trim().length > 0;
}

export function filterRenderableConversationMessages(
  messages: ConversationMessage[],
): ConversationMessage[] {
  return messages.filter((message) => shouldKeepConversationMessage(message));
}
