/**
 * Pure browser-side adapters for the canonical earnings redemption transport
 * contract: exact USD parsing, request construction, and quote correlation.
 */

import {
  canonicalizeRedemptionNetwork,
  type ExplicitCreateRedemptionRequest,
  REDEMPTION_MAX_POINTS,
  REDEMPTION_MIN_POINTS,
  REDEMPTION_POINTS_PER_USD,
  type RedemptionNetwork,
  type RedemptionQuote,
  type RedemptionQuoteRequest,
} from "@elizaos/cloud-shared/types/redemption-contract";

/**
 * Parse the USD-denominated form value into the integer points expected by the
 * redemption API without passing through binary floating-point arithmetic.
 */
export function parseRedemptionUsdToPoints(value: string): number | null {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;

  const wholeUsd = Number(match[1]);
  const fractional = (match[2] ?? "").padEnd(2, "0");
  const fractionalPoints = Number(fractional || "0");
  if (
    !Number.isSafeInteger(wholeUsd) ||
    !Number.isSafeInteger(fractionalPoints)
  ) {
    return null;
  }

  const pointsAmount = wholeUsd * REDEMPTION_POINTS_PER_USD + fractionalPoints;
  return Number.isSafeInteger(pointsAmount) && pointsAmount > 0
    ? pointsAmount
    : null;
}

function decimalUsdNumberParts(value: number): {
  whole: number;
  fraction: string;
} | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const canonical = value.toString();
  if (canonical.includes("e")) return null;
  const [whole = "0", fraction = ""] = canonical.split(".");
  const wholeNumber = Number(whole);
  return Number.isSafeInteger(wholeNumber)
    ? { whole: wholeNumber, fraction }
    : null;
}

/** Floor a server-provided USD number to spendable integer cents safely. */
export function floorRedemptionUsdToPoints(value: number): number {
  const parts = decimalUsdNumberParts(value);
  if (!parts) return 0;
  const points =
    parts.whole * REDEMPTION_POINTS_PER_USD +
    Number(parts.fraction.padEnd(2, "0").slice(0, 2));
  return Number.isSafeInteger(points) ? points : 0;
}

/** Ceil a configured minimum to the first whole cent that satisfies it. */
export function ceilRedemptionUsdToPoints(value: number): number {
  const floorPoints = floorRedemptionUsdToPoints(value);
  const parts = decimalUsdNumberParts(value);
  return parts && /[1-9]/.test(parts.fraction.slice(2))
    ? floorPoints + 1
    : floorPoints;
}

export function buildRedemptionQuotePath(
  request: RedemptionQuoteRequest,
): string {
  const params = new URLSearchParams();
  if (request.pointsAmount !== undefined) {
    params.set("pointsAmount", String(request.pointsAmount));
  }
  params.set("network", request.network);
  return `/api/v1/redemptions/quote?${params.toString()}`;
}

export function buildCreateRedemptionRequest(input: {
  usdAmount: string;
  network: RedemptionNetwork;
  payoutAddress: string;
  idempotencyKey: string;
}): ExplicitCreateRedemptionRequest | null {
  const pointsAmount = parseRedemptionUsdToPoints(input.usdAmount);
  if (
    pointsAmount === null ||
    pointsAmount < REDEMPTION_MIN_POINTS ||
    pointsAmount > REDEMPTION_MAX_POINTS
  ) {
    return null;
  }

  return {
    pointsAmount,
    network: input.network,
    asset: "eliza",
    payoutAddress: input.payoutAddress,
    idempotencyKey: input.idempotencyKey,
  };
}

export function createRedemptionIdempotencyKey(
  randomUuid: () => string = () => globalThis.crypto.randomUUID(),
): string {
  return randomUuid();
}

export function quoteMatchesRedemptionRequest(
  quote:
    | { success: false }
    | {
        success: true;
        quote: Pick<RedemptionQuote, "asset" | "network" | "pointsAmount">;
      },
  request:
    | RedemptionQuoteRequest
    | Pick<
        ExplicitCreateRedemptionRequest,
        "asset" | "network" | "pointsAmount"
      >,
): boolean {
  const expectedAsset = "asset" in request ? request.asset : "eliza";
  const expectedPoints = request.pointsAmount ?? REDEMPTION_MIN_POINTS;
  return (
    quote.success &&
    quote.quote.asset === expectedAsset &&
    quote.quote.pointsAmount === expectedPoints &&
    quote.quote.network === canonicalizeRedemptionNetwork(request.network)
  );
}

export function isRedemptionQuoteExpired(
  validUntil: string,
  nowMs = Date.now(),
): boolean {
  const validUntilMs = Date.parse(validUntil);
  return !Number.isFinite(validUntilMs) || validUntilMs <= nowMs;
}
