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

  it("queries every address after the former twenty-token boundary", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requestedUrls.push(url);
        return new Response(JSON.stringify({ summary: { price_usd: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const addresses = Array.from({ length: 25 }, (_, index) => `0x${index}`);

    const results = await fetchDexPaprikaPrices(42161, addresses);

    expect(requestedUrls).toHaveLength(25);
    expect(requestedUrls.at(-1)).toContain("/tokens/0x24");
    expect(results.size).toBe(25);
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
describe("computeValueUsd edge guards", () => {
  it("handles whitespace, Infinity, and NaN inputs as zero", () => {
    expect(computeValueUsd(" 2 ", " 1.5 ")).toBe("3.00");
    expect(computeValueUsd("Infinity", "1")).toBe("0");
    expect(computeValueUsd("1", "Infinity")).toBe("0");
    expect(computeValueUsd("NaN", "1")).toBe("0");
    expect(computeValueUsd("1", "NaN")).toBe("0");
  });

  it("handles scientific notation and tiny balances", () => {
    expect(computeValueUsd("1e2", "1")).toBe("100.00");
    expect(computeValueUsd("0.0001", "10000")).toBe("1.00");
  });
});

describe("fetchDexScreenerPrices contracts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns empty for unsupported chain and empty addresses without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { fetchDexScreenerPrices } = await import("./wallet-dex-prices");
    expect((await fetchDexScreenerPrices(999, ["0xabc"])).size).toBe(0);
    expect((await fetchDexScreenerPrices(1, [])).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("selects highest liquidity price and preserves logoUrl", async () => {
    const { fetchDexScreenerPrices } = await import("./wallet-dex-prices");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([
        { baseToken: { address: "0xAbC" }, priceUsd: "1", liquidity: { usd: 100 }, info: { imageUrl: " https://logo " } },
        { baseToken: { address: "0xabc" }, priceUsd: "2", liquidity: { usd: 500 }, info: { imageUrl: "https://logo2" } },
        { baseToken: { address: "0xdef" }, priceUsd: null, liquidity: { usd: 999 } },
      ]), { status: 200 })),
    );
    const res = await fetchDexScreenerPrices(1, ["0xabc", "0xdef"]);
    expect(res.get("0xabc")?.price).toBe("2");
    expect(res.get("0xabc")?.logoUrl).toBe("https://logo2");
    expect(res.has("0xdef")).toBe(false);
  });

  it("batches requests in groups of 30", async () => {
    const { fetchDexScreenerPrices } = await import("./wallet-dex-prices");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify([]), { status: 200 });
    }));
    const addrs = Array.from({ length: 61 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
    await fetchDexScreenerPrices(1, addrs);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain("0x");
  });

  it("tolerates non-ok and non-array responses without throwing", async () => {
    const { fetchDexScreenerPrices } = await import("./wallet-dex-prices");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 500 })));
    await expect(fetchDexScreenerPrices(1, ["0xabc"])).resolves.toBeInstanceOf(Map);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ not: "array" }), { status: 200 })));
    await expect(fetchDexScreenerPrices(1, ["0xabc"])).resolves.toBeInstanceOf(Map);
  });
});

describe("fetchDexPrices fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("merges screener and paprika fallbacks for missing tokens", async () => {
    const { fetchDexPrices } = await import("./wallet-dex-prices");
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      call += 1;
      const url = String(input);
      if (url.includes("dexscreener")) {
        return new Response(JSON.stringify([{ baseToken: { address: "0xaaa" }, priceUsd: "10", liquidity: { usd: 100 } }]), { status: 200 });
      }
      return new Response(JSON.stringify({ summary: { price_usd: 20 } }), { status: 200 });
    }));
    const res = await fetchDexPrices(1, ["0xaaa", "0xbbb"]);
    expect(res.get("0xaaa")?.price).toBe("10");
    expect(res.get("0xbbb")?.price).toBe("20");
  });

  it("lowercases addresses and returns empty for empty input", async () => {
    const { fetchDexPrices } = await import("./wallet-dex-prices");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchDexPrices(1, [])).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
    const res = await fetchDexPrices(1, ["0xABC"]);
    expect([...res.keys()].every((k) => k === k.toLowerCase())).toBe(true);
  });
});

