/**
 * A provider that answers the model-catalog request with an error status (401
 * expired key, 429 rate limit, 5xx) must not be reported as "this provider has
 * no models": callers of the models route cannot tell `{models: []}` apart from
 * an empty catalog. Only an unreachable provider stays an empty catalog.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAnthropicModels,
  fetchGoogleModels,
  fetchNearAIModels,
  ModelCatalogFetchError,
} from "../src/api/model-provider-helpers.ts";

function stubHttpStatus(status: number): void {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ error: "invalid_api_key" }), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider model catalog HTTP rejections", () => {
  it("rejects with the provider's status when Anthropic answers 401", async () => {
    stubHttpStatus(401);
    const failure = fetchAnthropicModels("expired-key");
    await expect(failure).rejects.toBeInstanceOf(ModelCatalogFetchError);
    await expect(failure).rejects.toMatchObject({
      providerId: "anthropic",
      upstreamStatus: 401,
      code: "MODEL_CATALOG_FETCH_FAILED",
    });
  });

  it("rejects with the provider's status when Google answers 429", async () => {
    stubHttpStatus(429);
    await expect(fetchGoogleModels("rate-limited-key")).rejects.toMatchObject({
      providerId: "google-genai",
      upstreamStatus: 429,
    });
  });

  it("rejects with the provider's status when NEAR AI answers 503", async () => {
    stubHttpStatus(503);
    await expect(
      fetchNearAIModels("key", "http://127.0.0.1:1/v1"),
    ).rejects.toMatchObject({
      providerId: "nearai",
      upstreamStatus: 503,
    });
  });

  it("keeps an unreachable provider an empty catalog", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(fetchAnthropicModels("key")).resolves.toEqual([]);
  });
});
