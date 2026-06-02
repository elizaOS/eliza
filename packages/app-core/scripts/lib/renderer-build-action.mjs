/**
 * Decide what to do about the renderer production `vite build` before desktop
 * dev. Pure — all inputs are passed in.
 *
 * Default behavior is unchanged from the historical inline logic: build when
 * forced or stale, skip when fresh. The opt-in `skipRequested`
 * (ELIZA_DESKTOP_RENDERER_BUILD=skip) starts the desktop shell against the
 * EXISTING dist even when stale, for a fast inner loop — at the cost of a
 * possibly stale renderer. For live edits prefer `dev:desktop:watch` (Vite HMR,
 * which skips the production build entirely).
 *
 * @param {{
 *   forceRenderer: boolean,
 *   distStale: boolean,
 *   distExists: boolean,
 *   skipRequested: boolean,
 * }} input
 * @returns {"build" | "skip-fresh" | "skip-stale"}
 *   - "build": run the blocking production build
 *   - "skip-fresh": dist is up to date, nothing to do
 *   - "skip-stale": dist is stale but skipped by explicit request (renderer may
 *     be stale until the next build)
 */
export function resolveRendererBuildAction({
  forceRenderer,
  distStale,
  distExists,
  skipRequested,
}) {
  if (forceRenderer) return "build";
  if (!distStale) return "skip-fresh";
  // dist is stale below this point
  if (skipRequested && distExists) return "skip-stale";
  return "build";
}
