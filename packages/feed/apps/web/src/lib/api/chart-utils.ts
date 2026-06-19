export const BUCKET_CANDIDATES_MS = [
  60_000, // 1m
  2 * 60_000, // 2m
  5 * 60_000, // 5m
  10 * 60_000, // 10m
  15 * 60_000, // 15m
  30 * 60_000, // 30m
  60 * 60_000, // 1h
  2 * 60 * 60_000, // 2h
  4 * 60 * 60_000, // 4h
  6 * 60 * 60_000, // 6h
  12 * 60 * 60_000, // 12h
  24 * 60 * 60_000, // 1d
] as const;

export function chooseBucketMs(spanMs: number, maxPoints: number): number {
  if (!Number.isFinite(spanMs) || spanMs <= 0) return BUCKET_CANDIDATES_MS[0];
  if (!Number.isFinite(maxPoints) || maxPoints <= 1)
    return BUCKET_CANDIDATES_MS.at(-1)!;

  for (const candidate of BUCKET_CANDIDATES_MS) {
    if (Math.ceil(spanMs / candidate) <= maxPoints) return candidate;
  }
  return BUCKET_CANDIDATES_MS.at(-1)!;
}
