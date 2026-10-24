/**
 * The public predictions preview decodes Polymarket's JSON-encoded `outcomes`
 * and `outcomePrices` strings. That decode swallowed every `JSON.parse` error
 * and returned `[]`, so a corrupt payload published the market with an empty
 * outcome list, which the preview renders as `{ label: "Top", probability:
 * null }` — the same shape as a healthy market with an unknown outcome. The
 * endpoint returned 200 for a body it could not decode at all.
 *
 * A field that is absent (or an empty string) still means "no data" and keeps
 * yielding `[]`; only a present-but-undecodable field now fails the request.
 */

import { afterEach, describe, expect, it } from "bun:test";

const MARKET = {
  slug: "rain-tomorrow",
  question: "Will it rain tomorrow?",
  volume24hr: 1200,
  volume: 5000,
  endDate: "2026-11-01T00:00:00Z",
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.62","0.38"]',
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubPolymarketPayload(payload: unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes("polymarket")) {
      throw new Error(`unexpected fetch to ${url}`);
    }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

type MarketPreviewModule = typeof import("./market-preview");

/** Each case needs a fresh module instance: the service caches the response. */
async function loadService(cacheKey: string): Promise<MarketPreviewModule> {
  return (await import(`./market-preview.ts?case=${cacheKey}`)) as MarketPreviewModule;
}

describe("prediction preview payload decoding", () => {
  it("rejects a market whose outcomes field is not JSON", async () => {
    stubPolymarketPayload([{ ...MARKET, outcomes: "[Yes,No" }]);
    const { loadPublicPredictionPreview } = await loadService("bad-outcomes");

    await expect(loadPublicPredictionPreview()).rejects.toThrow(/outcomes/);
  });

  it("rejects a market whose outcomePrices field is not a JSON array", async () => {
    stubPolymarketPayload([{ ...MARKET, outcomePrices: '{"yes":0.62}' }]);
    const { loadPublicPredictionPreview } = await loadService("bad-prices");

    await expect(loadPublicPredictionPreview()).rejects.toThrow(/outcomePrices/);
  });

  it("keeps publishing a market that omits outcomes and prices", async () => {
    stubPolymarketPayload([{ slug: "no-outcomes", question: "Will it snow?", volume24hr: 900 }]);
    const { loadPublicPredictionPreview } = await loadService("absent-fields");

    const preview = await loadPublicPredictionPreview();

    expect(preview.predictions).toHaveLength(1);
    expect(preview.predictions[0]).toMatchObject({
      question: "Will it snow?",
      highlightedOutcomeLabel: "Top",
      highlightedOutcomeProbability: null,
    });
    expect(preview.source.available).toBe(true);
  });

  it("publishes decoded outcomes and prices for a healthy payload", async () => {
    stubPolymarketPayload([MARKET]);
    const { loadPublicPredictionPreview } = await loadService("healthy");

    const preview = await loadPublicPredictionPreview();

    expect(preview.predictions[0]).toMatchObject({
      question: "Will it rain tomorrow?",
      highlightedOutcomeLabel: "Yes",
      highlightedOutcomeProbability: 0.62,
    });
    expect(preview.source.error).toBeNull();
  });
});
