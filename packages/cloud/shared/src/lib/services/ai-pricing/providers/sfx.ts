import { type PricingBillingSource, SFX_SNAPSHOT_PRICING } from "../../ai-pricing-definitions";
import { EXTERNAL_CACHE_TTL_MS, type PreparedPricingEntry } from "../types";

/**
 * Snapshot SFX pricing (mirrors buildMusicSnapshotEntries): fal + ElevenLabs
 * sound-effect generation has no account-agnostic live pricing feed, so the
 * catalog seeds conservative per-request rates flagged for manual override.
 */
export function buildSfxSnapshotEntries(
  billingSource?: PricingBillingSource,
  sourceKind?: string,
): PreparedPricingEntry[] {
  const fetchedAt = new Date();
  const staleAfter = new Date(fetchedAt.getTime() + EXTERNAL_CACHE_TTL_MS);
  return SFX_SNAPSHOT_PRICING.filter(
    (entry) => !billingSource || entry.billingSource === billingSource,
  ).map((entry) => ({
    billingSource: entry.billingSource,
    provider: entry.provider,
    model: entry.modelId,
    productFamily: entry.productFamily,
    chargeType: entry.chargeType,
    unit: entry.unit,
    unitPrice: entry.unitPrice,
    dimensions: entry.dimensions,
    sourceKind:
      sourceKind ?? (entry.billingSource === "fal" ? "fal_model_page" : "elevenlabs_snapshot"),
    sourceUrl: entry.sourceUrl,
    fetchedAt,
    staleAfter,
    metadata: entry.metadata,
  }));
}
