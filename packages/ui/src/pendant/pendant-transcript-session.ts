/**
 * Reducer and browser persistence for a local pendant transcript session.
 *
 * The session is intentionally UI-local in Phase 1: it stores VAD/ASR segments,
 * pending placeholders, resolved text, dropped turns, and local word timings
 * across refresh without adding durable transcript records.
 */

import type {
  PendantAsrWord,
  PendantTranscriptSegmentDetail,
} from "./transcript-segment-event";

export const PENDANT_TRANSCRIPT_STORAGE_KEY =
  "eliza:pendant-transcript-session:v1";
export const MAX_PERSISTED_PENDANT_TRANSCRIPT_SEGMENTS = 500;

export interface PendantTranscriptSegment {
  id: string;
  status: "pending" | "resolved" | "dropped";
  text: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  words: PendantAsrWord[];
}

export interface PendantTranscriptSessionState {
  segments: PendantTranscriptSegment[];
  updatedAt: number | null;
  clearedThrough: number | null;
}

export type PendantTranscriptSessionAction =
  | { type: "segment"; detail: PendantTranscriptSegmentDetail }
  | { type: "clear"; at: number };

export const EMPTY_PENDANT_TRANSCRIPT_SESSION: PendantTranscriptSessionState = {
  segments: [],
  updatedAt: null,
  clearedThrough: null,
};

function segmentFromDetail(
  detail: PendantTranscriptSegmentDetail,
): PendantTranscriptSegment {
  return {
    id: detail.id,
    status: detail.status,
    text: detail.text?.trim() ?? "",
    startedAt: detail.startedAt,
    endedAt: detail.endedAt,
    durationMs: detail.durationMs,
    words: detail.words ?? [],
  };
}

export function pendantTranscriptSessionReducer(
  state: PendantTranscriptSessionState,
  action: PendantTranscriptSessionAction,
): PendantTranscriptSessionState {
  if (action.type === "clear") {
    return {
      segments: [],
      updatedAt: action.at,
      clearedThrough: action.at,
    };
  }
  if (
    state.clearedThrough !== null &&
    action.detail.endedAt <= state.clearedThrough
  ) {
    return state;
  }
  const nextSegment = segmentFromDetail(action.detail);
  const existingIndex = state.segments.findIndex(
    (segment) => segment.id === nextSegment.id,
  );
  const segments =
    existingIndex >= 0
      ? state.segments.map((segment, index) =>
          index === existingIndex ? { ...segment, ...nextSegment } : segment,
        )
      : [...state.segments, nextSegment];
  return {
    segments,
    updatedAt: action.detail.endedAt,
    clearedThrough: state.clearedThrough,
  };
}

function isSegment(value: unknown): value is PendantTranscriptSegment {
  if (!value || typeof value !== "object") return false;
  const segment = value as Partial<PendantTranscriptSegment>;
  return (
    typeof segment.id === "string" &&
    (segment.status === "pending" ||
      segment.status === "resolved" ||
      segment.status === "dropped") &&
    typeof segment.text === "string" &&
    typeof segment.startedAt === "number" &&
    typeof segment.endedAt === "number" &&
    typeof segment.durationMs === "number" &&
    Array.isArray(segment.words)
  );
}

export function parsePendantTranscriptSession(
  value: unknown,
): PendantTranscriptSessionState {
  if (!value || typeof value !== "object") {
    return EMPTY_PENDANT_TRANSCRIPT_SESSION;
  }
  const state = value as Partial<PendantTranscriptSessionState>;
  if (!Array.isArray(state.segments)) {
    return EMPTY_PENDANT_TRANSCRIPT_SESSION;
  }
  const segments = state.segments.filter(isSegment);
  return {
    segments: segments.slice(-MAX_PERSISTED_PENDANT_TRANSCRIPT_SEGMENTS),
    updatedAt: typeof state.updatedAt === "number" ? state.updatedAt : null,
    clearedThrough:
      typeof state.clearedThrough === "number" ? state.clearedThrough : null,
  };
}

export function loadPendantTranscriptSession(
  storage?: Pick<Storage, "getItem">,
): PendantTranscriptSessionState {
  if (!storage && typeof window !== "undefined") {
    try {
      storage = window.localStorage;
    } catch {
      return EMPTY_PENDANT_TRANSCRIPT_SESSION;
    }
  }
  if (!storage) return EMPTY_PENDANT_TRANSCRIPT_SESSION;
  try {
    const raw = storage.getItem(PENDANT_TRANSCRIPT_STORAGE_KEY);
    if (!raw) return EMPTY_PENDANT_TRANSCRIPT_SESSION;
    return parsePendantTranscriptSession(JSON.parse(raw));
  } catch {
    return EMPTY_PENDANT_TRANSCRIPT_SESSION;
  }
}

export function savePendantTranscriptSession(
  state: PendantTranscriptSessionState,
  storage:
    | Pick<Storage, "setItem" | "removeItem">
    | undefined = typeof window === "undefined"
    ? undefined
    : window.localStorage,
): void {
  if (!storage) return;
  if (state.segments.length === 0) {
    try {
      storage.removeItem(PENDANT_TRANSCRIPT_STORAGE_KEY);
    } catch {
      return;
    }
    return;
  }
  const persistedState: PendantTranscriptSessionState = {
    ...state,
    segments: state.segments.slice(-MAX_PERSISTED_PENDANT_TRANSCRIPT_SEGMENTS),
  };
  try {
    storage.setItem(
      PENDANT_TRANSCRIPT_STORAGE_KEY,
      JSON.stringify(persistedState),
    );
  } catch {
    return;
  }
}
