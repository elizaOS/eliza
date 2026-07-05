// Pins the fail-closed error policy of the Cerebras public-catalog pricing
// fetch: a transport (non-2xx) or JSON-parse failure must PROPAGATE out of
// fetchCerebrasPublicCatalogEntries — never be swallowed into an empty result
// that reads as "priced nothing". That distinction matters because the empty
// array is also the legitimate signal for a 200 catalog with zero priced
// models; the two must stay observably different so the gateway choke point can
// degrade a real outage while a genuinely-empty catalog just yields no entries.
// The module-level external cache is mocked to a pass-through so each case
// exercises the real loader (fetch + parse + build) without cross-test state;
// the cache's own negative-caching is covered by ../cache.test.ts.
import { afterEach, describe, expect, it, mock } from "bun:test";

mock.module("../cache", () => ({
  getCachedExternalEntries: async (
    _cacheKey: string,
    loader: () => Promise<unknown>,
  ): Promise<unknown> => loader(),
}));

const { fetchCerebrasPublicCatalogEntries } = await import("./cerebras");

const realFetch = globalThis.fetch;

type FetchReturn = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

function stubFetch(impl: () => FetchReturn): void {
  globalThis.fetch = (async () => impl()) as unknown as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchCerebrasPublicCatalogEntries — fail-closed error policy", () => {
  it("propagates a non-2xx catalog fetch (never swallows a 404 into empty)", async () => {
    stubFetch(() => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }));

    await expect(fetchCerebrasPublicCatalogEntries()).rejects.toThrow(/404/);
  });

  it("propagates a JSON parse failure instead of degrading to empty", async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("invalid json body");
      },
    }));

    await expect(fetchCerebrasPublicCatalogEntries()).rejects.toThrow("invalid json body");
  });

  it("returns [] for a legitimately-empty catalog — DISTINCT from a fetch failure", async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    }));

    const entries = await fetchCerebrasPublicCatalogEntries();
    expect(entries).toEqual([]);
  });

  it("returns [] when models carry no usable pricing — still not a failure", async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "gpt-oss-120b", pricing: {} }] }),
    }));

    const entries = await fetchCerebrasPublicCatalogEntries();
    expect(entries).toEqual([]);
  });

  it("maps a priced model into input+output entries on success", async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: "gpt-oss-120b", pricing: { prompt: "0.00005", completion: "0.0001" } }],
      }),
    }));

    const entries = await fetchCerebrasPublicCatalogEntries();

    // Success is observably distinct from the empty/failure cases: two charge
    // legs for the one model. We assert shape/identity only — not any monetary
    // value beyond the input→output leg split the source itself fixes.
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.model === "cerebras/gpt-oss-120b")).toBe(true);
    expect(entries.map((e) => e.chargeType).sort()).toEqual(["input", "output"]);
  });
});
