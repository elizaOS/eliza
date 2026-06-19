/**
 * Tracks which overlay app (e.g. companion) is foregrounded in the dashboard.
 * Overlay apps do not create AppManager runs, so agent-side gating also consults
 * this heartbeat updated via POST /api/apps/overlay-presence.
 */

export const OVERLAY_APP_PRESENCE_TTL_MS = 60_000;

let lastAppName: string | null = null;
let lastReportAt = 0;

export function setOverlayAppPresence(appName: string | null): void {
  lastAppName = appName?.trim() ? appName : null;
  lastReportAt = Date.now();
}

export function isOverlayAppPresenceActive(
  appCanonicalName: string,
  maxAgeMs: number = OVERLAY_APP_PRESENCE_TTL_MS,
): boolean {
  if (!lastAppName || lastAppName !== appCanonicalName) {
    return false;
  }
  return Date.now() - lastReportAt <= maxAgeMs;
}
