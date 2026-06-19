/**
 * Local consent state for SOC2 user-facing toggles, backed by `localStorage`
 * under a fixed prefix. Each accessor defaults to "OFF / not consented", per
 * privacy-by-default. Ported from
 * `@elizaos/cloud-frontend/src/lib/security/consent-store.ts`.
 */

const PREFIX = "eliza.security.consent.";

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return raw === "true";
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFIX + key, value ? "true" : "false");
  } catch {
    // localStorage may be unavailable (Safari private mode, etc.). Drop silently;
    // the UI reads the in-memory fallback on next render.
  }
}

// Vision / screen-capture consent (default OFF).
export function getVisionEnabled(): boolean {
  return readBool("vision.enabled", false);
}
export function setVisionEnabled(enabled: boolean): void {
  writeBool("vision.enabled", enabled);
}

// Trajectory logging toggle (default OFF in prod).
export function getTrajectoryLoggingEnabled(): boolean {
  return readBool("trajectoryLogging.enabled", false);
}
export function setTrajectoryLoggingEnabled(enabled: boolean): void {
  writeBool("trajectoryLogging.enabled", enabled);
}
