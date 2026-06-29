/**
 * Per-view RUNTIME telemetry — the aggregate "is this view expensive or
 * leaking" stream for issue #10202 (criterion #5).
 *
 * A third stream alongside `view-telemetry.ts` (launcher INTERACTIONS) and
 * `cache-telemetry.ts` (module CACHES), built the same dependency-light way: a
 * bounded `globalThis.__ELIZA_VIEW_RUNTIME_TELEMETRY__` ring + a
 * `eliza:view-runtime-telemetry` CustomEvent + a structured `[ViewTelemetry]`
 * logger line (no `console`). e2e harnesses read the ring exactly like
 * `run-launcher-e2e` reads the interaction ring.
 *
 * It carries every criterion-5 metric per view: render count + commit duration,
 * JS heap, active subscriptions/listeners, pending timers, and heavy resources
 * (WebGL/audio/video). Emitters: `ViewTelemetryProfiler` (on show/hide/pause/
 * evict) and `ViewLifecycleController` (on crash). Dev/test-gated by the caller.
 */

import { logger } from "@elizaos/logger";
import type { FrameBudgetSummary } from "./hooks/frame-budget";
import type { ResourceCountersSnapshot } from "./perf/resource-counters";
import type { ViewLifecyclePhase } from "./state/view-lifecycle-types";

export const VIEW_RUNTIME_TELEMETRY_EVENT = "eliza:view-runtime-telemetry";

/** Why a runtime-telemetry sample was emitted. */
export type ViewRuntimeTelemetryReason =
  | "show"
  | "hide"
  | "pause"
  | "resume"
  | "evict"
  | "crash"
  | "sample";

export interface ViewRuntimeTelemetryEvent {
  viewId: string;
  phase: ViewLifecyclePhase;
  reason: ViewRuntimeTelemetryReason;
  /** Commits observed for this view since mount (React Profiler). */
  renderCount: number;
  /** Most recent commit's actualDuration (ms). */
  lastCommitMs: number;
  /** p95 commit duration (ms) across this view's lifetime. */
  commitDurationP95Ms: number;
  /** `performance.memory.usedJSHeapSize` at sample time, when available. */
  jsHeapUsedSize?: number;
  /** Live subscriptions/listeners attributed to this view. */
  activeSubscriptions: number;
  /** Live timers/intervals attributed to this view. */
  pendingTimers: number;
  /** Live heavy resources (WebGL/audio/video) attributed to this view. */
  heavyResources: ResourceCountersSnapshot["heavyResources"];
  /** Frame-budget summary while this view was active, when sampled. */
  frameBudget?: FrameBudgetSummary;
  at: number;
  route?: string;
}

/** Max events retained in the in-memory ring before the oldest is dropped. */
export const VIEW_RUNTIME_RING_MAX = 200;

type TelemetryGlobal = typeof globalThis & {
  __ELIZA_VIEW_RUNTIME_TELEMETRY__?: ViewRuntimeTelemetryEvent[];
  __ELIZA_VIEW_RUNTIME_TELEMETRY_SEQUENCE__?: number;
};

let runtimeTelemetrySequence = 0;

function currentRoute(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location.pathname;
}

/**
 * Emit a per-view runtime telemetry sample: structured log + bounded ring +
 * CustomEvent. Best-effort and side-effect-light; never throws on the hot path.
 */
export function emitViewRuntimeTelemetry(
  event: Omit<ViewRuntimeTelemetryEvent, "at" | "route">,
): ViewRuntimeTelemetryEvent {
  const detail: ViewRuntimeTelemetryEvent = {
    ...event,
    at: Date.now(),
    route: currentRoute(),
  };

  const globalObject = globalThis as TelemetryGlobal;
  runtimeTelemetrySequence += 1;
  globalObject.__ELIZA_VIEW_RUNTIME_TELEMETRY_SEQUENCE__ =
    runtimeTelemetrySequence;
  const ring = globalObject.__ELIZA_VIEW_RUNTIME_TELEMETRY__;
  if (Array.isArray(ring)) {
    ring.push(detail);
    while (ring.length > VIEW_RUNTIME_RING_MAX) ring.shift();
  }

  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function" &&
    typeof CustomEvent !== "undefined"
  ) {
    window.dispatchEvent(
      new CustomEvent(VIEW_RUNTIME_TELEMETRY_EVENT, { detail }),
    );
  }

  // Only log the noteworthy samples (a view leaving the screen / crashing /
  // being evicted) so the structured log is a readable per-view ledger, not a
  // per-commit firehose.
  if (
    detail.reason === "hide" ||
    detail.reason === "evict" ||
    detail.reason === "crash" ||
    detail.reason === "pause"
  ) {
    const heap =
      detail.jsHeapUsedSize !== undefined
        ? `${(detail.jsHeapUsedSize / 1024 / 1024).toFixed(1)}MiB`
        : "n/a";
    logger.info(
      `[ViewTelemetry] view "${detail.viewId}" ${detail.reason} ` +
        `renders=${detail.renderCount} p95Commit=${detail.commitDurationP95Ms.toFixed(
          1,
        )}ms heap=${heap} subs=${detail.activeSubscriptions} ` +
        `timers=${detail.pendingTimers} ` +
        `heavy=${
          detail.heavyResources.webgl +
          detail.heavyResources.audio +
          detail.heavyResources.video
        }`,
    );
  }

  return detail;
}

/**
 * Install the global ring so emitted events are retained for inspection /
 * harness reads. Idempotent; call once at app boot (and in test setup).
 */
export function installViewRuntimeTelemetryRing(): void {
  const globalObject = globalThis as TelemetryGlobal;
  if (!Array.isArray(globalObject.__ELIZA_VIEW_RUNTIME_TELEMETRY__)) {
    globalObject.__ELIZA_VIEW_RUNTIME_TELEMETRY__ = [];
  }
}

/** Read the current runtime-telemetry ring (empty array if uninstalled). */
export function readViewRuntimeTelemetry(): ViewRuntimeTelemetryEvent[] {
  const ring = (globalThis as TelemetryGlobal).__ELIZA_VIEW_RUNTIME_TELEMETRY__;
  return Array.isArray(ring) ? [...ring] : [];
}

/** Test-only: clear the ring + sequence so suites start clean. */
export function __resetViewRuntimeTelemetryForTests(): void {
  const globalObject = globalThis as TelemetryGlobal;
  globalObject.__ELIZA_VIEW_RUNTIME_TELEMETRY__ = [];
  globalObject.__ELIZA_VIEW_RUNTIME_TELEMETRY_SEQUENCE__ = 0;
  runtimeTelemetrySequence = 0;
}
