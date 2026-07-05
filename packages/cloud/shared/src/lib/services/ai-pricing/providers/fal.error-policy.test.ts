/**
 * Error-policy tests for the fal pricing-catalog fetcher (#13415). This is a
 * BILLING/pricing-metadata path: fal model prices feed inference billing. The
 * error handling here is a MONEY-PATH decision, not slop — when the live fal
 * model-page fetch/parse fails, fetchFalCatalogEntries degrades to the LAST-GOOD
 * active DB price for that model rather than propagating (a "best-effort
 * price-cache-refresh falls back to last-good cached price" — money-path-flagged,
 * left unchanged). These tests PIN that behavior: a fetch failure surfaces the
 * last-good price (soft-degrade, no throw), and — critically — a fetch failure
 * with NO cached price yields an EMPTY contribution for that model, which stays
 * DISTINCT from a fabricated/zero price. The parse functions still fail closed
 * (throw) on unparseable input. fetch/cache/repository/snapshot deps are mocked;
 * the real fetchFalCatalogEntries + parseFalPricingEntries logic runs unmocked.
 * No monetary value is asserted beyond the sentinel the DB mock supplies.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { PreparedPricingEntry } from "../types";

// One fal video model drives the loop; empty image list keeps the snapshot
// contributions out of the assertion so only the fetch-failure path shows.
const FAL_VIDEO_MODEL = {
  modelId: "fal-ai/veo3/text-to-video",
  billingSource: "fal" as const,
  pageUrl: "https://fal.ai/models/fal-ai/veo3",
  pricingParser: "veo" as const,
};

// Mutable per-test seams (bun's mock.module has no per-call reset helper).
let fetchTextImpl: (url: string) => Promise<string>;
let listActiveImpl: () => Promise<PreparedPricingEntry[]>;

mock.module("../../ai-pricing-definitions", () => ({
  SUPPORTED_VIDEO_MODELS: [FAL_VIDEO_MODEL],
  SUPPORTED_IMAGE_MODELS: [],
}));

mock.module("../fetch", () => ({
  fetchText: (url: string) => fetchTextImpl(url),
  stripHtml: (value: string) => value,
  fetchJson: () => {
    throw new Error("fetchJson not stubbed in error-policy test");
  },
}));

mock.module("../cache", () => ({
  // Bypass the TTL cache so every case drives the loader fresh.
  getCachedExternalEntries: (_key: string, loader: () => Promise<PreparedPricingEntry[]>) =>
    loader(),
}));

mock.module("../../../../db/repositories/ai-pricing", () => ({
  aiPricingRepository: {
    listActiveEntries: () => listActiveImpl(),
  },
}));

// aiEntryToPrepared echoes the DB row so the test never depends on mapper
// internals; the DB sentinel IS a PreparedPricingEntry.
mock.module("../dimensions", () => ({
  aiEntryToPrepared: (entry: PreparedPricingEntry) => entry,
}));

mock.module("./sfx", () => ({ buildSfxSnapshotEntries: () => [] }));
mock.module("./suno", () => ({ buildMusicSnapshotEntries: () => [] }));

const LAST_GOOD_DB_PRICE: PreparedPricingEntry = {
  billingSource: "fal",
  provider: "fal",
  model: FAL_VIDEO_MODEL.modelId,
  productFamily: "video",
  chargeType: "generation",
  unit: "second",
  unitPrice: 0.5,
  sourceKind: "fal_model_page",
  sourceUrl: FAL_VIDEO_MODEL.pageUrl,
};

describe("fetchFalCatalogEntries — error policy (#13415, money-path-flagged)", () => {
  afterEach(() => {
    mock.restore();
  });

  it("degrades a live fetch failure to the last-good DB price (soft-degrade, does NOT throw or propagate)", async () => {
    const { fetchFalCatalogEntries } = await import("./fal");
    fetchTextImpl = async () => {
      throw new Error("Request failed for https://fal.ai/models/fal-ai/veo3: 503");
    };
    listActiveImpl = async () => [LAST_GOOD_DB_PRICE];

    const result = await fetchFalCatalogEntries();

    // Money-path decision: the last-good cached price surfaces instead of the
    // fetch error killing the pricing lookup.
    expect(result).toEqual([LAST_GOOD_DB_PRICE]);
  });

  it("yields an EMPTY contribution when the fetch fails and no cached price exists — distinct from a fabricated price", async () => {
    const { fetchFalCatalogEntries } = await import("./fal");
    fetchTextImpl = async () => {
      throw new Error("Request failed for https://fal.ai/models/fal-ai/veo3: 503");
    };
    listActiveImpl = async () => [];

    const result = await fetchFalCatalogEntries();

    // No last-good price and no fabricated one: the model simply contributes
    // nothing (empty), which the pricing lookup treats as "price absent" — NOT a
    // zero/marker price masquerading as a real value.
    expect(result).toEqual([]);
    expect(result.some((entry) => entry.model === FAL_VIDEO_MODEL.modelId)).toBe(false);
  });

  it("parseFalPricingEntries fails closed (throws) on an unparseable pricing paragraph", async () => {
    const { parseFalPricingEntries } = await import("./fal");

    expect(() =>
      parseFalPricingEntries(
        FAL_VIDEO_MODEL as never,
        "this paragraph contains no recognizable dollar pricing",
      ),
    ).toThrow(/Unable to parse Veo pricing paragraph/);
  });
});
