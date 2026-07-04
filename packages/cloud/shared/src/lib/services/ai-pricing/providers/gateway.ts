// Coordinates cloud service gateway behavior behind route handlers.
import { logger } from "../../../utils/logger";
import type { PreparedPricingEntry, PriceLookupSource } from "../types";
import { fetchAtlasCloudCatalogEntries } from "./atlascloud";
import { fetchBitRouterCatalogEntries } from "./bitrouter";
import { fetchCerebrasPublicCatalogEntries } from "./cerebras";
import { fetchElevenLabsEntries } from "./elevenlabs";
import { fetchFalCatalogEntries } from "./fal";
import { fetchSunoEntries } from "./suno";
import { fetchVastSnapshotEntries } from "./vast";

async function dispatchEntriesForSource(
  source: PriceLookupSource,
): Promise<PreparedPricingEntry[]> {
  switch (source) {
    case "bitrouter":
      return await fetchBitRouterCatalogEntries();
    case "atlascloud":
      return await fetchAtlasCloudCatalogEntries();
    case "gateway":
    case "openai":
    case "anthropic":
    case "groq":
      return await fetchBitRouterCatalogEntries();
    case "cerebras":
      return await fetchCerebrasPublicCatalogEntries();
    case "fal":
      return await fetchFalCatalogEntries();
    case "elevenlabs":
      return await fetchElevenLabsEntries();
    case "suno":
      return await fetchSunoEntries();
    case "vast":
      return await fetchVastSnapshotEntries();
    case "seed":
      return [];
    default:
      return [];
  }
}

export async function fetchEntriesForSource(
  source: PriceLookupSource,
): Promise<PreparedPricingEntry[]> {
  // External pricing-catalog fetches are best-effort METADATA. A provider
  // outage — e.g. Cerebras retiring its public `/public/v1/models?format=openrouter`
  // endpoint (now 404) — must degrade pricing, never propagate and 500 the
  // inference path that prices a completion. Fall back to no fresh entries;
  // cached/seed pricing still applies.
  try {
    return await dispatchEntriesForSource(source);
  } catch (error) {
    logger.warn("[AI Pricing] external catalog fetch failed; using cached/seed pricing", {
      source,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
