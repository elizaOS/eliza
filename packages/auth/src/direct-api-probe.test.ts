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

  it("returns the complete deduplicated model catalog without the credential", async () => {
    const models = Array.from({ length: 120 }, (_, index) => ({
      id: `vendor/model-${index}`,
    }));
    models.push({ id: "vendor/model-0" });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/key")) {
        expect(init?.headers).toEqual({ Authorization: "Bearer secret-value" });
        return new Response(JSON.stringify({ data: { limit: 10 } }), {
          status: 200,
        });
      }
      expect(init?.headers).toBeUndefined();
      return new Response(JSON.stringify({ data: models }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await probeDirectApiKey("openrouter-api", "secret-value");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/key",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.modelIds).toHaveLength(120);
    expect(result.modelIds).toContain("vendor/model-119");
    expect(result.modelCatalogTruncated).toBeUndefined();
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

  it("rejects an invalid OpenRouter key before reading the public catalog", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/key")) {
        return new Response("invalid secret-value", { status: 401 });
      }
      return new Response(JSON.stringify({ data: [{ id: "public/model" }] }), {
        status: 200,
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await probeDirectApiKey("openrouter-api", "secret-value");

    expect(result).toEqual({
      ok: false,
      status: 401,
      error: "openrouter-api credential probe failed (HTTP 401)",
      latencyMs: expect.any(Number),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/key",
      expect.objectContaining({ method: "GET" }),
    );
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("keeps an authenticated OpenRouter key healthy when public catalog metadata fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/key")) {
        return new Response(JSON.stringify({ data: { limit: 10 } }), {
          status: 200,
        });
      }
      return new Response("catalog unavailable", { status: 503 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      probeDirectApiKey("openrouter-api", "secret-value"),
    ).resolves.toEqual({
      ok: true,
      status: 200,
      latencyMs: expect.any(Number),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
