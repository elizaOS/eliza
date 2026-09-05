/** Verifies the external MiniMax H3 Max pricing text maps to billable resolution rows. */

import { expect, mock, spyOn, test } from "bun:test";
import { getSupportedVideoModelDefinition } from "../../ai-pricing-definitions";

mock.module("../../../../db/repositories/ai-pricing", () => ({
  aiPricingRepository: {
    listActiveEntries: async () => [],
    listActiveEntriesForProviderModelPairs: async () => [],
  },
}));

const { fetchFalCatalogEntries, parseFalPricingEntries } = await import("./fal");

mock.module("./gateway", () => ({
  fetchEntriesForSource: async (source: string) =>
    source === "fal" ? fetchFalCatalogEntries() : [],
}));
const { calculateVideoGenerationCostFromCatalog, getDefaultVideoBillingDimensions } = await import(
  "../lookup"
);

test("parses MiniMax H3 Max per-second prices by resolution", () => {
  const model = getSupportedVideoModelDefinition("minimax/h3-max/image-to-video");
  expect(model).toBeDefined();

  const entries = parseFalPricingEntries(
    model!,
    "Video costs $0.025 per second at 480p, $0.04 per second at 768p.",
  );

  expect(entries).toHaveLength(2);
  expect(entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        model: "minimax/h3-max/image-to-video",
        unit: "second",
        unitPrice: 0.025,
        dimensions: { resolution: "480P" },
      }),
      expect.objectContaining({
        model: "minimax/h3-max/image-to-video",
        unit: "second",
        unitPrice: 0.04,
        dimensions: { resolution: "768P" },
      }),
    ]),
  );
});

test("resolves published HTML pricing through the same catalog lookup used before video dispatch", async () => {
  const modelId = "minimax/h3-max/image-to-video";
  const pageUrl = "https://fal.ai/models/minimax/h3-max/image-to-video";
  // The published model page wraps both prices and resolutions in strong tags.
  const pricingHtml =
    "<p>Video costs <strong>$0.0125</strong> per second at <strong>480p</strong>, <strong>$0.02</strong> per second at <strong>768p</strong>.</p>";
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    return url === pageUrl
      ? new Response(pricingHtml, { headers: { "content-type": "text/html" } })
      : new Response("No fixture for this unrelated model", { status: 404 });
  });

  try {
    const defaults = getDefaultVideoBillingDimensions(modelId);
    for (const [resolution, baseTotalCost, totalCost] of [
      ["480P", 0.0625, 0.075],
      ["768P", 0.1, 0.12],
    ] as const) {
      const cost = await calculateVideoGenerationCostFromCatalog({
        model: modelId,
        billingSource: "fal",
        durationSeconds: 5,
        dimensions: { ...defaults.dimensions, resolution },
      });
      expect(cost.matchedEntry.provider).toBe("fal");
      expect(cost.matchedEntry.sourceUrl).toBe(pageUrl);
      expect(cost.baseTotalCost).toBeCloseTo(baseTotalCost, 6);
      expect(cost.totalCost).toBeCloseTo(totalCost, 6);
    }
  } finally {
    fetchSpy.mockRestore();
  }
});
