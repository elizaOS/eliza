import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import plugin from "../src/index.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TOLL_ADDRESS = "0x13dDE704389b1118B20d2BCc6D3Ace749600e2ad";
const USDC         = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH         = "0x4200000000000000000000000000000000000006";

const PROBE_BODY = {
  status: "payment_required",
  tiers: {
    basic:         { min_atomic: "30000",  min_usdc: 0.03 },
    resilient:     { min_atomic: "100000", min_usdc: 0.10 },
    institutional: { min_atomic: "500000", min_usdc: 0.50 },
  },
};

const QUOTE_BODY = {
  request_id:       "a1b2c3d4-0000-0000-0000-000000000001",
  sellToken:        USDC,
  buyToken:         WETH,
  sellAmount:       "1000000",
  buyAmount:        "449123456789012",
  price:            "0.000449",
  sources:          [{ name: "Native_V2", proportion: "1" }],
  routingEngine:    "0x",
  tier:             "basic",
  routing_metadata: { execution_mode: "direct", winner: "0x" },
};

// ── Plugin shape ──────────────────────────────────────────────────────────────

describe("plugin-ezpath", () => {
  it("exports a plugin with the correct name", () => {
    expect(plugin.name).toBe("plugin-ezpath");
  });

  it("registers at least one action", () => {
    expect(Array.isArray(plugin.actions)).toBe(true);
    expect(plugin.actions!.length).toBeGreaterThan(0);
  });

  it("includes GET_SWAP_QUOTE action", () => {
    const names = plugin.actions!.map(a => a.name);
    expect(names).toContain("GET_SWAP_QUOTE");
  });

  it("GET_SWAP_QUOTE action has a handler", () => {
    const action = plugin.actions!.find(a => a.name === "GET_SWAP_QUOTE");
    expect(typeof action?.handler).toBe("function");
  });
});

// ── X402 client ───────────────────────────────────────────────────────────────

describe("getQuote client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns quote result on successful X402 negotiation", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce({
        status:  402,
        ok:      false,
        headers: { get: (k: string) => k === "X-402-Address" ? TOLL_ADDRESS : null },
        json:    () => Promise.resolve(PROBE_BODY),
      } as unknown as Response)
      .mockResolvedValueOnce({
        status:  200,
        ok:      true,
        headers: { get: (k: string) => k === "X-Settlement-Tx" ? "0xabc123" : null },
        json:    () => Promise.resolve(QUOTE_BODY),
      } as unknown as Response);

    const { getQuote } = await import("../src/client.js");

    const result = await getQuote({
      sellToken:  USDC,
      buyToken:   WETH,
      sellAmount: "1000000",
      tier:       "basic",
      // use a known test key — no real funds used, fetch is mocked
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    });

    expect(result.buyAmount).toBe("449123456789012");
    expect(result.price).toBe("0.000449");
    expect(result.tier).toBe("basic");
    expect(result.settlement_tx).toBe("0xabc123");
  });

  it("throws if probe returns non-402", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      status:  500,
      ok:      false,
      headers: { get: () => null },
      json:    () => Promise.resolve({}),
    } as unknown as Response);

    const { getQuote } = await import("../src/client.js");

    await expect(
      getQuote({
        sellToken:  USDC,
        buyToken:   WETH,
        sellAmount: "1000000",
        tier:       "basic",
        privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      }),
    ).rejects.toThrow("expected 402 negotiation response");
  });
});
