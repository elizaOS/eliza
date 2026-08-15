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
import { shellLocalStorage } from "../surface-realm-channel";
import type { CompletedNormalVoiceTrace } from "./realtime-voice-trace-collector";

export const NORMAL_VOICE_TRACE_STORAGE_KEY =
  "eliza:voice:completed-realtime-traces:v1";
export const NORMAL_VOICE_TRACE_STORAGE_LIMIT = 50;
export const NORMAL_VOICE_TRACE_EXPORT_FILENAME = "eliza-voice-traces.json";

export interface NormalVoiceTraceExport {
  readonly schemaVersion: 1;
  readonly source: "normal-chat-realtime-voice";
  readonly traceCount: number;
  readonly traces: readonly RealtimeVoiceTrace[];
}

export type NormalVoiceTracePersistenceFailure =
  | "storage_unavailable"
  | "invalid_trace"
  | "storage_write_failed";

export type NormalVoiceTracePersistenceResult =
  | { readonly saved: true; readonly failure: null }
  | {
      readonly saved: false;
      readonly failure: NormalVoiceTracePersistenceFailure;
    };

interface VoiceTraceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): VoiceTraceStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => shellLocalStorage.setItem(key, value),
      removeItem: (key) => shellLocalStorage.removeItem(key),
    };
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
  return persistCompletedNormalVoiceTraceDetailed(completed, storage).saved;
}

export function persistCompletedNormalVoiceTraceDetailed(
  completed: CompletedNormalVoiceTrace,
  storage: VoiceTraceStorage | null = browserStorage(),
): NormalVoiceTracePersistenceResult {
  if (!storage) return { saved: false, failure: "storage_unavailable" };
  const trace = parseRealtimeVoiceTrace(completed.trace);
  if (!trace) return { saved: false, failure: "invalid_trace" };
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
    return { saved: true, failure: null };
  } catch {
    return { saved: false, failure: "storage_write_failed" };
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

/**
 * Serialize only runtime-validated, content-free traces for local QA export.
 *
 * No wall-clock export timestamp is added: the artifact stays deterministic,
 * and the strict trace schema remains the sole data boundary.
 */
export function serializePersistedNormalVoiceTraces(
  storage: VoiceTraceStorage | null = browserStorage(),
): string {
  const traces = storage ? readValidatedTraces(storage) : [];
  const artifact: NormalVoiceTraceExport = {
    schemaVersion: 1,
    source: "normal-chat-realtime-voice",
    traceCount: traces.length,
    traces,
  };
  return JSON.stringify(artifact, null, 2);
}
