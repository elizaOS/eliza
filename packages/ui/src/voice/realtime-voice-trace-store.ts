/**
 * Bounded local persistence for completed normal-chat realtime voice traces.
 *
 * The shared trace schema is content-free and runtime-validated. Persisting the
 * last few completed traces lets a local/browser QA session survive a reload
 * without sending transcripts, audio, credentials, or device identifiers.
 */

import {
  inspectRealtimeVoiceTraceCoverage,
  parseRealtimeVoiceTrace,
  type RealtimeVoiceTrace,
} from "@elizaos/shared";
import type { CompletedNormalVoiceTrace } from "./realtime-voice-trace-collector";

export const NORMAL_VOICE_TRACE_STORAGE_KEY =
  "eliza:voice:completed-realtime-traces:v1";
export const NORMAL_VOICE_TRACE_STORAGE_LIMIT = 50;

interface VoiceTraceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): VoiceTraceStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readValidatedTraces(storage: VoiceTraceStorage): RealtimeVoiceTrace[] {
  let raw: unknown;
  try {
    const serialized = storage.getItem(NORMAL_VOICE_TRACE_STORAGE_KEY);
    if (!serialized) return [];
    raw = JSON.parse(serialized);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => parseRealtimeVoiceTrace(value))
    .filter((trace): trace is RealtimeVoiceTrace => trace !== null)
    .slice(-NORMAL_VOICE_TRACE_STORAGE_LIMIT);
}

export function readPersistedNormalVoiceTraces(
  storage: VoiceTraceStorage | null = browserStorage(),
): CompletedNormalVoiceTrace[] {
  if (!storage) return [];
  return readValidatedTraces(storage).map((trace) => ({
    trace,
    coverage: inspectRealtimeVoiceTraceCoverage(trace),
  }));
}

export function persistCompletedNormalVoiceTrace(
  completed: CompletedNormalVoiceTrace,
  storage: VoiceTraceStorage | null = browserStorage(),
): boolean {
  if (!storage) return false;
  const trace = parseRealtimeVoiceTrace(completed.trace);
  if (!trace) return false;
  try {
    const traces = readValidatedTraces(storage).filter(
      (candidate) =>
        candidate.sessionId !== trace.sessionId ||
        candidate.turnId !== trace.turnId,
    );
    traces.push(trace);
    storage.setItem(
      NORMAL_VOICE_TRACE_STORAGE_KEY,
      JSON.stringify(traces.slice(-NORMAL_VOICE_TRACE_STORAGE_LIMIT)),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearPersistedNormalVoiceTraces(
  storage: VoiceTraceStorage | null = browserStorage(),
): void {
  try {
    storage?.removeItem(NORMAL_VOICE_TRACE_STORAGE_KEY);
  } catch {
    // Persistence is diagnostics-only and must never affect the voice loop.
  }
}
