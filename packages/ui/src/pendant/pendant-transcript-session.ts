/**
 * Reducer and offline optimistic cache for a local pendant transcript view.
 *
 * This cache is not an authoritative session store and clearing it is not
 * server deletion. The adapter seam is intentionally shaped like the future
 * server-backed session source while defaulting to browser localStorage.
 */

import { ElizaError } from "@elizaos/core";
import type {
  PendantAsrWord,
  PendantTranscriptSegmentDetail,
} from "./transcript-segment-event";

export const PENDANT_TRANSCRIPT_STORAGE_KEY = "pendant:transcript-session:v1";
export const MAX_PERSISTED_PENDANT_TRANSCRIPT_SEGMENTS = 500;

export interface PendantTranscriptSegment {
  id: string;
  status: "pending" | "resolved" | "failed";
  text: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  words: PendantAsrWord[];
  warning: string | null;
}

type PersistedPendantTranscriptSegment = Omit<
  PendantTranscriptSegment,
  "status" | "warning"
> & {
  status: PendantTranscriptSegment["status"] | "dropped";
  warning?: string | null;
};

interface PersistedPendantTranscriptSessionShape {
  segments?: unknown;
  updatedAt?: unknown;
  clearedThrough?: unknown;
}

export interface PendantTranscriptSessionState {
  segments: PendantTranscriptSegment[];
  updatedAt: number | null;
  clearedThrough: number | null;
}

export type PendantTranscriptSessionAction =
  | { type: "segment"; detail: PendantTranscriptSegmentDetail }
  | { type: "clear"; at: number };

export type PendantTranscriptSessionListener = (
  state: PendantTranscriptSessionState,
) => void;

export interface PendantTranscriptSessionAdapter {
  readonly kind: "local-optimistic-cache" | "server-authoritative";
  load(): PendantTranscriptSessionState;
  save(state: PendantTranscriptSessionState): void;
  clear(at: number): PendantTranscriptSessionState;
  subscribe?(listener: PendantTranscriptSessionListener): () => void;
}

type PendantTranscriptStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

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
    status:
      detail.status === "resolved"
        ? "resolved"
        : detail.status === "failed"
          ? "failed"
          : "pending",
    text: detail.text?.trim() ?? "",
    startedAt: detail.startedAt,
    endedAt: detail.endedAt,
    durationMs: detail.durationMs,
    words: detail.words ?? [],
    warning: detail.warning ?? null,
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
  if (action.detail.status === "discarded") {
    return {
      segments: state.segments.filter(
        (segment) => segment.id !== action.detail.id,
      ),
      updatedAt: action.detail.endedAt,
      clearedThrough: state.clearedThrough,
    };
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

function isSegment(value: unknown): value is PersistedPendantTranscriptSegment {
  if (!value || typeof value !== "object") return false;
  const segment = value as Record<string, unknown>;
  return (
    typeof segment.id === "string" &&
    (segment.status === "pending" ||
      segment.status === "resolved" ||
      segment.status === "failed" ||
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
    throw new ElizaError(
      "Pendant transcript cache has an invalid root value.",
      {
        code: "PENDANT_TRANSCRIPT_CACHE_INVALID",
        context: { expected: "object" },
        severity: "ephemeral",
      },
    );
  }
  const state = value as PersistedPendantTranscriptSessionShape;
  if (!Array.isArray(state.segments)) {
    throw new ElizaError(
      "Pendant transcript cache is missing its segment collection.",
      {
        code: "PENDANT_TRANSCRIPT_CACHE_INVALID",
        context: { field: "segments" },
        severity: "ephemeral",
      },
    );
  }
  if (!state.segments.every(isSegment)) {
    throw new ElizaError(
      "Pendant transcript cache contains an invalid segment.",
      {
        code: "PENDANT_TRANSCRIPT_CACHE_INVALID",
        context: { field: "segments" },
        severity: "ephemeral",
      },
    );
  }
  const segments = state.segments.map((segment) => {
    const status = segment.status === "dropped" ? "failed" : segment.status;
    return {
      id: segment.id,
      status,
      text: segment.text,
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
      durationMs: segment.durationMs,
      words: segment.words,
      warning:
        typeof segment.warning === "string"
          ? segment.warning
          : segment.status === "dropped"
            ? "Could not transcribe this segment."
            : null,
    };
  });
  return {
    segments: segments.slice(-MAX_PERSISTED_PENDANT_TRANSCRIPT_SEGMENTS),
    updatedAt: typeof state.updatedAt === "number" ? state.updatedAt : null,
    clearedThrough:
      typeof state.clearedThrough === "number" ? state.clearedThrough : null,
  };
}

function resolveTranscriptStorage(
  storage?: PendantTranscriptStorage,
): PendantTranscriptStorage {
  if (storage) return storage;
  if (typeof window === "undefined") {
    throw new ElizaError(
      "Pendant transcript cache is unavailable outside a browser window.",
      {
        code: "PENDANT_TRANSCRIPT_STORAGE_UNAVAILABLE",
        severity: "ephemeral",
      },
    );
  }
  try {
    return window.localStorage;
  } catch (cause) {
    // error-policy:J2 Preserve the browser's storage denial as the causal error.
    throw new ElizaError("Pendant transcript cache is unavailable.", {
      code: "PENDANT_TRANSCRIPT_STORAGE_UNAVAILABLE",
      cause,
      severity: "ephemeral",
    });
  }
}

export function loadPendantTranscriptSession(
  storage?: PendantTranscriptStorage,
): PendantTranscriptSessionState {
  const resolvedStorage = resolveTranscriptStorage(storage);
  let raw: string | null;
  try {
    raw = resolvedStorage.getItem(PENDANT_TRANSCRIPT_STORAGE_KEY);
  } catch (cause) {
    // error-policy:J2 Keep storage access failures distinct from a valid empty cache.
    throw new ElizaError("Pendant transcript cache could not be read.", {
      code: "PENDANT_TRANSCRIPT_STORAGE_READ_FAILED",
      cause,
      severity: "ephemeral",
    });
  }
  if (!raw) return EMPTY_PENDANT_TRANSCRIPT_SESSION;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    // error-policy:J3 Malformed persisted JSON is an explicit invalid cache signal.
    throw new ElizaError("Pendant transcript cache contains malformed JSON.", {
      code: "PENDANT_TRANSCRIPT_CACHE_INVALID",
      cause,
      severity: "ephemeral",
    });
  }
  return parsePendantTranscriptSession(parsed);
}

export function savePendantTranscriptSession(
  state: PendantTranscriptSessionState,
  storage?: PendantTranscriptStorage,
): void {
  const resolvedStorage = resolveTranscriptStorage(storage);
  if (state.segments.length === 0) {
    try {
      resolvedStorage.removeItem(PENDANT_TRANSCRIPT_STORAGE_KEY);
    } catch (cause) {
      // error-policy:J2 Cache deletion failures must remain observable to the view.
      throw new ElizaError("Pendant transcript cache could not be cleared.", {
        code: "PENDANT_TRANSCRIPT_STORAGE_CLEAR_FAILED",
        cause,
        severity: "ephemeral",
      });
    }
    return;
  }
  const persistedState: PendantTranscriptSessionState = {
    ...state,
    segments: state.segments.slice(-MAX_PERSISTED_PENDANT_TRANSCRIPT_SEGMENTS),
  };
  try {
    resolvedStorage.setItem(
      PENDANT_TRANSCRIPT_STORAGE_KEY,
      JSON.stringify(persistedState),
    );
  } catch (cause) {
    // error-policy:J2 Cache write failures must remain observable to the view.
    throw new ElizaError("Pendant transcript cache could not be saved.", {
      code: "PENDANT_TRANSCRIPT_STORAGE_WRITE_FAILED",
      cause,
      severity: "ephemeral",
    });
  }
}

export function createLocalOptimisticPendantTranscriptSessionAdapter(
  storage?: PendantTranscriptStorage,
): PendantTranscriptSessionAdapter {
  const resolveStorage = () => resolveTranscriptStorage(storage);
  return {
    kind: "local-optimistic-cache",
    load: () => loadPendantTranscriptSession(resolveStorage()),
    save: (state) => savePendantTranscriptSession(state, resolveStorage()),
    clear: (at) => {
      const state = pendantTranscriptSessionReducer(
        EMPTY_PENDANT_TRANSCRIPT_SESSION,
        { type: "clear", at },
      );
      savePendantTranscriptSession(state, resolveStorage());
      return state;
    },
  };
}
