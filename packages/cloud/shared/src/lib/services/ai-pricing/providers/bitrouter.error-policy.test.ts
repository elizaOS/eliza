// Pins the fail-closed transport contract of the BitRouter pricing-catalog fetch:
// a failed/unreachable provider fetch must PROPAGATE (so a broken price feed
// surfaces to the billing path) and stay DISTINCT from a legitimately-empty
// catalog, which resolves to the designed forced rows. Deterministic: global
// fetch and provider-env/openrouter/cache deps are mocked; no live network, no
// monetary-value assertions.
import { afterEach, describe, expect, it, mock } from "bun:test";

let providerKey: (name: string) => string | undefined = () => undefined;

mock.module("../../../providers/provider-env", () => ({
  getProviderKey: (name: string) => providerKey(name),
}));

// OpenRouter fallback rows are a separate best-effort source; stub to empty so
// this test isolates BitRouter's own transport behavior.
mock.module("./openrouter", () => ({
  fetchOpenRouterCatalogEntries: async () => [],
}));

// Pass the loader through untouched so the module-level catalog cache cannot
// leak positive/negative results across test cases.
mock.module("../cache", () => ({
  getCachedExternalEntries: async (_cacheKey: string, loader: () => Promise<unknown>) => loader(),
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchBitRouterCatalogEntries — fail-closed transport", () => {
  it("propagates a provider fetch failure instead of degrading to empty/stale success", async () => {
    providerKey = (name) => (name === "OPENROUTER_API_KEY" ? "test-key" : undefined);
    globalThis.fetch = mock(async () => new Response("upstream down", { status: 503 }));

    const { fetchBitRouterCatalogEntries } = await import("./bitrouter");

    await expect(fetchBitRouterCatalogEntries()).rejects.toThrow(/503/);
  });

  it("resolves (does not throw) for a legitimately-empty catalog — distinct from a fetch failure", async () => {
    providerKey = (name) => (name === "OPENROUTER_API_KEY" ? "test-key" : undefined);
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const { fetchBitRouterCatalogEntries } = await import("./bitrouter");

    const entries = await fetchBitRouterCatalogEntries();
    // An empty upstream catalog still yields the designed forced rows, proving an
    // empty result is a distinct, non-throwing outcome — not silently swallowed
    // failure. (Row count/values are fixed by the source; not asserted here.)
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("throws when the required provider credential is absent (config fail-closed)", async () => {
    providerKey = () => undefined;
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    const { fetchBitRouterCatalogEntries } = await import("./bitrouter");

    await expect(fetchBitRouterCatalogEntries()).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});
