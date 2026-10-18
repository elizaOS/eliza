import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  __resetPublicMarketPreviewCacheForTests,
  loadPublicPredictionPreview,
} from "./market-preview";

const originalFetch = globalThis.fetch;

function polymarketPayload(markets: unknown[]): Response {
  return new Response(JSON.stringify(markets), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubPolymarket(markets: unknown[]): void {
  globalThis.fetch = (async () => polymarketPayload(markets)) as unknown as typeof fetch;
}

beforeEach(() => {
  __resetPublicMarketPreviewCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetPublicMarketPreviewCacheForTests();
});

describe("Polymarket outcome decoding", () => {
  it("rejects when a market outcomes field is corrupted JSON", async () => {
    stubPolymarket([
      {
        slug: "will-it-rain-tomorrow",
        question: "Will it rain tomorrow?",
        outcomes: '["Yes", "No"',
        outcomePrices: '["0.61", "0.39"]',
        volume24hr: 125000,
      },
    ]);

    // A truncated outcomes payload is corrupted upstream data. Publishing a
    // prediction with a placeholder label and a null probability would make
    // the route report an empty-looking but successful preview.
    await expect(loadPublicPredictionPreview()).rejects.toThrow(/outcomes/);
  });

  it("rejects when a market outcomePrices field is corrupted JSON", async () => {
    stubPolymarket([
      {
        slug: "will-it-snow-tomorrow",
        question: "Will it snow tomorrow?",
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.12", "0.88"',
        volume24hr: 42000,
      },
    ]);

    await expect(loadPublicPredictionPreview()).rejects.toThrow(/outcomePrices/);
  });

  it("decodes well-formed JSON string arrays", async () => {
    stubPolymarket([
      {
        slug: "will-it-rain-tomorrow",
        question: "Will it rain tomorrow?",
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.61", "0.39"]',
        volume24hr: 125000,
      },
    ]);

    const preview = await loadPublicPredictionPreview();

    expect(preview.predictions).toHaveLength(1);
    expect(preview.predictions[0]?.highlightedOutcomeLabel).toBe("Yes");
    expect(preview.predictions[0]?.highlightedOutcomeProbability).toBe(0.61);
  });

  it("keeps markets whose outcome fields are absent", async () => {
    stubPolymarket([
      {
        slug: "no-outcome-fields",
        question: "Market without outcome fields?",
        volume24hr: 900,
      },
    ]);

    const preview = await loadPublicPredictionPreview();

    expect(preview.predictions).toHaveLength(1);
    expect(preview.predictions[0]?.highlightedOutcomeLabel).toBe("Top");
    expect(preview.predictions[0]?.highlightedOutcomeProbability).toBeNull();
  });
});
