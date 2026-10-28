/**
 * POST /api/v1/generate-music forwards `extraInput` to the provider as-is, so
 * it may not carry billed or screened fields. Real route; the caller check is
 * stubbed and the provider is never reached.
 */
import { expect, mock, test } from "bun:test";

process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

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
}));

const { Hono } = await import("hono");
const { default: musicRoute } = await import("../v1/generate-music/route");
const app = new Hono().route("/api/v1/generate-music", musicRoute);

const post = (body: unknown) =>
  app.request(
    "/api/v1/generate-music",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true" },
  );

test.each([
  ["a longer track", { music_length_ms: 600_000 }],
  ["an unscreened prompt", { prompt: "unscreened prompt" }],
  ["a composition plan", { composition_plan: { sections: [] } }],
])("refuses extraInput that sets %s", async (_label, extraInput) => {
  const response = await post({
    model: "elevenlabs/music_v1",
    prompt: "lofi",
    durationSeconds: 3,
    extraInput,
  });
  expect(response.status).toBe(400);
});
