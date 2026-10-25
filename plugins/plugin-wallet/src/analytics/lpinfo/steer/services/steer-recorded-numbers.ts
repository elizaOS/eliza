/**
 * Subgraph and SDK zeros are recorded values. `parseInt(...) || 18` and
 * `apy || apr` replaced a 0-decimal token, a 0 fee tier, a 0% yield, and
 * an epoch `createdAt` string with the fallback.
 */

export function recordedFeeFraction(raw: number | string | undefined): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0.3;
}

export function recordedSteerYield(
  apy: number | undefined,
  apr: number | undefined,
  apr1d: number | undefined,
  apr7d: number | undefined,
  apr14d: number | undefined,
): number {
  for (const value of [apy, apr, apr1d, apr7d, apr14d]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

export function recordedSteerCreatedAt(
  value: number | string | undefined,
  now: number,
): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return now;
}

/** Integer subgraph fields such as token decimals and Uniswap fee tier bps. */
export function recordedSubgraphInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
