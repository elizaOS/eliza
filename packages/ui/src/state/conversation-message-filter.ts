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
  if (message.text.trim().length > 0) return true;
  if (message.attachments?.length) return true;
  return Boolean(message.blocks?.length);
}

export function filterRenderableConversationMessages(
  messages: ConversationMessage[],
): ConversationMessage[] {
  return messages.filter((message) => shouldKeepConversationMessage(message));
}
