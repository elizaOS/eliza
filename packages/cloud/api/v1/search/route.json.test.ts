/** Verifies the hosted-search JSON boundary with deterministic auth and provider mocks. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const executeHostedGoogleSearch = mock(async () => ({ results: [] }));
const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
  apiKey: { id: "key-1" },
}));

mock.module("@/lib/auth", () => ({ requireAuthOrApiKeyWithOrg }));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {}, STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/services/google-search", () => ({
  executeHostedGoogleSearch,
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined, info: () => undefined },
}));

const { default: app } = await import("./route");

describe("POST /api/v1/search malformed JSON", () => {
  beforeEach(() => {
    executeHostedGoogleSearch.mockClear();
  });

  test("returns 400 instead of 500 and never searches", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(executeHostedGoogleSearch).not.toHaveBeenCalled();
  });

  test("preserves non-syntax request decoding failures as server errors", async () => {
    const originalJson = Request.prototype.json;
    Request.prototype.json = mock(async () => {
      throw new Error("request stream failed");
    }) as typeof Request.prototype.json;

    try {
      const response = await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "elizaos" }),
      });
      expect(response.status).toBe(500);
      expect(executeHostedGoogleSearch).not.toHaveBeenCalled();
    } finally {
      Request.prototype.json = originalJson;
    }
  });

  test("canonical JSON still runs hosted search", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "elizaos" }),
    });
    expect(response.status).toBe(200);
    expect(executeHostedGoogleSearch).toHaveBeenCalled();
  });
});
