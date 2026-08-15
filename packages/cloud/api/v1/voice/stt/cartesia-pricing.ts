/**
 * Computes Cartesia batch-transcription charges from the deployment's
 * account-specific credit price and Cartesia's published credits-per-second
 * schedule. The caller supplies duration from the provider response when
 * settling so estimated reservations reconcile to authoritative usage.
 */
import { PLATFORM_MARKUP_MULTIPLIER } from "@/lib/pricing-constants";
import type { FlatOperationCost } from "@/lib/services/ai-pricing";

const CARTESIA_STT_CREDITS_PER_SECOND = 0.5;
const CARTESIA_PRICING_SOURCE = "https://www.cartesia.ai/pricing";

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export function parseCartesiaUsdPerCredit(value: string | undefined): number {
  const parsed = Number(value);
  if (!value?.trim() || !Number.isFinite(parsed) || parsed <= 0) {
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
