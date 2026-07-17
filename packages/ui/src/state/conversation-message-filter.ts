/**
 * Decides which conversation messages render in the transcript. Internal-only
 * action callback memories stay available to diagnostics without becoming
 * assistant prose when the conversation is restored.
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

function isCallbackOnlyAssistantMessage(message: ConversationMessage): boolean {
  if (message.actionCallbackHistory?.length) {
    return (
      message.text.trim() ===
      normalizeCallbackHistory(message.actionCallbackHistory)
    );
  }

  // The VIEWS inventory is a machine-readable TOON table consumed by the
  // planner. Some persisted callback rows lack action metadata, so recognize
  // the complete envelope instead of exposing it as an assistant reply.
  return (
    /^available_views:\s*\n\s*type:\s*\S+/m.test(message.text) &&
    /^views\[\d+\]\{id,label,type,path,available\}:/m.test(message.text)
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
  if (message.attachments?.length) return true;
  if (message.blocks?.length) return true;
  if (isCallbackOnlyAssistantMessage(message)) return false;
  return message.text.trim().length > 0;
}

export function filterRenderableConversationMessages(
  messages: ConversationMessage[],
): ConversationMessage[] {
  return messages.filter((message) => shouldKeepConversationMessage(message));
}
