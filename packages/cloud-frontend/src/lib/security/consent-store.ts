/**
 * Local consent state for SOC2 user-facing toggles. Currently backed by
 * `localStorage` keyed under a fixed prefix. Each accessor returns a default
 * that errs on the side of "OFF / not consented", per privacy-by-default.
 *
 * TODO(SOC2/secure-store): migrate to the desktop/iOS SecureStore once the
 * clients agent exposes a uniform JS API. Until then, localStorage is the
 * portable path for the web dashboard.
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
    // the UI will read the in-memory fallback on next render.
  }
}

function readNumber(key: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeNumber(key: string, value: number | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(PREFIX + key);
    else window.localStorage.setItem(PREFIX + key, String(value));
  } catch {
    // see writeBool
  }
}

// Vision / screen-capture consent (default OFF).
export function getVisionEnabled(): boolean {
  return readBool("vision.enabled", false);
}
export function setVisionEnabled(enabled: boolean): void {
  writeBool("vision.enabled", enabled);
}

// Ephemeral "remember for N hours" — stored as an epoch-ms expiry.
export function getVisionRememberUntilMs(): number | null {
  return readNumber("vision.rememberUntil");
}
export function setVisionRememberUntilMs(epochMs: number | null): void {
  writeNumber("vision.rememberUntil", epochMs);
}
export function isVisionRemembered(now: number = Date.now()): boolean {
  const until = getVisionRememberUntilMs();
  return until !== null && until > now;
}

// Trajectory logging toggle (default OFF in prod).
export function getTrajectoryLoggingEnabled(): boolean {
  return readBool("trajectoryLogging.enabled", false);
}
export function setTrajectoryLoggingEnabled(enabled: boolean): void {
  writeBool("trajectoryLogging.enabled", enabled);
}
