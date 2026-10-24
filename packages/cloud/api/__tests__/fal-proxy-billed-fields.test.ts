/**
 * POST /api/fal/proxy forwards the provider body unchanged, so the quote must
 * follow the fields the provider reads. Real route; the caller check and the
 * catalog price are stubbed, and admission stops before the provider.
 */
import { beforeEach, expect, mock, test } from "bun:test";

process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const quotes: Array<{ durationSeconds: number; audio?: unknown }> = [];

const realAuth = {
  ...(await import("@/api-app/lib/generative-route-auth")),
};
mock.module("@/api-app/lib/generative-route-auth", () => ({
  ...realAuth,
  requireGenerativeRouteCaller: async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: null,
    admissionSnapshot: null,
    credential: null,
  }),
  admitFlatGenerativeOperation: async () => {
    throw new Error("stop before provider dispatch");
  },
}));

const realPricing = {
  ...(await import("@elizaos/cloud-shared/lib/services/ai-pricing")),
};
mock.module("@elizaos/cloud-shared/lib/services/ai-pricing", () => ({
  ...realPricing,
  calculateVideoGenerationCostFromCatalog: async (args: {
    durationSeconds: number;
    dimensions: { audio?: unknown };
  }) => {
    quotes.push({
      durationSeconds: args.durationSeconds,
      audio: args.dimensions.audio,
    });
    return { totalCost: args.durationSeconds * 0.112 };
  },
}));

const { Hono } = await import("hono");
const { default: falRoute } = await import("../fal/proxy/route");
const app = new Hono().route("/api/fal/proxy", falRoute);

const post = (body: unknown) =>
  app.request(
    "/api/fal/proxy",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-fal-target-url":
          "https://queue.fal.run/fal-ai/kling-video/v3/pro/text-to-video",
      },
      body: JSON.stringify(body),
    },
    { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true" },
  );

beforeEach(() => {
  quotes.length = 0;
});

test("quotes the provider duration", async () => {
  await post({ prompt: "x", duration: "10" });
  expect(quotes).toEqual([expect.objectContaining({ durationSeconds: 10 })]);
});

test("refuses a duration alias that disagrees with the provider field", async () => {
  const response = await post({
    prompt: "x",
    duration: "10",
    durationSeconds: 0.001,
  });
  expect(response.status).toBe(400);
  expect(quotes).toEqual([]);
});

test("an alias alone never lowers the quote below the default", async () => {
  await post({ prompt: "x", duration_seconds: 0.001 });
  expect(quotes).toHaveLength(1);
  expect(quotes[0].durationSeconds).toBeGreaterThanOrEqual(1);
});

test("refuses an unreadable provider duration", async () => {
  const response = await post({ prompt: "x", duration: "ten" });
  expect(response.status).toBe(400);
  expect(quotes).toEqual([]);
});

test("refuses an audio alias that disagrees with generate_audio", async () => {
  const response = await post({
    prompt: "x",
    duration: "5",
    audio: false,
    generate_audio: true,
  });
  expect(response.status).toBe(400);
  expect(quotes).toEqual([]);
});

test("quotes generate_audio when it is the only audio field", async () => {
  await post({ prompt: "x", duration: "5", generate_audio: true });
  expect(quotes).toEqual([expect.objectContaining({ audio: true })]);
});
