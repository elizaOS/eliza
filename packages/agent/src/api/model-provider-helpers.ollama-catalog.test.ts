import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchOllamaModels,
  ModelCatalogFetchError,
} from "./model-provider-helpers.ts";

/**
 * `fetchOllamaModels` is the only catalog fetch in this module that answered a
 * non-OK upstream status with `[]`. Every sibling (anthropic, google-genai,
 * nearai, fetchModelsREST) throws `ModelCatalogFetchError`, and the module's
 * own error policy at those catch blocks states that "a provider that answered
 * with an error status stays a typed catalog failure for the HTTP boundary
 * (models-routes.ts)". A configured-but-broken Ollama endpoint therefore
 * reported "no models installed" instead of "the catalog could not be read".
 */
describe("fetchOllamaModels catalog status", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects with ModelCatalogFetchError when the endpoint answers a non-OK status", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchOllamaModels("http://gpu-box:11434")).rejects.toBeInstanceOf(
      ModelCatalogFetchError,
    );
  });

  it("keeps an unreachable localhost probe as an explicit empty catalog", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchOllamaModels("http://localhost:11434")).resolves.toEqual([]);
  });
});
