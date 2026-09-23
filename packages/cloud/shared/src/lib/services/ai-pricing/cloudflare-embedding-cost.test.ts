/** Exercises actual Workers AI catalog selection and token-cost arithmetic with an empty persisted catalog. */
import { expect, mock, test } from "bun:test";

mock.module("../../../db/repositories/ai-pricing", () => ({
  aiPricingRepository: {
    listActiveEntriesForProviderModelPairs: async () => [],
    listActiveEntries: async () => [],
  },
}));
const { calculateTextCostFromCatalog } = await import("./lookup");
test("BGE reservation and settlement use the Cloudflare embedding rate", async () => {
  const reserve = await calculateTextCostFromCatalog({
    model: "bge-small-en-v1.5",
    provider: "cloudflare",
    billingSource: "cloudflare",
    inputTokens: 1_000_000,
    outputTokens: 0,
  });
  const settle = await calculateTextCostFromCatalog({
    model: "bge-small-en-v1.5",
    provider: "cloudflare",
    billingSource: "cloudflare",
    inputTokens: 500_000,
    outputTokens: 0,
  });
  expect(reserve.baseInputCost).toBe(0.0202);
  expect(settle.baseInputCost).toBe(0.0101);
  expect(settle.baseOutputCost).toBe(0);
  expect(reserve.totalCost).toBeGreaterThanOrEqual(reserve.baseTotalCost);
});
