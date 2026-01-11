export function getEpochMs(ts: number | undefined): number {
  if (!ts) return Date.now();
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

  // Fallback: if absurdly large, scale down until plausible (safety)
  while (ts > 9_999_999_999_999) {
    ts = Math.floor(ts / 1000);
  }
  return ts;
}
