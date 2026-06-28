/**
 * View-launcher interaction telemetry — a client-only, best-effort event stream
 * for the Springboard / view catalog, mirroring the shape of
 * {@link ./cache-telemetry} (window CustomEvent + a bounded globalThis ring +
 * no-op guards). It is intentionally NOT a second sink: there is no server
 * endpoint and no new EventType — tests and the e2e walkthrough subscribe to the
 * CustomEvent (or read the ring) to assert that interactions actually fired, and
 * the ring is inspectable in dev. Keep it dependency-free and side-effect-light.
 */

export const VIEW_INTERACTION_TELEMETRY_EVENT =
  "eliza:view-interaction-telemetry";

export type ViewInteractionSource = "springboard" | "view-catalog";

export type ViewInteractionAction =
  | "launch"
  | "favorite"
  | "unfavorite"
  | "reorder"
  | "page-swipe"
  | "edit-mode-enter"
  | "edit-mode-exit"
  | "search"
  | "search-zero-results"
  | "hero-image-error"
  | "dynamic-view-edit"
  | "dynamic-view-delete";

export interface ViewInteractionEvent {
  source: ViewInteractionSource;
  action: ViewInteractionAction;
  /** View/app id the interaction targeted, when applicable. */
  viewId?: string;
  /** Search query (for search/search-zero-results). */
  query?: string;
  /** Result count (for search) or page index (for page-swipe/reorder). */
  count?: number;
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
