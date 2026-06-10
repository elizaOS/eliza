import {
  SUPPORTED_IMAGE_MODELS,
  type SupportedImageModelDefinition,
} from "../../ai-pricing-definitions";
import { getCachedExternalEntries } from "../cache";
import { EXTERNAL_CACHE_TTL_MS, type PreparedPricingEntry } from "../types";

const ATLASCLOUD_PRICING_SOURCE_URL = "https://api.atlascloud.ai/v1/models";

// Atlas image models are token-billed by the provider, but image generation is
// charged up front per image in the cloud-api generate-image flow (the cost
// calculator resolves a `unit: "image"` / `chargeType: "generation"` row, the
// same way fal image models are priced). These flat per-image prices are
// conservative manual estimates derived from Atlas public pricing; refine them
// with account-specific pricing before relying on exact margins in production.
const ATLAS_IMAGE_PRICE_BY_MODEL: Record<string, number> = {
  // gpt-image-2 high quality 1024x1024 (~$5/M input tokens token-billed).
  "openai/gpt-image-2": 0.04,
  // gemini-3.1-flash-image (flash tier, cheaper than the pro image model).
  "google/gemini-3.1-flash-image": 0.01,
};

function buildAtlasImageEntry(
  model: SupportedImageModelDefinition,
  unitPrice: number,
): PreparedPricingEntry {
  const fetchedAt = new Date();
  return {
    billingSource: "atlascloud",
    provider: model.provider,
    model: model.modelId,
    productFamily: "image",
    chargeType: "generation",
    unit: "image",
    unitPrice,
    dimensions: model.defaultDimensions,
    sourceKind: "atlascloud_catalog",
    sourceUrl: model.sourceUrl,
    fetchedAt,
    staleAfter: new Date(fetchedAt.getTime() + EXTERNAL_CACHE_TTL_MS),
    metadata: {
      tier: "manual_override_recommended",
      note: "Manual Atlas Cloud image pricing seed. Refresh with account-specific pricing before production if needed.",
    },
  };
}

function buildAtlasImageSnapshotEntries(): PreparedPricingEntry[] {
  return SUPPORTED_IMAGE_MODELS.filter(
    (model) => model.billingSource === "atlascloud",
  ).flatMap((model) => {
    const unitPrice = ATLAS_IMAGE_PRICE_BY_MODEL[model.modelId];
    if (unitPrice === undefined) return [];
    return [buildAtlasImageEntry(model, unitPrice)];
  });
}

export async function fetchAtlasCloudCatalogEntries(): Promise<PreparedPricingEntry[]> {
  return await getCachedExternalEntries("atlascloud", async () => {
    return buildAtlasImageSnapshotEntries();
  });
}
