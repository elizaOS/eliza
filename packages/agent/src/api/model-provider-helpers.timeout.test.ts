/**
 * Model-catalog transport deadline tests cover every remote provider fetch,
 * fresh signals per request, and real response-body cancellation.
 */

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL_CATALOG_FETCH_TIMEOUT_MS,
  fetchAnthropicModels,
  fetchGoogleModels,
  fetchModelsREST,
  fetchNearAIModels,
  fetchOpenRouterModels,
} from "./model-provider-helpers.ts";

describe("model catalog fetch deadlines", () => {
  let originalTimeout: typeof AbortSignal.timeout;

  beforeEach(() => {
    originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("exposes the documented ten-second budget", () => {
    expect(DEFAULT_MODEL_CATALOG_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("installs a fresh deadline on every provider request and retry", async () => {
    const signals: AbortSignal[] = [];
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((milliseconds) => {
        expect(milliseconds).toBe(DEFAULT_MODEL_CATALOG_FETCH_TIMEOUT_MS);
        const signal = originalTimeout(60_000);
        signals.push(signal);
        return signal;
      });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(new Response(JSON.stringify({ data: [], models: [] }))),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchModelsREST("openai", "key", "https://api.openai.test/v1");
    await fetchAnthropicModels("key");
    await fetchGoogleModels("key");
    await fetchOpenRouterModels("key");
    await fetchNearAIModels("key", "https://cloud-api.near.test/v1");
    await fetchModelsREST("openai", "key", "https://api.openai.test/v1");

    expect(timeoutSpy).toHaveBeenCalledTimes(7);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(new Set(signals).size).toBe(7);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual(
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    }
  });

  it("aborts a provider whose response headers never arrive", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      originalTimeout(10),
    );
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error("model catalog signal missing");
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchModelsREST("openai", "key", "https://api.openai.test/v1"),
    ).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.test/v1/models",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps the deadline armed while the response body stalls", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"data": [');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as import("node:net").AddressInfo;
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      originalTimeout(10),
    );

    try {
      await expect(
        fetchModelsREST("openai", "key", `http://127.0.0.1:${address.port}/v1`),
      ).resolves.toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
