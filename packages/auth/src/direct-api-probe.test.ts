/**
 * Direct-provider probe tests exercise the real response parser with mocked
 * network transport, including catalog bounds and secret-free results.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  directProviderBaseUrl,
  probeDirectApiKey,
} from "./direct-api-probe.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.OPENROUTER_BASE_URL;
  delete process.env.XAI_BASE_URL;
});

describe("direct provider authority", () => {
  it("uses canonical OpenRouter and xAI catalog endpoints", () => {
    expect(directProviderBaseUrl("openrouter-api")).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(directProviderBaseUrl("xai-api")).toBe("https://api.x.ai/v1");
  });

  it("returns a bounded, deduplicated model catalog without the credential", async () => {
    const models = Array.from({ length: 120 }, (_, index) => ({
      id: `vendor/model-${index}`,
    }));
    models.push({ id: "vendor/model-0" });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Authorization: "Bearer secret-value" });
      return new Response(JSON.stringify({ data: models }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await probeDirectApiKey("openrouter-api", "secret-value");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.modelIds).toHaveLength(100);
    expect(result.modelCatalogTruncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("bounds catalog response bytes while preserving authenticated health", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("x".repeat(1_048_577), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(probeDirectApiKey("xai-api", "secret-value")).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        status: 200,
        modelCatalogTruncated: true,
      }),
    );
  });

  it("never reflects a provider failure body that could echo a secret", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("diagnostic echoed secret-value", { status: 401 }),
    ) as unknown as typeof fetch;

    const result = await probeDirectApiKey("openrouter-api", "secret-value");

    expect(result).toEqual({
      ok: false,
      status: 401,
      error: "openrouter-api credential probe failed (HTTP 401)",
      latencyMs: expect.any(Number),
    });
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });
});
