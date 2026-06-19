import { MUSIC_SNAPSHOT_PRICING, type PricingBillingSource } from "../../ai-pricing-definitions";
import { getCachedExternalEntries } from "../cache";
import { EXTERNAL_CACHE_TTL_MS, type PreparedPricingEntry } from "../types";

export function buildMusicSnapshotEntries(
  billingSource?: PricingBillingSource,
  sourceKind?: string,
): PreparedPricingEntry[] {
  const fetchedAt = new Date();
  const staleAfter = new Date(fetchedAt.getTime() + EXTERNAL_CACHE_TTL_MS);
  return MUSIC_SNAPSHOT_PRICING.filter(
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
      sourceKind ??
      (entry.billingSource === "suno"
        ? "suno_snapshot"
        : entry.billingSource === "fal"
          ? "fal_model_page"
          : "elevenlabs_snapshot"),
    sourceUrl: entry.sourceUrl,
    fetchedAt,
    staleAfter,
    metadata: entry.metadata,
  }));
}

export async function fetchSunoEntries(): Promise<PreparedPricingEntry[]> {
  return await getCachedExternalEntries("suno", async () =>
    buildMusicSnapshotEntries("suno", "suno_snapshot"),
  );
}
