/** Verifies the hosted-search JSON boundary with deterministic auth and provider mocks. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  getGenerativeOperationContext,
  paidBoundaryState,
  requireGenerativeKnownIdentity,
  requireGenerativeRouteCaller,
  resetPaidBoundaryRouteMocks,
} from "../../__tests__/paid-boundary-route-test-mocks";

const executeHostedGoogleSearch = mock(
  async (
    _request: { query: string; maxResults?: number },
    _context: unknown,
  ) => ({ results: [] }),
);
mock.module("@/api-app/lib/generative-route-auth", () => ({
  getGenerativeOperationContext,
  requireGenerativeKnownIdentity,
  requireGenerativeRouteCaller,
}));
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
    resetPaidBoundaryRouteMocks();
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
    expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(1);
    expect(getGenerativeOperationContext).toHaveBeenCalledTimes(1);
  });

  test("standing denial performs one combined auth read and never dispatches search", async () => {
    paidBoundaryState.routeError = new Error("cached standing denied");
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "elizaos" }),
    });

    expect(response.status).toBe(500);
    expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(1);
    expect(getGenerativeOperationContext).not.toHaveBeenCalled();
    expect(executeHostedGoogleSearch).not.toHaveBeenCalled();
  });

  test("passes through an explicit result count above the former hidden cap", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "complete grounding", maxResults: 25 }),
    });
    expect(response.status).toBe(200);
    expect(executeHostedGoogleSearch.mock.calls[0]?.[0]).toMatchObject({
      query: "complete grounding",
      maxResults: 25,
    });
  });
});
