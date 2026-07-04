/**
 * Regression (#11785): the generate-video route prices Atlas Cloud (Vidu) models
 * by resolving a `video:generation` pricing row against the EXACT requested
 * dimensions the route builds. The Atlas snapshot originally seeded each entry
 * with `dimensions: model.defaultParameters` — which includes `durationSeconds`.
 * But the route never injects `durationSeconds` into requested dimensions for the
 * `atlascloud_snapshot` parser (see getDefaultVideoBillingDimensions), so
 * `dimensionsAreSubset(candidate, requested)` ALWAYS failed → "Pricing
 * unavailable" → every Atlas video charge threw. Vidu pricing was also flat, not
 * per-resolution, so a 1080p render under-billed against a 720p rate.
 *
 * This drives the SAME resolution function the route uses
 * (`calculateVideoGenerationCostFromCatalog`) with route-shaped requested
 * dimensions, and asserts a concrete positive cost per resolution. The persisted
 * repo is mocked empty so resolution falls through to the live catalog seam; the
 * gateway seam is pinned to route the `atlascloud` source through the real Atlas
 * catalog builder (the code under test) so the test is deterministic regardless
 * of bun's single-process cross-file mock ordering. No external key or network
 * is needed.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import { fetchAtlasCloudCatalogEntries } from "./providers/atlascloud";
import type { PreparedPricingEntry } from "./types";

mock.module("../../../db/repositories/ai-pricing", () => ({
  aiPricingRepository: {
    listActiveEntriesForProviderModelPairs: async () => [],
    listActiveEntries: async () => [],
  },
}));
// Pin the live catalog seam to the real Atlas builder for the atlascloud source
// (mirrors gateway.ts's own routing). Other test files in the same bun process
// may globally mock this module to `() => []`; pinning it here keeps this test's
// live-catalog resolution deterministic.
mock.module("./providers/gateway", () => ({
  fetchEntriesForSource: async (source: string): Promise<PreparedPricingEntry[]> =>
    source === "atlascloud" ? await fetchAtlasCloudCatalogEntries() : [],
}));

const { calculateVideoGenerationCostFromCatalog, getDefaultVideoBillingDimensions } = await import(
  "./lookup"
);
const { __clearPersistedPricingCache } = await import("./cache");

beforeEach(() => {
  __clearPersistedPricingCache();
});

/**
 * Reproduce the exact requested-dimension shape the generate-video route emits,
 * so the test resolves pricing through the identical dimension-subset path.
 */
function routeRequestedDimensions(
  model: string,
  overrides: { resolution?: string; audio?: boolean },
): Record<string, string | number | boolean> {
  const defaults = getDefaultVideoBillingDimensions(model);
  return {
    ...defaults.dimensions,
    ...(overrides.resolution !== undefined ? { resolution: overrides.resolution } : {}),
    ...(overrides.audio !== undefined ? { audio: overrides.audio } : {}),
    ...(defaults.dimensions.durationSeconds !== undefined
      ? { durationSeconds: defaults.durationSeconds }
      : {}),
  };
}

const MARKUP = 1.2; // PLATFORM_MARKUP_MULTIPLIER (20% platform markup)
const Q3_TURBO = "vidu/q3-turbo/text-to-video";
const I2V = "vidu/image-to-video-2.0";

test("Vidu q3-turbo default request (720p, audio off, 5s) resolves to $0.06/s → $0.30 pre-markup", async () => {
  const durationSeconds = 5;
  const cost = await calculateVideoGenerationCostFromCatalog({
    model: Q3_TURBO,
    billingSource: "atlascloud",
    durationSeconds,
    dimensions: routeRequestedDimensions(Q3_TURBO, {}),
  });

  // 720p is q3-turbo's default resolution.
  expect(cost.matchedEntry.unitPrice).toBe(0.06);
  expect(cost.matchedEntry.dimensions).toEqual({ audio: false, resolution: "720p" });
  expect(cost.baseTotalCost).toBe(0.3); // $0.06/s × 5s
  expect(cost.totalCost).toBe(0.36); // × 1.2 markup
  expect(cost.baseTotalCost).toBe(0.06 * durationSeconds);
  expect(cost.totalCost).toBeCloseTo(0.06 * durationSeconds * MARKUP, 6);
});

test("Vidu q3-turbo prices per resolution: 540p→$0.04/s, 720p→$0.06/s, 1080p→$0.08/s", async () => {
  const durationSeconds = 5;
  const expected: Record<string, number> = {
    "540p": 0.04,
    "720p": 0.06,
    "1080p": 0.08,
  };

  for (const [resolution, unitPrice] of Object.entries(expected)) {
    const cost = await calculateVideoGenerationCostFromCatalog({
      model: Q3_TURBO,
      billingSource: "atlascloud",
      durationSeconds,
      dimensions: routeRequestedDimensions(Q3_TURBO, { resolution }),
    });

    expect(cost.matchedEntry.unitPrice).toBe(unitPrice);
    expect(cost.matchedEntry.dimensions).toEqual({ audio: false, resolution });
    expect(cost.baseTotalCost).toBe(unitPrice * durationSeconds);
    expect(cost.totalCost).toBeCloseTo(unitPrice * durationSeconds * MARKUP, 6);
  }
});

test("Vidu image-to-video-2.0 stays $0.075/s and resolves at every supported resolution", async () => {
  const durationSeconds = 4; // image-to-video-2.0's default duration
  for (const resolution of ["540p", "720p", "1080p"]) {
    const cost = await calculateVideoGenerationCostFromCatalog({
      model: I2V,
      billingSource: "atlascloud",
      durationSeconds,
      dimensions: routeRequestedDimensions(I2V, { resolution }),
    });

    expect(cost.matchedEntry.unitPrice).toBe(0.075);
    expect(cost.matchedEntry.dimensions).toEqual({ audio: false, resolution });
    expect(cost.baseTotalCost).toBe(0.075 * durationSeconds);
    expect(cost.totalCost).toBeCloseTo(0.075 * durationSeconds * MARKUP, 6);
  }
});
