/**
 * Streaming-text primitive for the chat reducer.
 *
 * The chat pipeline only ever does eight things to an in-flight assistant
 * turn while a stream is alive:
 *
 *   - append a token (delta)        → mode: "append"
 *   - replace text from a snapshot  → mode: "replace"
 *   - apply final reconciled text   → mode: "complete"
 *   - bind a durable domain id      → mode: "rekey"
 *   - merge an inline tool-call step → mode: "tool"
 *   - stamp a server failureKind    → mode: "fail"
 *   - mark the turn as interrupted  → mode: "interrupt"
 *   - drop an empty assistant turn  → mode: "drop"
 *
 * This primitive is the single mutation path for all of them, so
 * `useChatSend.ts` and `useChatCallbacks.ts` share one equality check instead
 * of each hand-rolling `setMessages(prev => prev.map(...))`. The hot path:
 *
 *   - matches the target message by id,
 *   - checks the newest row first because the in-flight assistant turn lives at
 *     the transcript tail,
 *   - batches text and tool-event changes into one array copy,
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

type NonStructuralStreamingTextModification = Exclude<
  StreamingTextModification,
  { mode: "complete" | "rekey" | "drop" }
>;

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

function applyGeneralModification(
  prev: ConversationMessage[],
  mod: StreamingTextModification,
): ConversationMessage[] {
  if (mod.mode === "drop") {
    const filtered = prev.filter((message) => message.id !== mod.messageId);
    return filtered.length === prev.length ? prev : filtered;
  }

  let changed = false;
  let next = prev.map((message) => {
    if (message.id !== mod.messageId) return message;
    const patched = computeNextMessage(message, mod);
    if (patched === null) return message;
    changed = true;
    return patched;
  });
  // Terminal id reconciliation is deliberately a full pass: a proactive WS
  // echo may already carry the persisted id before the SSE done event arrives.
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
      changed = true;
    }
  }
  return changed ? next : prev;
}

function isNonStructuralModification(
  mod: StreamingTextModification,
): mod is NonStructuralStreamingTextModification {
  return mod.mode !== "complete" && mod.mode !== "rekey" && mod.mode !== "drop";
}

function findTargetMessageIndex(
  messages: ConversationMessage[],
  messageId: string,
): number {
  const tailIndex = messages.length - 1;
  if (tailIndex >= 0 && messages[tailIndex]?.id === messageId) {
    return tailIndex;
  }
  for (let index = tailIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.id === messageId) return index;
  }
  return -1;
}

/**
 * Reduce one or more streaming mutations into a message array.
 *
 * Text and tool events for one in-flight turn use a targeted tail-row update
 * and one array copy. Structural and terminal changes retain complete
 * duplicate-id reconciliation because they are rare and correctness-sensitive.
 */
export function applyStreamingTextModificationsToMessages(
  prev: ConversationMessage[],
  modifications: readonly StreamingTextModification[],
): ConversationMessage[] {
  if (modifications.length === 0) return prev;

  const messageId = modifications[0]?.messageId;
  const canUseTargetedPath =
    messageId !== undefined &&
    modifications.every(
      (modification) =>
        modification.messageId === messageId &&
        isNonStructuralModification(modification),
    );

  if (!canUseTargetedPath) {
    return modifications.reduce(applyGeneralModification, prev);
  }

  const targetIndex = findTargetMessageIndex(prev, messageId);
  if (targetIndex < 0) return prev;
  let target = prev[targetIndex];
  if (!target) return prev;
  let changed = false;
  for (const modification of modifications) {
    const patched = computeNextMessage(target, modification);
    if (patched === null) continue;
    target = patched;
    changed = true;
  }
  if (!changed) return prev;

  const next = prev.slice();
  next[targetIndex] = target;
  return next;
}

/** Apply multiple streaming mutations through one state update. */
export function applyStreamingTextModifications(
  setMessages: StreamingTextSetter,
  modifications: readonly StreamingTextModification[],
): void {
  if (modifications.length === 0) return;
  setMessages((prev: ConversationMessage[]) =>
    applyStreamingTextModificationsToMessages(prev, modifications),
  );
}

/**
 * Apply one streaming-text modification to the chat-message reducer.
 *
 * Referential equality is preserved when the target is missing or the
 * modification is idempotent.
 */
export function applyStreamingTextModification(
  setMessages: StreamingTextSetter,
  mod: StreamingTextModification,
): void {
  applyStreamingTextModifications(setMessages, [mod]);
}
