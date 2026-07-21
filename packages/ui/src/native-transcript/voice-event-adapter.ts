/**
 * Structural adapter from the real realtime-voice wire protocol to the shared
 * native transcript contract. Text is payload only; event type and trace ids
 * determine lifecycle, identity, and cancellation behavior.
 */

import type { ServerControlFrame } from "../voice/voice-session-protocol";
import type { NativeTranscriptEventInput } from "./transport";
import { publishNativeTranscriptEvent } from "./transport";

export function nativeTranscriptInputFromVoiceServerEvent(
  event: ServerControlFrame,
): NativeTranscriptEventInput | null {
  switch (event.t) {
    case "stt_partial":
      return {
        type: "stt.partial",
        turnId: event.traceId,
        text: event.text,
      };
    case "stt_final":
      return {
        type: "stt.final",
        turnId: event.traceId,
        text: event.text,
      };
    case "speaking_start":
      return {
        type: "tts.audio",
        utteranceId: event.traceId,
        phase: "started",
      };
    case "speaking_end":
      return {
        type: "tts.audio",
        utteranceId: event.traceId,
        phase: "ended",
      };
    case "interrupted":
      return {
        type: "cancel",
        scope: "turn",
        turnId: event.traceId,
        reason: event.reason,
      };
    case "error":
      return {
        type: "error",
        code: event.code,
        retryable: event.retryable,
        ...(event.message === undefined ? {} : { message: event.message }),
      };
    case "ready":
    case "stt_eager_eot":
    case "llm_first_text":
    case "usage":
      return null;
  }
}

/** Publish a real server control frame when it has transcript semantics. */
export function publishVoiceServerTranscriptEvent(
  event: ServerControlFrame,
): void {
  const input = nativeTranscriptInputFromVoiceServerEvent(event);
  if (input) publishNativeTranscriptEvent(input);
}
