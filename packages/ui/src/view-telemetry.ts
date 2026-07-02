/**
 * View-launcher interaction telemetry — a client-only, best-effort event stream
 * for the Launcher / view catalog, mirroring the shape of
 * {@link ./cache-telemetry} (window CustomEvent + a bounded globalThis ring +
 * no-op guards). It is intentionally NOT a second sink: there is no server
 * endpoint and no new EventType — tests and the e2e walkthrough subscribe to the
 * CustomEvent (or read the ring) to assert that interactions actually fired, and
 * the ring is inspectable in dev. Keep it dependency-free and side-effect-light.
 */

import type { FrameBudgetSummary } from "./hooks/frame-budget";

export const VIEW_INTERACTION_TELEMETRY_EVENT =
  "eliza:view-interaction-telemetry";

export type ViewInteractionSource =
  | "launcher"
  | "view-catalog"
  | "conversation-swipe";

export type ViewInteractionAction =
  | "launch"
  | "reorder"
  | "page-swipe"
  | "edit-mode-enter"
  | "edit-mode-exit"
  | "search"
  | "search-zero-results"
  | "hero-image-error"
  | "dynamic-view-edit"
  | "dynamic-view-delete"
  // Frame-budget summary for a single conversation-swipe gesture (#9954). Until
  // this action existed, swipe jank only surfaced through the dev-only PerfOverlay
  // HUD; emitting it here makes dropped-frame/fps data observable in the same
  // bounded ring every other interaction lands in, so a swipe-jank regression is
  // visible to a harness/test without the HUD.
  | "conversation-swipe-jank";

export interface ViewInteractionEvent {
  source: ViewInteractionSource;
  action: ViewInteractionAction;
  /** View/app id the interaction targeted, when applicable. */
  viewId?: string;
  /** Search query (for search/search-zero-results). */
  query?: string;
  /** Result count (for search) or page index (for page-swipe/reorder). */
  count?: number;
  /**
   * Swipe direction for a `conversation-swipe-jank` event (#9954): `"prev"`
   * navigates toward the newer conversation, `"next"` toward the older one (same
   * meaning as {@link ./components/shell/conversation-nav}'s direction). Lets a
   * ring reader attribute jank to a specific swipe direction without unpacking
   * `frameBudget`. Present only on `conversation-swipe-jank`.
   */
  direction?: "prev" | "next";
  /**
   * Frame-budget summary for a `conversation-swipe-jank` event (#9954) — the
   * same {@link FrameBudgetSummary} the frame-budget HUD reads, so the dropped-
   * frame %, p95 frame time, and long-task counts are computed by one source of
   * truth. Present only on `conversation-swipe-jank`.
   */
  frameBudget?: FrameBudgetSummary;
  at: number;
  route?: string;
}

/** Max events retained in the in-memory ring before the oldest is dropped. */
export const VIEW_INTERACTION_RING_MAX = 200;

type TelemetryGlobal = typeof globalThis & {
  __ELIZA_VIEW_INTERACTION_TELEMETRY__?: ViewInteractionEvent[];
  __ELIZA_VIEW_INTERACTION_TELEMETRY_SEQUENCE__?: number;
};

let viewInteractionSequence = 0;

function currentRoute(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location.pathname;
}

export function emitViewInteraction(
  event: Omit<ViewInteractionEvent, "at" | "route">,
): void {
  const detail: ViewInteractionEvent = {
    ...event,
    at: Date.now(),
    route: currentRoute(),
  };

  const g = globalThis as TelemetryGlobal;
  viewInteractionSequence += 1;
  g.__ELIZA_VIEW_INTERACTION_TELEMETRY_SEQUENCE__ = viewInteractionSequence;
  // Self-initialize the ring so events are retained + inspectable without a
  // separate bootstrap (cache-telemetry relies on an external initializer; this
  // stream owns its ring and bounds it).
  const ring = g.__ELIZA_VIEW_INTERACTION_TELEMETRY__ ?? [];
  ring.push(detail);
  if (ring.length > VIEW_INTERACTION_RING_MAX) {
    ring.splice(0, ring.length - VIEW_INTERACTION_RING_MAX);
  }
  g.__ELIZA_VIEW_INTERACTION_TELEMETRY__ = ring;

  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function" &&
    typeof CustomEvent !== "undefined"
  ) {
    window.dispatchEvent(
      new CustomEvent(VIEW_INTERACTION_TELEMETRY_EVENT, { detail }),
    );
  }
}

/** Read the retained interaction ring (newest last). Empty off-browser. */
export function readViewInteractions(): ViewInteractionEvent[] {
  const g = globalThis as TelemetryGlobal;
  return g.__ELIZA_VIEW_INTERACTION_TELEMETRY__ ?? [];
}

/**
 * Record the frame-budget summary captured over a single conversation-swipe
 * gesture (#9954). The `count` field carries the dropped-frame count so a reader
 * scanning the ring sees the headline number without unpacking `frameBudget`;
 * the full summary (p95 frame time, fps, long tasks) rides in `frameBudget`.
 * `direction` (when the swipe committed a navigation) attributes the window to a
 * `"prev"`/`"next"` swipe; it is omitted for a cancelled drag that settled back.
 */
export function emitConversationSwipeJank(
  summary: FrameBudgetSummary,
  direction?: ViewInteractionEvent["direction"],
): void {
  emitViewInteraction({
    source: "conversation-swipe",
    action: "conversation-swipe-jank",
    count: summary.droppedFrames,
    frameBudget: summary,
    ...(direction ? { direction } : {}),
  });
}
