import type { PreparedPricingEntry, PriceLookupSource } from "../types";
import { fetchElevenLabsEntries } from "./elevenlabs";
import { fetchFalCatalogEntries } from "./fal";
import { fetchOpenRouterCatalogEntries } from "./openrouter";
import { fetchSunoEntries } from "./suno";
import { fetchVastSnapshotEntries } from "./vast";

export async function fetchEntriesForSource(
  source: PriceLookupSource,
): Promise<PreparedPricingEntry[]> {
  switch (source) {
    case "gateway":
    case "openrouter":
    case "openai":
    case "anthropic":
    case "groq":
      return await fetchOpenRouterCatalogEntries();
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
  }
}
