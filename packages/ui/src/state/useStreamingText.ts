/**
 * Streaming-text primitive for the chat reducer.
 *
 * The chat pipeline only ever does six things to an in-flight assistant
 * turn while a stream is alive:
 *
 *   - append a token (delta)        → mode: "append"
 *   - replace text from a snapshot  → mode: "replace"
 *   - apply final reconciled text   → mode: "complete"
 *   - stamp a server failureKind    → mode: "fail"
 *   - mark the turn as interrupted  → mode: "interrupt"
 *   - drop an empty assistant turn  → mode: "drop"
 *
 * Every one of those used to be a hand-rolled `setMessages(prev => prev.map(...))`
 * with subtly different equality checks scattered across `useChatSend.ts`
 * and `useChatCallbacks.ts`. This primitive collapses them into a single
 * map pass that:
 *
 *   - matches the target message by id,
 *   - returns the previous array unchanged when the modification produces
 *     no observable delta (referential equality preserved → no re-render),
 *   - supports the same updater-fn semantics as React's `setState`.
 *
 * It deliberately does nothing structural (no inserts, no reorders) — those
 * stay as direct `setConversationMessages` calls.
 */

import type { Dispatch, SetStateAction } from "react";
import type { ChatFailureKind, ConversationMessage } from "../api";
import { mergeStreamingText } from "./parsers";

export type StreamingTextSetter = Dispatch<
  SetStateAction<ConversationMessage[]>
>;

/**
 * One streaming-text mutation against a single in-flight assistant turn.
 *
 * `messageId` always identifies the assistant turn being modified. All other
 * fields are mode-specific.
 */
export type StreamingTextModification =
  | {
      messageId: string;
      mode: "append";
      /** Raw delta token from the SSE stream. */
      token: string;
    }
  | {
      messageId: string;
      mode: "replace";
      /** Cumulative snapshot text from the SSE stream. */
      fullText: string;
    }
  | {
      messageId: string;
      mode: "complete";
      /** Final reconciled assistant text from the server. */
      fullText: string;
      /** Optional server-flagged failure class to stamp alongside the text. */
      failureKind?: ChatFailureKind;
    }
  | {
      messageId: string;
      mode: "fail";
      /** Server-flagged failure class. Text is left untouched. */
      failureKind: ChatFailureKind;
    }
  | {
      messageId: string;
      mode: "interrupt";
    }
  | {
      messageId: string;
      mode: "drop";
    };

/**
 * Compute the patched message for a single modification, or return `null`
 * if the modification produces no observable change.
 */
function computeNextMessage(
  message: ConversationMessage,
  mod: StreamingTextModification,
): ConversationMessage | null {
  switch (mod.mode) {
    case "append": {
      const nextText = mergeStreamingText(message.text, mod.token);
      if (nextText === message.text) return null;
      return { ...message, text: nextText };
    }
    case "replace": {
      if (mod.fullText === message.text) return null;
      return { ...message, text: mod.fullText };
    }
    case "complete": {
      const sameText = message.text === mod.fullText;
      const sameFailure = message.failureKind === mod.failureKind;
      if (sameText && sameFailure) return null;
      const next: ConversationMessage = { ...message, text: mod.fullText };
      if (mod.failureKind) {
        next.failureKind = mod.failureKind;
      } else if (message.failureKind !== undefined) {
        delete next.failureKind;
      }
      return next;
    }
    case "fail": {
      if (message.failureKind === mod.failureKind) return null;
      return { ...message, failureKind: mod.failureKind };
    }
    case "interrupt": {
      if (message.interrupted === true) return null;
      return { ...message, interrupted: true };
    }
    case "drop":
      // "drop" is a structural removal handled by the caller below — we
      // only get here if the message exists, in which case the array
      // changes by definition.
      return message;
  }
}

/**
 * Apply one streaming-text modification to the chat-message reducer.
 *
 * Returns referentially-equal `prev` when the modification is a no-op
 * (target id missing, text already matches, failureKind already set, etc.).
 */
export function applyStreamingTextModification(
  setMessages: StreamingTextSetter,
  mod: StreamingTextModification,
): void {
  setMessages((prev: ConversationMessage[]) => {
    if (mod.mode === "drop") {
      const filtered = prev.filter((message) => message.id !== mod.messageId);
      return filtered.length === prev.length ? prev : filtered;
    }

    let changed = false;
    const next = prev.map((message) => {
      if (message.id !== mod.messageId) return message;
      const patched = computeNextMessage(message, mod);
      if (patched === null) return message;
      changed = true;
      return patched;
    });
    return changed ? next : prev;
  });
}
