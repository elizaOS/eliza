import type { Position } from "./location.ts";

export const NAVIGATION_FIX_LIMITS = {
  maxFixAgeMs: 30_000,
  maxAccuracyMeters: 50,
} as const;
/** Recheck at use time: a previously accepted GPS fix can age without another event. */
export function usableNavigationFix(
  fix: Position | undefined,
  now = Date.now(),
  limits: {
    maxFixAgeMs: number;
    maxAccuracyMeters: number;
  } = NAVIGATION_FIX_LIMITS,
): fix is Position {
  return (
    !!fix &&
    Number.isFinite(fix.timestamp) &&
    now - fix.timestamp <= limits.maxFixAgeMs &&
    fix.timestamp <= now + 5_000 &&
    Number.isFinite(fix.accuracyMeters) &&
    fix.accuracyMeters >= 0 &&
    fix.accuracyMeters <= limits.maxAccuracyMeters &&
    fix.precision === "precise"
  );
}
