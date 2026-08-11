/**
 * Tests for the wallet USD value math (#8801 / #9943) and the DexPaprika
 * fallback path (#17691): correct network slugs and summary.price_usd extraction.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeValueUsd,
  DEXPAPRIKA_CHAIN_MAP,
  fetchDexPaprikaPrices,
} from "./wallet-dex-prices";

describe("computeValueUsd", () => {
  it("multiplies balance by price to two decimals", () => {
    expect(computeValueUsd("2", "1.50")).toBe("3.00");
    expect(computeValueUsd("0.5", "100")).toBe("50.00");
    expect(computeValueUsd("1000000", "1.23")).toBe("1230000.00");
  });

  it("rounds to cents", () => {
    expect(computeValueUsd("1", "0.126")).toBe("0.13"); // up
    expect(computeValueUsd("1", "0.124")).toBe("0.12"); // down
    expect(computeValueUsd("3", "0.333")).toBe("1.00"); // 0.999 -> 1.00
  });

  it("returns '0' for a non-positive balance or price", () => {
    expect(computeValueUsd("0", "100")).toBe("0");
    expect(computeValueUsd("2", "0")).toBe("0");
    expect(computeValueUsd("-5", "1")).toBe("0");
    expect(computeValueUsd("1", "-1")).toBe("0");
  });

  it("returns '0' for unparseable input", () => {
    expect(computeValueUsd("abc", "1")).toBe("0");
    expect(computeValueUsd("1", "")).toBe("0");
    expect(computeValueUsd("", "")).toBe("0");
  });
});

describe("DEXPAPRIKA_CHAIN_MAP", () => {
  it("uses live DexPaprika network slugs for Arbitrum and Polygon", () => {
    expect(DEXPAPRIKA_CHAIN_MAP[42161]).toBe("arbitrum");
    expect(DEXPAPRIKA_CHAIN_MAP[137]).toBe("polygon");
  });
});

describe("fetchDexPaprikaPrices", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads price from summary.price_usd and builds the correct network URL", async () => {
    let requestedUrl: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          id: "0xAbC",
          summary: { price_usd: 1879.41, liquidity_usd: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await fetchDexPaprikaPrices(42161, ["0xAbC"]);
    expect(requestedUrl).toBe(
      "https://api.dexpaprika.com/networks/arbitrum/tokens/0xAbC",
    );
    expect(results.get("0xabc")?.price).toBe("1879.41");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing summary", { id: "0xdef", price_usd: 99 }],
    ["zero price", { id: "0xdef", summary: { price_usd: 0 } }],
    ["unparseable price", { id: "0xdef", summary: { price_usd: "invalid" } }],
  ])("returns empty for %s", async (_case, payload) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const results = await fetchDexPaprikaPrices(137, ["0xdef"]);
    expect(results.size).toBe(0);
  });

  it("returns empty for unsupported chain ids", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const results = await fetchDexPaprikaPrices(999, ["0xabc"]);
    expect(results.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
