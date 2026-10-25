// Coordinates cloud service atlascloud behavior behind route handlers.
import {
  SUPPORTED_IMAGE_MODELS,
  SUPPORTED_VIDEO_MODELS,
  type SupportedImageModelDefinition,
  type SupportedVideoModelDefinition,
} from "../../ai-pricing-definitions";
import { getCachedExternalEntries } from "../cache";
import { EXTERNAL_CACHE_TTL_MS, type PreparedPricingEntry } from "../types";

// Atlas image models are token-billed by the provider, but image generation is
// charged up front per image in the cloud-api generate-image flow (the cost
// calculator resolves a `unit: "image"` / `chargeType: "generation"` row, the
// same way fal image models are priced). These flat per-image prices are
// conservative manual estimates derived from Atlas public pricing; refine them
// with account-specific pricing before relying on exact margins in production.
const ATLAS_IMAGE_PRICE_BY_MODEL: Record<string, number> = {
  // gpt-image-2 high quality 1024x1024.
  "openai/gpt-image-2/text-to-image": 0.04,
  // Seedream 5.0 Lite (ByteDance) — strong, cheaper text-to-image.
  "bytedance/seedream-v5.0-lite": 0.03,
  // Nano Banana 2 (Google) — fast, high quality.
  "google/nano-banana-2/text-to-image": 0.03,
  // Qwen Image 2.0 (Alibaba).
  "qwen/qwen-image-2.0/text-to-image": 0.02,
};

// Atlas video models are billed per second, and Vidu prices vary by output
// resolution. Each model emits one pricing row PER RESOLUTION keyed on the exact
// dimension shape the generate-video route produces: `{ resolution, audio }`.
// `durationSeconds` is deliberately NOT a dimension — the route only injects it
// into requested dimensions for the hailuo_standard/pixverse parsers (see
// getDefaultVideoBillingDimensions), so seeding it here would make the subset
// match always fail. Duration is applied downstream as the `second` quantity.
const ATLAS_VIDEO_PRICE_BY_MODEL_RESOLUTION: Record<string, Record<string, number>> = {
  // Vidu Q3 Turbo Text-to-Video — Atlas page prices per resolution.
  "vidu/q3-turbo/text-to-video": {
    "540p": 0.04,
    "720p": 0.06,
    "1080p": 0.08,
  },
  // Vidu Image-to-Video 2.0 — Atlas page lists a flat $0.075/sec across
  // resolutions; emit a matchable row per supported resolution so the route's
  // `{ resolution }` dimension resolves regardless of the requested resolution.
  "vidu/image-to-video-2.0": {
    "540p": 0.075,
    "720p": 0.075,
    "1080p": 0.075,
  },
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
  return SUPPORTED_IMAGE_MODELS.filter((model) => model.billingSource === "atlascloud").flatMap(
    (model) => {
      const unitPrice = ATLAS_IMAGE_PRICE_BY_MODEL[model.modelId];
      if (unitPrice === undefined) return [];
      return [buildAtlasImageEntry(model, unitPrice)];
    },
  );
}

function buildAtlasVideoEntry(
  model: SupportedVideoModelDefinition,
  resolution: string,
  unitPrice: number,
): PreparedPricingEntry {
  const fetchedAt = new Date();
  return {
    billingSource: "atlascloud",
    provider: model.provider,
    model: model.modelId,
    productFamily: "video",
    chargeType: "generation",
    unit: "second",
    unitPrice,
    // Match the exact requested-dimension shape the generate-video route emits
    // for atlascloud models: `{ resolution, audio: false }`. Never seed
    // durationSeconds — it is not a requested dimension for this parser.
    dimensions: { resolution, audio: false },
    sourceKind: "atlascloud_catalog",
    sourceUrl: model.pageUrl,
    fetchedAt,
    staleAfter: new Date(fetchedAt.getTime() + EXTERNAL_CACHE_TTL_MS),
    metadata: {
      tier: "manual_override_recommended",
      note: "Manual Atlas Cloud video pricing seed. Refresh with account-specific pricing before production if needed.",
    },
  };
}

function buildAtlasVideoSnapshotEntries(): PreparedPricingEntry[] {
  return SUPPORTED_VIDEO_MODELS.filter((model) => model.billingSource === "atlascloud").flatMap(
    (model) => {
      const priceByResolution = ATLAS_VIDEO_PRICE_BY_MODEL_RESOLUTION[model.modelId];
      if (!priceByResolution) return [];
      return Object.entries(priceByResolution).map(([resolution, unitPrice]) =>
        buildAtlasVideoEntry(model, resolution, unitPrice),
      );
    },
  );
}

export async function fetchAtlasCloudCatalogEntries(): Promise<PreparedPricingEntry[]> {
  return await getCachedExternalEntries("atlascloud", async () => {
    return [...buildAtlasImageSnapshotEntries(), ...buildAtlasVideoSnapshotEntries()];
  });
}
