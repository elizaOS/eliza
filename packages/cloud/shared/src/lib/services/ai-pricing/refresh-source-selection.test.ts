/** Scheduled argument-free refresh includes the platform-owned selfhosted tariff. */
import { beforeEach, expect, mock, test } from "bun:test";

const loadedSources: string[] = [];
const emptyCatalog = (source: string) => async () => {
  loadedSources.push(source);
  return [];
};
mock.module("../../../db/helpers", () => ({
  dbWrite: {
    insert: () => ({
      values: () => ({ returning: async () => [{ id: "selection-fixture" }] }),
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  },
}));
mock.module("../../../db/repositories/ai-pricing", () => ({
  aiPricingRepository: {
    listActiveEntries: async () => {
      throw Error("Empty fixture must not replace a catalog");
    },
  },
}));
mock.module("../../utils/logger", () => ({ logger: { error() {} } }));
mock.module("./providers/selfhosted", () => ({
  fetchSelfHostedEmbeddingEntries: emptyCatalog("selfhosted"),
  SELF_HOSTED_EMBEDDING_PRICING_SOURCE_URL: "fixture://selfhosted",
}));
mock.module("./providers/bitrouter", () => ({
  fetchBitRouterCatalogEntries: emptyCatalog("bitrouter"),
}));
mock.module("./providers/fal", () => ({
  fetchFalCatalogEntries: emptyCatalog("fal"),
}));
mock.module("./providers/elevenlabs", () => ({
  fetchElevenLabsEntries: emptyCatalog("elevenlabs"),
}));
mock.module("./providers/vast", () => ({
  fetchVastSnapshotEntries: emptyCatalog("vast"),
}));
mock.module("./providers/suno", () => ({
  fetchSunoEntries: emptyCatalog("suno"),
}));
const { refreshPricingCatalog } = await import("./refresh");
beforeEach(() => {
  loadedSources.length = 0;
});

test("omitted sources refresh the selfhosted catalog for the scheduled caller", async () => {
  const result = await refreshPricingCatalog();
  expect(loadedSources).toEqual(["selfhosted", "bitrouter", "fal", "elevenlabs", "vast"]);
  expect(result.results.map((entry) => entry.source)).toEqual(loadedSources);
  expect(result.results.every((entry) => !entry.success)).toBe(true);
});

test("an explicit selfhosted selection still invokes its canonical loader", async () => {
  const result = await refreshPricingCatalog(["selfhosted"]);
  expect(loadedSources).toEqual(["selfhosted"]);
  expect(result.results.map((entry) => entry.source)).toEqual(["selfhosted"]);
  expect(result.results[0]?.success).toBe(false);
});
