/**
 * Normal-chat adapter for the shared realtime voice trace contract.
 *
 * Wire frames intentionally carry no server timestamp. This collector stamps
 * every received milestone with the browser's monotonic clock, keeping all
 * latency arithmetic in one clock domain. Missing evidence stays missing.
 */

import {
  createRealtimeVoiceTrace,
  finalizeRealtimeVoiceTrace,
  inspectRealtimeVoiceTraceCoverage,
  markRealtimeVoiceTrace,
  type RealtimeVoiceTrace,
  type RealtimeVoiceTraceCoverage,
  type RealtimeVoiceTraceDimensionsInput,
  type RealtimeVoiceTraceMark,
  type RealtimeVoiceTraceOutcome,
  type RealtimeVoiceTraceProfile,
} from "@elizaos/shared";
import type { VoiceTraceMark } from "./voice-session-client";

export interface CompletedNormalVoiceTrace {
  trace: RealtimeVoiceTrace;
  coverage: RealtimeVoiceTraceCoverage;
}

export interface NormalVoiceTraceCollector {
  resetSession(sessionId: string): void;
  updateDimensions(dimensions: RealtimeVoiceTraceDimensionsInput): void;
  accept(mark: VoiceTraceMark): CompletedNormalVoiceTrace | null;
  clear(): void;
}

interface PendingTrace {
  createdAtMs: number;
  marks: Map<RealtimeVoiceTraceMark, number>;
  terminal: { outcome: string; atMs: number } | null;
}

const DIRECT_MARKS = new Set<RealtimeVoiceTraceMark>([
  "local_speech_detected",
  "local_playback_paused",
  "server_interrupt_ack",
  "acoustic_speech_ended",
  "stt_final",
  "turn_committed",
  "router_decided",
  "llm_requested",
  "speakable_text_ready",
  "tts_requested",
  "tts_first_byte",
  "first_audio_playout",
  "last_audio_playout",
]);

function terminalOutcome(name: string): string | null {
  if (name === "interrupted") return "interrupted";
  const match =
    /^turn_end\((spoken|displayed|no_response|error|stopped)\)$/.exec(name);
  return match?.[1] ?? null;
}

function profilesFor(
  outcome: string,
  marks: ReadonlyMap<RealtimeVoiceTraceMark, number>,
): readonly RealtimeVoiceTraceProfile[] {
  if (outcome === "interrupted") return ["interruption"];
  if (outcome === "spoken") return ["spoken_response"];
  if (marks.has("llm_requested")) return ["model_response"];
  return ["transcription"];
}

function normalizedOutcome(
  outcome: string,
): Exclude<RealtimeVoiceTraceOutcome, "open"> {
  if (outcome === "spoken") return "spoken";
  if (outcome === "interrupted") return "interrupted";
  if (outcome === "error") return "error";
  return "no_response";
}

function canonicalMark(name: string): RealtimeVoiceTraceMark | null {
  if (name === "llm_first_text") return "llm_first_useful_text";
  if (name === "playback_drained") return "last_audio_playout";
  return DIRECT_MARKS.has(name as RealtimeVoiceTraceMark)
    ? (name as RealtimeVoiceTraceMark)
    : null;
}

export function createNormalVoiceTraceCollector(
  onCompleted?: (completed: CompletedNormalVoiceTrace) => void,
): NormalVoiceTraceCollector {
  let sessionId = "unbound-local-session";
  let dimensions: RealtimeVoiceTraceDimensionsInput = {
    transport: "websocket",
  };
  const pending = new Map<string, PendingTrace>();

  return {
    resetSession(nextSessionId) {
      const normalized = nextSessionId.trim();
      if (!normalized) return;
      sessionId = normalized;
      pending.clear();
    },
    updateDimensions(next) {
      dimensions = { ...dimensions, ...next };
    },
    accept(mark) {
      if (!mark.traceId || !Number.isFinite(mark.atMs)) return null;
      const outcome = terminalOutcome(mark.name);
      let entry = pending.get(mark.traceId);
      if (!entry) {
        entry = { createdAtMs: mark.atMs, marks: new Map(), terminal: null };
        pending.set(mark.traceId, entry);
      }
      entry.createdAtMs = Math.min(entry.createdAtMs, mark.atMs);
      const canonical = canonicalMark(mark.name);
      if (canonical) {
        const previous = entry.marks.get(canonical);
        if (
          previous === undefined ||
          (canonical === "first_audio_playout" && mark.atMs < previous) ||
          (canonical === "last_audio_playout" && mark.atMs > previous)
        ) {
          entry.marks.set(canonical, mark.atMs);
        }
      }
      if (outcome) entry.terminal = { outcome, atMs: mark.atMs };
      const terminal = entry.terminal;
      if (!terminal) return null;
      // Server completion means no more provider bytes will be sent; it does
      // not mean the browser has audibly consumed its queued tail. A spoken
      // trace settles only when the exact sequenced playout drain arrives.
      if (
        terminal.outcome === "spoken" &&
        !entry.marks.has("last_audio_playout")
      ) {
        return null;
      }

      let trace = createRealtimeVoiceTrace({
        sessionId,
        turnId: mark.traceId,
        responseId: mark.traceId,
        atMs: entry.createdAtMs,
        dimensions,
        profiles: profilesFor(terminal.outcome, entry.marks),
      });
      for (const [name, atMs] of entry.marks) {
        trace = markRealtimeVoiceTrace(trace, name, atMs);
      }
      trace = finalizeRealtimeVoiceTrace(
        trace,
        normalizedOutcome(terminal.outcome),
        Math.max(terminal.atMs, mark.atMs),
      );
      pending.delete(mark.traceId);
      const completed = {
        trace,
        coverage: inspectRealtimeVoiceTraceCoverage(trace),
      };
      onCompleted?.(completed);
      return completed;
    },
    clear() {
      pending.clear();
    },
  };
}
