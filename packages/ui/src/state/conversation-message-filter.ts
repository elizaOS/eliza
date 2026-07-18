/**
 * Decides which conversation messages render in the transcript. Machine-only
 * action inventories stay available to diagnostics without becoming assistant
 * prose, while concise action results retain live-versus-restored parity.
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

function isInternalAssistantMessage(message: ConversationMessage): boolean {
  const text = message.text.trim();
  const isViewInventory = /^available_views:\s*(?:\n|$)/.test(text);
  if (!isViewInventory) return false;

  // VIEWS inventory callbacks are machine-readable planner context. Match the
  // complete callback fallback when metadata is present, while retaining the
  // structural envelope check for older rows that lack action metadata.
  if (message.actionCallbackHistory?.length) {
    return text === normalizeCallbackHistory(message.actionCallbackHistory);
  }
  return /^views\[\d+\]\{id,label,type,path,available\}:/m.test(text);
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
  if (message.attachments?.length) return true;
  if (message.blocks?.length) return true;
  if (isInternalAssistantMessage(message)) return false;
  return message.text.trim().length > 0;
}

export function filterRenderableConversationMessages(
  messages: ConversationMessage[],
): ConversationMessage[] {
  return messages.filter((message) => shouldKeepConversationMessage(message));
}
