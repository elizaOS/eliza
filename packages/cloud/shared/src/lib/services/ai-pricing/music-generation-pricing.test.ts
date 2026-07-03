import { beforeEach, expect, mock, test } from "bun:test";
import { buildMusicSnapshotEntries } from "./providers/suno";
import type { PreparedPricingEntry } from "./types";

mock.module("../../../db/repositories/ai-pricing", () => ({
  aiPricingRepository: {
    listActiveEntriesForProviderModelPairs: async () => [],
    listActiveEntries: async () => [],
  },
}));

mock.module("./providers/gateway", () => ({
  fetchEntriesForSource: async (source: string): Promise<PreparedPricingEntry[]> =>
    source === "fal" ? buildMusicSnapshotEntries("fal", "fal_model_page") : [],
}));

const { calculateMusicGenerationCostFromCatalog } = await import("./lookup");
const { __clearPersistedPricingCache } = await import("./cache");

beforeEach(() => {
  __clearPersistedPricingCache();
});

test("MiniMax Music 2.6 resolves as Fal's fixed per-audio price, not requested-duration minutes", async () => {
  const cost = await calculateMusicGenerationCostFromCatalog({
    model: "fal-ai/minimax-music/v2.6",
    provider: "fal",
    billingSource: "fal",
    durationSeconds: 10,
    dimensions: { durationSeconds: 10 },
  });

  expect(cost.matchedEntry.unit).toBe("request");
  expect(cost.matchedEntry.unitPrice).toBe(0.15);
  expect(cost.baseTotalCost).toBe(0.15);
  expect(cost.totalCost).toBe(0.18);
});
