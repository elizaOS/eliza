/**
 * Error-policy proof for the market-data proxy boundary (#13415). Drives the
 * real exported executeMarketDataProviderRequest with a mocked retryFetch so the
 * two kept J1 handlers are exercised for real: a transport failure must
 * PROPAGATE (fail closed, thrown) while an upstream HTTP error becomes a
 * distinguishable 502 error Response — never conflated with a success response,
 * and never swallowed into a fabricated default.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import * as realFetch from "../fetch";
import * as realPricing from "../pricing";

// bun's `mock.module` patches the process-global module registry, and this file
// only cleaned env in afterEach — it never reinstalled the modules stubbed
// below. Under the batched cloud-unit runner (`--isolate` occasionally fails to
// contain these on a memory-pressured runner) this `../fetch` (retryFetch)
// double otherwise bleeds into later sibling suites that drive the real
// transport (e.g. rpc/solana-rpc error-policy), whose `response.ok` then reads
// off an undefined mock result. Snapshot the real exports now and reinstall
// them in afterAll so this file's stubs are strictly local.
const realFetchExports = { ...realFetch };
const realPricingExports = { ...realPricing };

const retryFetch = mock();

// Only retryFetch is stubbed; getProxyConfig runs for real (env-defaulted) so
// the module builds the real request URL/opts around the mocked transport.
mock.module("../fetch", () => ({ retryFetch }));
// Pricing is only touched by marketDataConfig.getCost (unused here); stub it to
// keep the import graph deterministic and off the DB.
mock.module("../pricing", () => ({ getServiceMethodCost: async () => 1 }));

const { executeMarketDataProviderRequest } = await import("./market-data");

const OK_METHOD = {
  method: "getPrice",
  chain: "solana",
  params: { address: "So11111111111111111111111111111111111111112" },
} as const;

beforeEach(() => {
  retryFetch.mockReset();
  process.env.MARKET_DATA_PROVIDER_API_KEY = "test-provider-key";
});

afterEach(() => {
  delete process.env.MARKET_DATA_PROVIDER_API_KEY;
});

afterAll(() => {
  mock.module("../fetch", () => realFetchExports);
  mock.module("../pricing", () => realPricingExports);
});

describe("executeMarketDataProviderRequest error policy", () => {
  it("propagates a transport failure (fail closed — thrown, not swallowed into a default response)", async () => {
    retryFetch.mockRejectedValue(new Error("upstream connreset"));

    // A network/timeout failure is a broken pipeline: the catch logs context
    // and rethrows, so the failure surfaces to the caller rather than being
    // masked by an empty/default Response.
    await expect(executeMarketDataProviderRequest({ ...OK_METHOD })).rejects.toThrow(
      "upstream connreset",
    );
  });

  it("translates an upstream HTTP error into a distinguishable 502 error Response (not a fabricated success)", async () => {
    retryFetch.mockResolvedValue(new Response("provider boom", { status: 500 }));

    const res = await executeMarketDataProviderRequest({ ...OK_METHOD });

    expect(res.status).toBe(502);
    const parsed = (await res.json()) as { error: string; code: number };
    expect(parsed.error).toBe("Market data provider error");
    // The original upstream status is preserved, not zeroed/defaulted.
    expect(parsed.code).toBe(500);
  });

  it("returns the upstream success response verbatim — proving 502 is a distinct error state, not conflated with success", async () => {
    retryFetch.mockResolvedValue(Response.json({ price: 1.23 }, { status: 200 }));

    const res = await executeMarketDataProviderRequest({ ...OK_METHOD });

    expect(res.status).toBe(200);
    expect((await res.json()) as { price: number }).toEqual({ price: 1.23 });
  });

  it("throws when the provider API key is not configured (fail closed, no silent empty)", async () => {
    delete process.env.MARKET_DATA_PROVIDER_API_KEY;

    await expect(executeMarketDataProviderRequest({ ...OK_METHOD })).rejects.toThrow(
      "MARKET_DATA_PROVIDER_API_KEY not configured",
    );
    // The failing precondition short-circuits before any transport attempt.
    expect(retryFetch).not.toHaveBeenCalled();
  });

  it("throws on an unknown method rather than fabricating a request", async () => {
    await expect(
      executeMarketDataProviderRequest({
        method: "notARealMethod" as never,
        chain: "solana",
        params: {},
      }),
    ).rejects.toThrow(/Unknown market data method/);
    expect(retryFetch).not.toHaveBeenCalled();
  });
});
