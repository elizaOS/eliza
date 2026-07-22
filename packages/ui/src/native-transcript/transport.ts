/**
 * Renderer-side publisher for the native transcript event stream. Real voice
 * and chat producers append typed snapshots here; the app entrypoint forwards
 * the same versioned envelope to Capacitor or Electrobun native hosts.
 */

import {
  type AgentTextEvent,
  type CancelEvent,
  NATIVE_TRANSCRIPT_SCHEMA,
  type ReconnectEvent,
  type SttFinalEvent,
  type SttPartialEvent,
  type ToolStateEvent,
  type TranscriptErrorEvent,
  type TranscriptEvent,
  type TranscriptEventStream,
  type TtsAudioEvent,
} from "./contract";
import {
  applyRendererTranscriptEvents,
  resetNativeTranscriptStoreForTests,
} from "./live-store";

export const NATIVE_TRANSCRIPT_RENDERER_EVENT =
  "eliza:native-transcript:event-stream" as const;

export type NativeTranscriptEventInput =
  | Omit<SttPartialEvent, "seq">
  | Omit<SttFinalEvent, "seq">
  | Omit<AgentTextEvent, "seq">
  | Omit<ToolStateEvent, "seq">
  | Omit<TtsAudioEvent, "seq">
  | Omit<CancelEvent, "seq">
  | Omit<TranscriptErrorEvent, "seq">
  | Omit<ReconnectEvent, "seq">;

let nextSequence = 1;

function assignSequence(input: NativeTranscriptEventInput): TranscriptEvent {
  const seq = nextSequence++;
  switch (input.type) {
    case "stt.partial":
    case "stt.final":
    case "agent.text":
    case "tool.state":
    case "tts.audio":
    case "cancel":
    case "error":
    case "reconnect":
      return { ...input, seq };
  }
}

/** Append typed snapshots and notify the active platform adapter in one frame. */
export function publishNativeTranscriptEvents(
  inputs: readonly NativeTranscriptEventInput[],
): TranscriptEventStream {
  const stream: TranscriptEventStream = {
    schema: NATIVE_TRANSCRIPT_SCHEMA,
    events: inputs.map(assignSequence),
  };
  applyRendererTranscriptEvents(stream.events);
  if (typeof window !== "undefined" && stream.events.length > 0) {
    window.dispatchEvent(
      new CustomEvent<TranscriptEventStream>(NATIVE_TRANSCRIPT_RENDERER_EVENT, {
        detail: stream,
      }),
    );
  }
  return stream;
}

/** Append one typed transcript snapshot. */
export function publishNativeTranscriptEvent(
  input: NativeTranscriptEventInput,
): TranscriptEvent {
  return publishNativeTranscriptEvents([input]).events[0];
}

/** Test-only reset for deterministic stream sequence assertions. */
export function resetNativeTranscriptSequenceForTests(): void {
  nextSequence = 1;
  resetNativeTranscriptStoreForTests();
}
