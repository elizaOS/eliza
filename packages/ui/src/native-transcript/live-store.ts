/**
 * Renderer-owned live transcript store for the shipped chat surface. Producers
 * fold typed events immediately for web, while Capacitor and Electrobun may
 * replace the snapshot with their independently reduced result after the bridge
 * round-trip. Equal-sequence disagreement is rejected as a conformance failure.
 */

import type { TranscriptEvent, TranscriptViewModel } from "./contract";
import {
  applyTranscriptEvent,
  initialReducerState,
  type TranscriptReducerState,
  toViewModel,
} from "./reduce";
import {
  decodeTranscriptViewModel,
  type TranscriptViewModelDecodeError,
} from "./view-model-decode";

export type NativeTranscriptViewSource = "web" | "ios" | "android" | "desktop";

export interface NativeTranscriptSnapshot {
  source: NativeTranscriptViewSource;
  view: TranscriptViewModel;
}

export type NativeTranscriptViewAcceptanceResult =
  | { ok: true; applied: boolean; snapshot: NativeTranscriptSnapshot }
  | { ok: false; error: TranscriptViewModelDecodeError };

const listeners = new Set<() => void>();
let rendererState: TranscriptReducerState = initialReducerState();
let snapshot: NativeTranscriptSnapshot = {
  source: "web",
  view: toViewModel(rendererState),
};

function emit(): void {
  for (const listener of listeners) listener();
}

function normalizedViewsMatch(
  left: TranscriptViewModel,
  right: TranscriptViewModel,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Fold producer events into the web projection before notifying native hosts. */
export function applyRendererTranscriptEvents(
  events: readonly TranscriptEvent[],
): NativeTranscriptSnapshot {
  for (const event of events) {
    rendererState = applyTranscriptEvent(rendererState, event);
  }
  snapshot = { source: "web", view: toViewModel(rendererState) };
  emit();
  return snapshot;
}

/**
 * Accept a native host projection only after runtime validation and parity with
 * the renderer fold at the same sequence. Older async replies are ignored.
 */
export function acceptNativeTranscriptViewModel(
  raw: unknown,
  source: Exclude<NativeTranscriptViewSource, "web">,
): NativeTranscriptViewAcceptanceResult {
  const decoded = decodeTranscriptViewModel(raw);
  if (!decoded.ok) return decoded;

  if (decoded.view.lastSeq < snapshot.view.lastSeq) {
    return { ok: true, applied: false, snapshot };
  }
  if (decoded.view.lastSeq > snapshot.view.lastSeq) {
    return {
      ok: false,
      error: {
        path: "view.lastSeq",
        message: `native ${source} reducer returned future seq ${decoded.view.lastSeq}; renderer is at ${snapshot.view.lastSeq}`,
      },
    };
  }
  if (!normalizedViewsMatch(decoded.view, snapshot.view)) {
    return {
      ok: false,
      error: {
        path: "view",
        message: `native ${source} reducer diverged at seq ${decoded.view.lastSeq}`,
      },
    };
  }

  snapshot = { source, view: decoded.view };
  emit();
  return { ok: true, applied: true, snapshot };
}

export function getNativeTranscriptSnapshot(): NativeTranscriptSnapshot {
  return snapshot;
}

export function subscribeNativeTranscript(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reset sequence-coupled store state for deterministic producer tests. */
export function resetNativeTranscriptStoreForTests(): void {
  rendererState = initialReducerState();
  snapshot = { source: "web", view: toViewModel(rendererState) };
  emit();
}
