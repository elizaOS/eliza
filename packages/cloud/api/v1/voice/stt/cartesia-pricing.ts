/**
 * Computes Cartesia batch-transcription charges from the deployment's
 * account-specific credit price and Cartesia's published credits-per-second
 * schedule. The caller supplies duration from the provider response when
 * settling so estimated reservations reconcile to authoritative usage.
 */
import { PLATFORM_MARKUP_MULTIPLIER } from "@elizaos/cloud-shared/lib/pricing-constants";
import type { FlatOperationCost } from "@elizaos/cloud-shared/lib/services/ai-pricing";

const CARTESIA_STT_CREDITS_PER_SECOND = 0.5;
const CARTESIA_PRICING_SOURCE = "https://www.cartesia.ai/pricing";

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

/**
 * Highest published paid-plan credit price (Pro overage: $65 per 1M credits;
 * Startup $45, Scale $38). Cloud speech is funded from subscription allowance,
 * so this only sizes reservations and usage records; the conservative upper
 * bound never under-reserves. A deployment on a cheaper Cartesia plan may set
 * CARTESIA_STT_USD_PER_CREDIT to its account rate.
 */
export const CARTESIA_PUBLISHED_USD_PER_CREDIT = 65 / 1_000_000;

/** Account rate when configured, else the published upper bound. A set but
 * invalid value is a deployment error and fails closed. */
export function parseCartesiaUsdPerCredit(value: string | undefined): number {
  if (value === undefined || value.trim() === "")
    return CARTESIA_PUBLISHED_USD_PER_CREDIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      "CARTESIA_STT_USD_PER_CREDIT must be a positive finite number",
    );
  }
  return parsed;
}

export function calculateCartesiaSttCost(params: {
  durationSeconds: number;
  usdPerCredit: number;
}): FlatOperationCost {
  if (!Number.isFinite(params.durationSeconds) || params.durationSeconds <= 0) {
    throw new Error("Cartesia STT duration must be a positive finite number");
  }
  if (!Number.isFinite(params.usdPerCredit) || params.usdPerCredit <= 0) {
    throw new Error(
      "Cartesia STT credit price must be a positive finite number",
    );
  }

  const rawBaseTotalCost =
    params.durationSeconds *
    CARTESIA_STT_CREDITS_PER_SECOND *
    params.usdPerCredit;
  const baseTotalCost = roundMoney(rawBaseTotalCost);
  const totalCost = roundMoney(rawBaseTotalCost * PLATFORM_MARKUP_MULTIPLIER);

  return {
    baseTotalCost,
    totalCost,
    platformMarkup: roundMoney(
      rawBaseTotalCost * (PLATFORM_MARKUP_MULTIPLIER - 1),
    ),
    matchedEntry: {
      billingSource: "cartesia",
      provider: "cartesia",
      model: "ink-whisper",
      productFamily: "stt",
      chargeType: "generation",
      unit: "second",
      unitPrice: params.usdPerCredit * CARTESIA_STT_CREDITS_PER_SECOND,
      dimensions: {},
      sourceKind: "deployment_account_rate",
      sourceUrl: CARTESIA_PRICING_SOURCE,
    },
  };
}
