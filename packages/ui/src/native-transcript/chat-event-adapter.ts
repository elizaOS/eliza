/**
 * Structural adapter from live chat SSE callbacks to native transcript events.
 * It preserves stable message/tool ids and terminal phases while treating all
 * text and serialized tool detail as display payload only.
 */

import { isRetryableChatFailureKind } from "@elizaos/shared/contracts";
import type {
  ChatFailureKind,
  ChatTerminalFailure,
  ChatToolCallEvent,
} from "../api";
import { publishNativeTranscriptEvent } from "./transport";

/** Whether retry can plausibly resolve a structured chat failure as-is. */
export function isNativeChatFailureRetryable(
  failureKind: ChatFailureKind,
  terminalFailure?: ChatTerminalFailure,
): boolean {
  return terminalFailure
    ? terminalFailure.transient
    : isRetryableChatFailureKind(failureKind);
}

function toolDetail(event: ChatToolCallEvent): string | undefined {
  if (event.phase === "error") return event.error;
  if (event.phase === "result" && event.result !== undefined) {
    return JSON.stringify(event.result);
  }
  if (event.phase === "call" && event.args !== undefined) {
    return JSON.stringify(event.args);
  }
  return undefined;
}

export function publishNativeAgentText(options: {
  messageId: string;
  turnId?: string;
  text: string;
  final: boolean;
}): void {
  publishNativeTranscriptEvent({
    type: "agent.text",
    messageId: options.messageId,
    text: options.text,
    final: options.final,
    ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
  });
}

export function publishNativeToolState(
  event: ChatToolCallEvent,
  turnId?: string,
): void {
  const detail = toolDetail(event);
  publishNativeTranscriptEvent({
    type: "tool.state",
    callId: event.callId,
    name: event.toolName,
    phase:
      event.phase === "call"
        ? "started"
        : event.phase === "result"
          ? "succeeded"
          : "failed",
    ...(detail === undefined ? {} : { detail }),
    ...(turnId === undefined ? {} : { turnId }),
  });
}

export interface NativeChatTranscriptTurnPublisher {
  publishUserFinal(text: string, at: number): void;
  publishAgentText(text: string, final?: boolean): void;
  publishToolState(event: ChatToolCallEvent): void;
  publishFailureKind(
    failureKind: ChatFailureKind,
    message?: string,
    terminalFailure?: ChatTerminalFailure,
  ): void;
  publishError(options: {
    code: string;
    retryable: boolean;
    message?: string;
  }): void;
  publishCancel(reason: string): void;
  publishTerminal(options: {
    text: string;
    streamedText: string;
    completed?: boolean;
    failureKind?: ChatFailureKind;
    terminalFailure?: ChatTerminalFailure;
    accountConnect?: unknown;
  }): void;
}

/**
 * One logical VOICE_DM turn publisher shared by primary and replay transports.
 * Stable turn/message ids make replay snapshots replace the same rows, while
 * local terminal dedupe prevents repeated error/cancel rows.
 */
export function createNativeChatTranscriptTurnPublisher(options: {
  enabled: boolean;
  turnId: string;
  messageId: string;
}): NativeChatTranscriptTurnPublisher {
  let userPublished = false;
  let lastAgentText = "";
  let agentFinal = false;
  let cancelled = false;
  let terminalPublished = false;
  const publishedErrorCodes = new Set<string>();

  const publishUserFinal = (text: string, at: number): void => {
    if (!options.enabled || userPublished) return;
    userPublished = true;
    publishNativeTranscriptEvent({
      type: "stt.final",
      turnId: options.turnId,
      text,
      at,
    });
  };

  const publishAgentSnapshot = (text: string, final = false): void => {
    if (!options.enabled || !text) return;
    if (agentFinal) return;
    if (text === lastAgentText && final === agentFinal) return;
    lastAgentText = text;
    agentFinal = final;
    publishNativeAgentText({
      messageId: options.messageId,
      turnId: options.turnId,
      text,
      final,
    });
  };

  const publishError = (error: {
    code: string;
    retryable: boolean;
    message?: string;
  }): void => {
    if (
      !options.enabled ||
      terminalPublished ||
      publishedErrorCodes.has(error.code)
    )
      return;
    publishedErrorCodes.add(error.code);
    publishNativeTranscriptEvent({
      type: "error",
      code: error.code,
      retryable: error.retryable,
      ...(error.message ? { message: error.message } : {}),
    });
  };

  const publishFailureKind = (
    failureKind: ChatFailureKind,
    message?: string,
    terminalFailure?: ChatTerminalFailure,
  ): void => {
    publishError({
      code: terminalFailure?.code ?? failureKind,
      retryable: isNativeChatFailureRetryable(failureKind, terminalFailure),
      ...(terminalFailure?.message
        ? { message: terminalFailure.message }
        : message
          ? { message }
          : {}),
    });
  };

  const publishCancel = (reason: string): void => {
    if (!options.enabled || terminalPublished || cancelled) return;
    cancelled = true;
    publishNativeTranscriptEvent({
      type: "cancel",
      scope: "turn",
      turnId: options.turnId,
      reason,
    });
  };

  return {
    publishUserFinal,
    publishAgentText: publishAgentSnapshot,
    publishToolState(event) {
      if (!options.enabled) return;
      publishNativeToolState(event, options.turnId);
    },
    publishFailureKind,
    publishError,
    publishCancel,
    publishTerminal(result) {
      if (terminalPublished) return;
      publishAgentSnapshot(
        result.text || result.streamedText,
        result.completed !== false,
      );
      if (result.failureKind) {
        publishFailureKind(
          result.failureKind,
          undefined,
          result.terminalFailure,
        );
      } else if (result.accountConnect) {
        publishError({
          code: "account-connect-required",
          retryable: false,
          message: "Connect an account before retrying this turn.",
        });
      }
      if (result.completed === false) publishCancel("generation-incomplete");
      terminalPublished = true;
    },
  };
}
