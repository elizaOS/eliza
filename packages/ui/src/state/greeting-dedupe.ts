/**
 * Single-greeting invariant for a conversation thread.
 *
 * A conversation may only ever carry ONE agent-greeting bubble. Two independent
 * seeding paths can each land a greeting for a fresh thread:
 *
 *  1. the inline greeting returned by `createConversation({ bootstrapGreeting })`,
 *     which SETS the thread to `[greeting]`, and
 *  2. the fallback `client.requestGreeting()` fetch (used when the inline
 *     greeting is absent — old server — or when the empty-thread auto-greet
 *     effect fires), which APPENDS a greeting.
 *
 * The server greeting is `pickRandom(postExamples)` when no persisted greeting
 * exists yet, so a race between the two paths (the fallback firing before the
 * inline greeting's server-side persist commits) can produce two greetings with
 * DIFFERENT text. A text-equality dedupe then lets both through and the thread
 * shows a duplicated "Hey, I'm …" bubble (the device-review defect).
 *
 * The invariant is therefore by SOURCE, not text: at most one assistant message
 * whose `source` is the greeting marker survives, and it's the FIRST one (the
 * earliest-seeded bubble wins so the visible greeting never swaps under the user
 * once painted). This is the single dedupe seam every greeting mutation routes
 * through.
 */
import { MESSAGE_SOURCE_AGENT_GREETING } from "@elizaos/core";
import type { ConversationMessage } from "../api";

/** Whether a message is an agent-greeting bubble. */
export function isAgentGreetingMessage(message: ConversationMessage): boolean {
  return (
    message.role === "assistant" &&
    message.source === MESSAGE_SOURCE_AGENT_GREETING
  );
}

/**
 * Collapse a message list to the single-greeting invariant: keep every
 * non-greeting message untouched and in order, and keep only the FIRST greeting
 * bubble (dropping any later duplicates regardless of text). Returns the SAME
 * array reference when it already satisfies the invariant, so it is safe to run
 * inside a state setter without forcing a spurious re-render.
 */
export function dedupeGreetings(
  messages: ConversationMessage[],
): ConversationMessage[] {
  let seenGreeting = false;
  let duplicateFound = false;
  for (const message of messages) {
    if (!isAgentGreetingMessage(message)) continue;
    if (seenGreeting) {
      duplicateFound = true;
      break;
    }
    seenGreeting = true;
  }
  if (!duplicateFound) return messages;

  let kept = false;
  return messages.filter((message) => {
    if (!isAgentGreetingMessage(message)) return true;
    if (kept) return false;
    kept = true;
    return true;
  });
}

/**
 * Append a greeting to a thread while preserving the single-greeting invariant:
 * if the thread already carries a greeting bubble, the incoming one is dropped
 * (the earliest greeting wins), so a fallback fetch that lands after an inline
 * greeting never double-seeds. Returns the same reference when nothing changes.
 */
export function appendGreetingOnce(
  messages: ConversationMessage[],
  greeting: ConversationMessage,
): ConversationMessage[] {
  if (messages.some(isAgentGreetingMessage)) return messages;
  return [...messages, greeting];
}
