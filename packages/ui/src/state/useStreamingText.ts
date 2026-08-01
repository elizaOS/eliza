/**
 * Streaming-text primitive for the chat reducer.
 *
 * The chat pipeline only ever does nine things to an in-flight assistant
 * turn while a stream is alive:
 *
 *   - append a token (delta)        → mode: "append"
 *   - replace text from a snapshot  → mode: "replace"
 *   - apply final reconciled text   → mode: "complete"
 *   - bind a durable domain id      → mode: "rekey"
 *   - merge a buffered paint        → mode: "buffered"
 *   - merge an inline tool-call step → mode: "tool"
 *   - stamp a server failureKind    → mode: "fail"
 *   - mark the turn as interrupted  → mode: "interrupt"
 *   - drop an empty assistant turn  → mode: "drop"
 *
 * This primitive is the single targeted update for all of them, so
 * `useChatSend.ts` and `useChatCallbacks.ts` share one equality check instead
 * of each hand-rolling transcript-wide map passes. The update:
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
import type {
  AccountConnectRequest,
  ChatFailureKind,
  ChatToolCallEvent,
  ConversationMessage,
} from "../api";
import { mergeChatToolEvent } from "../components/tool-events/chat-tool-events";
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
      /**
       * Optional structured "connect another account" request to stamp on the
       * completed turn so the renderer can swap in the AccountConnectBlock.
       */
      accountConnect?: AccountConnectRequest;
      /** Optional agent reasoning/thought to stamp on the completed turn. */
      reasoning?: string;
      /** Persisted server id replacing the optimistic temp-resp-* stream id. */
      persistedMessageId?: string;
    }
  | {
      messageId: string;
      mode: "rekey";
      /** Durable server id replacing an optimistic client id. */
      persistedMessageId: string;
    }
  | {
      messageId: string;
      mode: "buffered";
      /** Latest cumulative snapshot, or `null` when only tools are pending. */
      fullText: string | null;
      /** Ordered tool lifecycle steps received since the previous paint. */
      toolEvents: readonly ChatToolCallEvent[];
    }
  | {
      messageId: string;
      mode: "tool";
      /** One inline tool-call lifecycle step (call → result/error). Merged onto
       *  the turn's `toolEvents` by `callId`; text is left untouched. */
      event: ChatToolCallEvent;
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
      const sameAccountConnect = message.accountConnect === mod.accountConnect;
      const sameReasoning =
        mod.reasoning === undefined || message.reasoning === mod.reasoning;
      const sameId =
        mod.persistedMessageId === undefined ||
        message.id === mod.persistedMessageId;
      if (
        sameText &&
        sameFailure &&
        sameAccountConnect &&
        sameReasoning &&
        sameId
      ) {
        return null;
      }
      const next: ConversationMessage = {
        ...message,
        ...(mod.persistedMessageId ? { id: mod.persistedMessageId } : {}),
        text: mod.fullText,
      };
      if (mod.failureKind) {
        next.failureKind = mod.failureKind;
      } else if (message.failureKind !== undefined) {
        delete next.failureKind;
      }
      if (mod.accountConnect) {
        next.accountConnect = mod.accountConnect;
      } else if (message.accountConnect !== undefined) {
        delete next.accountConnect;
      }
      if (mod.reasoning) {
        next.reasoning = mod.reasoning;
      }
      return next;
    }
    case "rekey": {
      if (message.id === mod.persistedMessageId) return null;
      return { ...message, id: mod.persistedMessageId };
    }
    case "buffered": {
      const textChanged =
        mod.fullText !== null && mod.fullText !== message.text;
      const currentEvents = message.toolEvents ?? [];
      let nextEvents = currentEvents;
      for (const event of mod.toolEvents) {
        nextEvents = mergeChatToolEvent(nextEvents, event);
      }
      const toolsChanged = nextEvents !== currentEvents;
      if (!textChanged && !toolsChanged) return null;
      return {
        ...message,
        ...(textChanged ? { text: mod.fullText ?? message.text } : {}),
        ...(toolsChanged ? { toolEvents: nextEvents } : {}),
      };
    }
    case "tool": {
      const nextEvents = mergeChatToolEvent(
        message.toolEvents ?? [],
        mod.event,
      );
      if (nextEvents === message.toolEvents) return null;
      return { ...message, toolEvents: nextEvents };
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
      const index = prev.findIndex((message) => message.id === mod.messageId);
      if (index === -1) return prev;
      return [...prev.slice(0, index), ...prev.slice(index + 1)];
    }

    const index = prev.findIndex((message) => message.id === mod.messageId);
    if (index === -1) return prev;
    const patched = computeNextMessage(prev[index], mod);
    if (patched === null) return prev;
    let next = prev.slice();
    next[index] = patched;
    // Id-swap dedupe: when terminal reconciliation rebinds a temp bubble to the
    // persisted server id, a proactive-message WS echo carrying that same
    // persisted id may have ALREADY appended its own bubble (action-callback
    // turns persist + broadcast mid-turn, before the SSE `done` arrives). Keep
    // only the FIRST occurrence — the swapped streamed bubble at the thread
    // position the user watched (echoes append after it) — and drop the copy.
    if (
      (mod.mode === "complete" || mod.mode === "rekey") &&
      mod.persistedMessageId !== mod.messageId
    ) {
      let seen = false;
      const deduped = next.filter((message) => {
        if (message.id !== mod.persistedMessageId) return true;
        if (seen) return false;
        seen = true;
        return true;
      });
      if (deduped.length !== next.length) {
        next = deduped;
      }
    }
    return next;
  });
}
