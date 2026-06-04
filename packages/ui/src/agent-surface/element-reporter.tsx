/**
 * AgentSurfaceElementReporter — reports a view's addressable element snapshot to
 * the agent backend (POST /api/views/:id/elements) so the planner's "# Active
 * View" awareness block can list elements and act on them by id WITHOUT a
 * list-elements round-trip.
 *
 * Best-effort + debounced: it never throws into the view, and the server gates
 * the report on the id matching the active (navigated-to) view, so a background
 * or stale surface's report is simply dropped. Mounted inside AgentSurfaceProvider
 * by the host wrappers (DynamicViewLoader, ShellViewAgentSurface) — not by the
 * provider itself, so unit tests that render the provider directly stay offline.
 *
 * The payload builder and the subscribe/POST hook live in
 * `element-reporter.hooks` so this module stays component-only (a React Fast
 * Refresh requirement).
 */

import { useAgentSurface } from "./AgentSurfaceContext.hooks";
import { useAgentSurfaceElementReporter } from "./element-reporter.hooks";

/** Renders nothing; reports the surrounding view's elements to the backend. */
export function AgentSurfaceElementReporter(): null {
  const surface = useAgentSurface();
  useAgentSurfaceElementReporter(surface?.registry ?? null);
  return null;
}
