/**
 * Builds the URL and opens the pop-out window for the agent screen-stream view.
 * The URL carries a `popout` query flag (read by `stream/helpers.ts` `IS_POPOUT`)
 * and, on `file:`/`electrobun:` origins where a query string on the path is not
 * navigable, routes it through the hash so the SPA still resolves the route.
 */
const STREAM_POPOUT_WINDOW_TARGET = "elizaos-stream";
const STREAM_POPOUT_WINDOW_FEATURES =
  "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no";

export function buildStreamPopoutUrl(apiBase?: string): string {
  const base = window.location.origin || "";
  const sep =
    window.location.protocol === "file:" ||
    window.location.protocol === "electrobun:"
      ? "#"
      : "";
  const trimmedApiBase = apiBase?.trim();
  const qs = trimmedApiBase
    ? `popout&apiBase=${encodeURIComponent(trimmedApiBase)}`
    : "popout";
  return `${base}${sep}/?${qs}`;
}

export function openStreamPopout(apiBase?: string): Window | null {
  return window.open(
    buildStreamPopoutUrl(apiBase),
    STREAM_POPOUT_WINDOW_TARGET,
    STREAM_POPOUT_WINDOW_FEATURES,
  );
}
