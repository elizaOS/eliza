// Coordinates cloud service elevenlabs behavior behind route handlers.
import { ELEVENLABS_SNAPSHOT_PRICING } from "../../ai-pricing-definitions";
import { getCachedExternalEntries } from "../cache";
import { EXTERNAL_CACHE_TTL_MS, type PreparedPricingEntry } from "../types";
import { buildSfxSnapshotEntries } from "./sfx";
import { buildMusicSnapshotEntries } from "./suno";

export async function fetchElevenLabsEntries(): Promise<PreparedPricingEntry[]> {
  return await getCachedExternalEntries("elevenlabs", async () => {
    const fetchedAt = new Date();
    const staleAfter = new Date(fetchedAt.getTime() + EXTERNAL_CACHE_TTL_MS);

    return [
      ...ELEVENLABS_SNAPSHOT_PRICING.map((entry) => ({
        billingSource: entry.billingSource,
        provider: entry.provider,
        model: entry.modelId,
        productFamily: entry.productFamily,
        chargeType: entry.chargeType,
        unit: entry.unit,
        unitPrice: entry.unitPrice,
        dimensions: entry.dimensions,
        sourceKind: "elevenlabs_snapshot",
        sourceUrl: entry.sourceUrl,
        fetchedAt,
        staleAfter,
        metadata: entry.metadata,
      })),
      ...buildMusicSnapshotEntries("elevenlabs", "elevenlabs_snapshot"),
      ...buildSfxSnapshotEntries("elevenlabs", "elevenlabs_snapshot"),
    ];
  });
}
