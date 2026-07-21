/**
 * Structural adapter from live chat SSE callbacks to native transcript events.
 * It preserves stable message/tool ids and terminal phases while treating all
 * text and serialized tool detail as display payload only.
 */

import type { ChatToolCallEvent } from "../api";
import { publishNativeTranscriptEvent } from "./transport";

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
