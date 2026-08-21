/**
 * Canonical earnings-unit contract (#22960).
 *
 * UNIT CANON: redeemable earnings are stored, ledgered, converted to credits,
 * and redeemed in **US dollars** as `NUMERIC(18,4)` / `Decimal` (4 decimal
 * places). "Points" are a **redemption HTTP-boundary representation only**:
 * the public API accepts integer `pointsAmount` where
 * `REDEMPTION_POINTS_PER_USD = 100` (one point = $0.01). No service,
 * repository, job, or ledger may interpret a stored earnings value as
 * anything other than USD.
 *
 * Conversion boundary (server-side single source of truth): all SERVER-side
 * code converts points<->USD exclusively through this module — no inline
 * ratio recomputation in cloud services or API routes. (The browser UI keeps
 * its own string-input parser in `redemption-client-contract.ts`, which is
 * deliberately dependency-free for the browser bundle; it pins the same
 * 100:1 ratio and is covered by its own contract tests.)
 * - points -> USD: `usdFromPoints(points)` = points / 100, exact for integer
 *   points (Decimal division, no float).
 * - USD -> points: `pointsFromUsd(usd)` = usd * 100. Integer USD produces
 *   integer points; sub-cent USD (more than 2 decimals) is rejected because
 *   the API boundary accepts only integer points.
 *
 * Rounding policy: there is none at this boundary — the ratio is an exact
 * 100:1 integer ratio. Any rounding of earnings to 4dp happens where earnings
 * are CREDITED (see the container-billing / markup services), not here.
 */
import { ElizaError } from "@elizaos/core";
import { Decimal } from "decimal.js";
import { REDEMPTION_POINTS_PER_USD } from "../../types/redemption-contract";

export { REDEMPTION_POINTS_PER_USD };

/** Canonical stored/displayed unit for all redeemable-earnings values. */
export type EarningsUsd = Decimal;

/**
 * Convert an integer redemption `pointsAmount` to canonical USD.
 * Exact for all integer points; throws a typed error on non-integer input
 * (the API boundary guarantees `.int()` upstream; this is the fail-closed
 * backstop).
 */
export function usdFromPoints(points: number): Decimal {
  if (!Number.isInteger(points)) {
    throw new ElizaError(`pointsAmount must be an integer number of points, received: ${points}`, {
      code: "INVALID_REDEMPTION_POINTS",
      context: { received: String(points) },
    });
  }
  return new Decimal(points).div(REDEMPTION_POINTS_PER_USD);
}

/**
 * Convert canonical USD to integer redemption points.
 * Returns null when the input is malformed, non-finite, negative, or cannot
 * map to an integer number of points (sub-cent precision beyond $0.01).
 * Never throws.
 */
export function pointsFromUsd(usd: Decimal | number): number | null {
  let d: Decimal;
  if (usd instanceof Decimal) {
    d = usd;
  } else if (typeof usd === "number" && Number.isFinite(usd)) {
    d = new Decimal(usd);
  } else {
    return null;
  }
  if (!d.isFinite() || d.isNegative()) return null;
  const points = d.mul(REDEMPTION_POINTS_PER_USD);
  if (!points.isInteger()) return null;
  const n = points.toNumber();
  return Number.isSafeInteger(n) ? n : null;
}
