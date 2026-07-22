/**
 * Decides which conversation messages render in the transcript. Machine-only
 * action inventories stay available to diagnostics without becoming assistant
 * prose, while concise action results retain live-versus-restored parity.
 */
import type { ConversationMessage } from "../api";

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
  return message.text.trim().length > 0;
}

export function filterRenderableConversationMessages(
  messages: ConversationMessage[],
): ConversationMessage[] {
  return messages.filter((message) => shouldKeepConversationMessage(message));
}
