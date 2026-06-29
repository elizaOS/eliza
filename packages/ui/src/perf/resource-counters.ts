/**
 * Per-view live-resource counters — the "how many live things does this view
 * hold" registry that the shell has never had (issue #10202, criterion #5).
 *
 * The render/frame telemetry stack measures how OFTEN a view renders; this
 * measures what a view RETAINS: active subscriptions/listeners, pending timers,
 * and mounted heavy resources (WebGL contexts, audio/video/media streams).
 * Those are the quantities that leak — a listener added without cleanup, an
 * interval never cleared, an AudioContext never closed — and that no existing
 * counter sees.
 *
 * Contract: every `track*` call increments the live count for a viewId and
 * returns a single-use disposer that decrements it. A well-behaved view returns
 * to zero when its resources are released; a LEAKY view (disposer never called)
 * stays above zero after unmount, which is exactly the signal the leak test
 * asserts on. We intentionally do NOT auto-zero a view's counters on
 * unmount/evict: that would hide the very leak we want visible. The map is
 * bounded by the number of distinct view ids (~the view matrix), so it never
 * grows unboundedly.
 *
 * Pure + framework-free (no React, no DOM) so it unit-tests in any env and the
 * pausable hooks / media-creation seams can call into it from anywhere.
 */

export type HeavyResourceKind = "webgl" | "audio" | "video";

export interface ResourceCountersSnapshot {
  /** Live subscriptions/listeners registered through {@link trackSubscription}. */
  activeSubscriptions: number;
  /** Live timers/intervals registered through {@link trackTimer}. */
  pendingTimers: number;
  /** Live heavy resources by kind (WebGL contexts, audio/video/media streams). */
  heavyResources: Record<HeavyResourceKind, number>;
}

interface MutableCounters {
  activeSubscriptions: number;
  pendingTimers: number;
  webgl: number;
  audio: number;
  video: number;
}

function emptyCounters(): MutableCounters {
  return {
    activeSubscriptions: 0,
    pendingTimers: 0,
    webgl: 0,
    audio: 0,
    video: 0,
  };
}

const countersByView = new Map<string, MutableCounters>();

function countersFor(viewId: string): MutableCounters {
  let counters = countersByView.get(viewId);
  if (!counters) {
    counters = emptyCounters();
    countersByView.set(viewId, counters);
  }
  return counters;
}

/**
 * Build a single-use disposer that decrements `field` (never below zero) the
 * first time it is called, ignoring any subsequent calls. Idempotent disposal
 * is important: React effect cleanups can run more than once under StrictMode
 * and we must not double-decrement.
 */
function makeDisposer(
  viewId: string,
  field: keyof MutableCounters,
): () => void {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const counters = countersByView.get(viewId);
    if (!counters) return;
    counters[field] = Math.max(0, counters[field] - 1);
  };
}

/** Register a live subscription/listener for `viewId`. Returns its disposer. */
export function trackSubscription(viewId: string): () => void {
  countersFor(viewId).activeSubscriptions += 1;
  return makeDisposer(viewId, "activeSubscriptions");
}

/** Register a live timer/interval for `viewId`. Returns its disposer. */
export function trackTimer(viewId: string): () => void {
  countersFor(viewId).pendingTimers += 1;
  return makeDisposer(viewId, "pendingTimers");
}

/** Register a live heavy resource (WebGL/audio/video) for `viewId`. */
export function trackMedia(
  viewId: string,
  kind: HeavyResourceKind,
): () => void {
  countersFor(viewId)[kind] += 1;
  return makeDisposer(viewId, kind);
}

/** Current live-resource snapshot for `viewId` (all zeros if never tracked). */
export function snapshotResourceCounters(
  viewId: string,
): ResourceCountersSnapshot {
  const counters = countersByView.get(viewId) ?? emptyCounters();
  return {
    activeSubscriptions: counters.activeSubscriptions,
    pendingTimers: counters.pendingTimers,
    heavyResources: {
      webgl: counters.webgl,
      audio: counters.audio,
      video: counters.video,
    },
  };
}

/** Total live resources across a snapshot — the single "is this view heavy" number. */
export function totalLiveResources(snapshot: ResourceCountersSnapshot): number {
  return (
    snapshot.activeSubscriptions +
    snapshot.pendingTimers +
    snapshot.heavyResources.webgl +
    snapshot.heavyResources.audio +
    snapshot.heavyResources.video
  );
}

/** All view ids that currently hold at least one live resource. */
export function viewsWithLiveResources(): string[] {
  const ids: string[] = [];
  for (const [viewId] of countersByView) {
    if (totalLiveResources(snapshotResourceCounters(viewId)) > 0) {
      ids.push(viewId);
    }
  }
  return ids;
}

/** Test-only: wipe all counters so suites start from a clean registry. */
export function __resetResourceCountersForTests(): void {
  countersByView.clear();
}
