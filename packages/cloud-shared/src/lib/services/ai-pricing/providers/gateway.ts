import type { PreparedPricingEntry, PriceLookupSource } from "../types";
import { fetchBitRouterCatalogEntries } from "./bitrouter";
import { fetchCerebrasPublicCatalogEntries } from "./cerebras";
import { fetchElevenLabsEntries } from "./elevenlabs";
import { fetchFalCatalogEntries } from "./fal";
import { fetchSunoEntries } from "./suno";
import { fetchVastSnapshotEntries } from "./vast";

export async function fetchEntriesForSource(
  source: PriceLookupSource,
): Promise<PreparedPricingEntry[]> {
  switch (source) {
    case "bitrouter":
      return await fetchBitRouterCatalogEntries();
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
