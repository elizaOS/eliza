/**
 * Normalizes X/Twitter timestamps to epoch milliseconds, inferring the source
 * unit (seconds / millis / micros) from digit count so tweet times from
 * different API surfaces compare correctly.
 *
 * Missing values (undefined or 0) fall back to "now" for callers that treat
 * absence as freshly observed. A PRESENT but non-finite or negative timestamp
 * fails closed to undefined instead of masquerading as "now" (#18965) —
 * callers must skip age filtering and omit memory createdAt in that case.
 */
export function getEpochMs(ts: number | undefined): number | undefined {
  if (ts === undefined || ts === 0) return Date.now();
  if (!Number.isFinite(ts) || ts < 0) return undefined;
  // Possible formats:
  //  • seconds  (10 digits)  e.g., 1710969600
  //  • millis   (13 digits)  e.g., 1710969600000
  //  • micros   (16 digits)  e.g., 1710969600000000
  const digits = Math.floor(Math.log10(ts)) + 1;

  if (digits <= 12) {
    // seconds → ms
    return ts * 1000;
  }

  if (digits === 13) {
    // already milliseconds
    return ts;
  }

  if (digits === 16) {
    // microseconds → ms
    return Math.floor(ts / 1000);
  }

  // If absurdly large, scale down until plausible.
  while (ts > 9_999_999_999_999) {
    ts = Math.floor(ts / 1000);
  }
  return ts;
}
