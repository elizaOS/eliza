/**
 * Decides which conversation messages render in the transcript: user turns
 * always show; assistant turns show only with visible text, structured blocks,
 * or media (image-only replies carry empty text but populated attachments).
 * Also collapses back-to-back duplicate assistant turns (same text, near-same
 * timestamp) so a backend double-persist never paints twice.
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
  if (message.text.trim().length > 0) return true;
  if (message.attachments?.length) return true;
  return Boolean(message.blocks?.length);
}

/**
 * Two adjacent assistant turns within this window and with identical text are
 * treated as one double-persisted reply. 2s is far below any real "the agent
 * said the same thing twice on purpose" gap and comfortably above the write
 * jitter of the duplicate-persist class (the double-message QA report,
 * 2026-07-22).
 */
export const ASSISTANT_DUPLICATE_WINDOW_MS = 2_000;

function isPlainTextAssistantTurn(message: ConversationMessage): boolean {
  return (
    message.role === "assistant" &&
    message.text.trim().length > 0 &&
    !message.attachments?.length &&
    !message.blocks?.length
  );
}

/**
 * Render-side guard against the backend double-persist class: the same
 * assistant reply stored twice within milliseconds shows up as two identical
 * consecutive bubbles. This collapses the later copy when two ADJACENT
 * assistant turns carry identical text and land within
 * `ASSISTANT_DUPLICATE_WINDOW_MS` of each other.
 *
 * Defense-in-depth only — the persist bug is fixed server-side in its own
 * lane; this keeps a not-yet-deployed or regressed backend from ever painting
 * the duplicate. Deliberately narrow so it can never eat a real reply:
 * plain-text turns only (attachments/blocks always render), adjacency required
 * (any turn in between means real conversation flow), and an intentional
 * repeat ("say that again") arrives seconds later, outside the window.
 */
export function dedupeDoubledAssistantMessages(
  messages: ConversationMessage[],
): ConversationMessage[] {
  if (messages.length < 2) return messages;
  let changed = false;
  const next: ConversationMessage[] = [];
  for (const message of messages) {
    const prev = next[next.length - 1];
    if (
      prev &&
      isPlainTextAssistantTurn(prev) &&
      isPlainTextAssistantTurn(message) &&
      prev.id !== message.id &&
      prev.text.trim() === message.text.trim() &&
      Math.abs(message.timestamp - prev.timestamp) <
        ASSISTANT_DUPLICATE_WINDOW_MS
    ) {
      changed = true;
      continue;
    }
    next.push(message);
  }
  return changed ? next : messages;
}

export function filterRenderableConversationMessages(
  messages: ConversationMessage[],
): ConversationMessage[] {
  return dedupeDoubledAssistantMessages(
    messages.filter((message) => shouldKeepConversationMessage(message)),
  );
}
