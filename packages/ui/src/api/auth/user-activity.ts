/**
 * Tracks the last real user interaction so the agent's idle-timeout policy
 * (automatic logoff) slides on user activity rather than background polling.
 * The shared API clients attach it to requests for the page's own origin or
 * the configured agent API base as `x-eliza-last-activity: <epoch ms>`; the
 * server clamps and validates it (and allows it in CORS).
 */
import { LAST_ACTIVITY_HEADER_NAME } from "@elizaos/auth";

/** Minimum spacing between recorded interactions. */
export const USER_ACTIVITY_THROTTLE_MS = 5_000;
const ACTIVITY_EVENTS = [
  "pointerdown",
  "keydown",
  "touchstart",
  "wheel",
] as const;

let lastActivityAt: number | null = null;
let installed = false;

/** Record an interaction, at most once per throttle window. */
export function recordUserActivity(now: number = Date.now()): void {
  if (
    lastActivityAt !== null &&
    now >= lastActivityAt &&
    now - lastActivityAt < USER_ACTIVITY_THROTTLE_MS
  ) {
    return;
  }
  lastActivityAt = now;
}

export function getLastUserActivityAt(): number | null {
  return lastActivityAt;
}

/**
 * Listen for pointer, keyboard, touch and wheel input, and for the page
 * becoming visible. Idempotent; a no-op outside a browser document.
 */
export function installUserActivityTracker(): void {
  if (installed) return;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  installed = true;
  const onActivity = () => recordUserActivity();
  for (const type of ACTIVITY_EVENTS) {
    window.addEventListener(type, onActivity, { capture: true, passive: true });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") recordUserActivity();
  });
}

function originOf(url: string, base: string | undefined): string | null {
  try {
    return new URL(url, base).origin;
  } catch {
    // error-policy:J3 an unparseable URL matches no trusted origin.
    return null;
  }
}

/**
 * The activity header for a request to the page's own origin or to the
 * configured agent API base (`agentApiBase`, e.g. a remote agent whose CORS
 * policy allows the header). No headers when there is no recorded
 * interaction or the request goes anywhere else (cloud, relays, third
 * parties), where a custom header would trigger an unwanted preflight.
 */
export function lastActivityHeadersForUrl(
  url: string,
  agentApiBase?: string,
): Record<string, string> {
  installUserActivityTracker();
  if (lastActivityAt === null) return {};
  const location = globalThis.location;
  const pageOrigin =
    location?.origin && location.origin !== "null" ? location.origin : null;
  const target = originOf(url, location?.href);
  if (!target || target === "null") return {};
  const agentOrigin = agentApiBase
    ? originOf(agentApiBase, location?.href)
    : null;
  if (target !== pageOrigin && target !== agentOrigin) return {};
  return { [LAST_ACTIVITY_HEADER_NAME]: String(lastActivityAt) };
}

/** Test-only reset of the recorded interaction. */
export function _resetUserActivityForTests(): void {
  lastActivityAt = null;
}
