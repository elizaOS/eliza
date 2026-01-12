export function getEpochMs(ts: number | undefined): number {
  if (!ts) return Date.now();
  const digits = Math.floor(Math.log10(ts)) + 1;

  if (digits <= 12) {
    return ts * 1000;
  }

  if (digits === 13) {
    return ts;
  }

  if (digits === 16) {
    return Math.floor(ts / 1000);
  }

  while (ts > 9_999_999_999_999) {
    ts = Math.floor(ts / 1000);
  }
  return ts;
}
