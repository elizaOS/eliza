/**
 * Unit tests for the wallet market-overview shared domain helpers in
 * ./market-overview.ts: request construction, raw-row mapping/parsing,
 * stable-asset filtering, mover ranking, and per-coin price snapshots. The
 * assertions run entirely in-memory over fixture rows with no network or mocks.
 */
import { describe, expect, it } from "vitest";
import {
  buildCoinGeckoMarketsUrl,
  buildMarketMovers,
  buildMarketPriceSnapshots,
  COINGECKO_MARKET_LIMIT,
  type CoinGeckoMarketRecord,
  isStableAsset,
  MARKET_PRICE_IDS,
  mapCoinGeckoMarket,
  parseCoinGeckoMarkets,
} from "./market-overview.ts";

describe("wallet market-overview shared domain", () => {
  it("builds the CoinGecko markets request URL", () => {
    const url = buildCoinGeckoMarketsUrl();
    expect(url.origin + url.pathname).toBe(
      "https://api.coingecko.com/api/v3/coins/markets",
    );
    expect(url.searchParams.get("vs_currency")).toBe("usd");
    expect(url.searchParams.get("order")).toBe("market_cap_desc");
    expect(url.searchParams.get("per_page")).toBe(
      String(COINGECKO_MARKET_LIMIT),
    );
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("price_change_percentage")).toBe("24h");
  });

  it("maps and parses raw CoinGecko rows, dropping incomplete records", () => {
    const rows = [
      {
        id: "bitcoin",
        symbol: "btc",
        name: "Bitcoin",
        current_price: 60000,
        price_change_percentage_24h: 1.5,
        market_cap_rank: 1,
        image: "https://img/btc.png",
      },
      { id: "broken", symbol: "brk" }, // missing price/change → dropped
    ];
    const parsed = parseCoinGeckoMarkets(rows);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      id: "bitcoin",
      symbol: "BTC",
      name: "Bitcoin",
      currentPriceUsd: 60000,
      change24hPct: 1.5,
      marketCapRank: 1,
      imageUrl: "https://img/btc.png",
    });
    expect(mapCoinGeckoMarket(null)).toBeNull();
    expect(() => parseCoinGeckoMarkets({})).toThrow(
      "CoinGecko payload was not an array",
    );
  });

  it("rejects malformed numeric strings instead of parsing their prefix", () => {
    expect(
      mapCoinGeckoMarket({
        id: "bitcoin",
        symbol: "btc",
        name: "Bitcoin",
        current_price: "60000 USD",
        price_change_percentage_24h: "1.5%",
        market_cap_rank: "1st",
      }),
    ).toBeNull();
  });

  it("truncates fractional marketCapRank instead of rounding", () => {
    // CoinGecko occasionally returns rank as float string; must truncate not round
    expect(
      mapCoinGeckoMarket({
        id: "test",
        symbol: "tst",
        name: "Test",
        current_price: 10,
        price_change_percentage_24h: 5,
        market_cap_rank: "200.6",
      })?.marketCapRank,
    ).toBe(200);
    expect(
      mapCoinGeckoMarket({
        id: "test",
        symbol: "tst",
        name: "Test",
        current_price: 10,
        price_change_percentage_24h: 5,
        market_cap_rank: 200.6,
      })?.marketCapRank,
    ).toBe(200);
    expect(
      mapCoinGeckoMarket({
        id: "test",
        symbol: "tst",
        name: "Test",
        current_price: 10,
        price_change_percentage_24h: 5,
        market_cap_rank: "199.9",
      })?.marketCapRank,
    ).toBe(199);
    expect(
      mapCoinGeckoMarket({
        id: "test",
        symbol: "tst",
        name: "Test",
        current_price: 10,
        price_change_percentage_24h: 5,
        market_cap_rank: 199.9,
      })?.marketCapRank,
    ).toBe(199);
    // integer ranks unchanged
    expect(
      mapCoinGeckoMarket({
        id: "test",
        symbol: "tst",
        name: "Test",
        current_price: 10,
        price_change_percentage_24h: 5,
        market_cap_rank: 150,
      })?.marketCapRank,
    ).toBe(150);
    // mover cap: 200.6 truncated to 200 is within cap, 200.6 rounded to 201 would be excluded
    const record = (
      id: string,
      rank: number | null,
      change: number,
    ): CoinGeckoMarketRecord => ({
      id,
      symbol: id.toUpperCase(),
      name: id,
      currentPriceUsd: 10,
      change24hPct: change,
      marketCapRank: rank,
      imageUrl: null,
    });
    const markets = [record("a", 200, 10), record("b", 201, 20)];
    // also test via mapped fractional record that truncates into cap
    const fractional = mapCoinGeckoMarket({
      id: "c",
      symbol: "c",
      name: "C",
      current_price: 10,
      price_change_percentage_24h: 30,
      market_cap_rank: "200.6",
    });
    expect(fractional).not.toBeNull();
    if (!fractional) throw new Error("expected fractional market");
    expect(fractional.marketCapRank).toBe(200);
    const movers = buildMarketMovers([...markets, fractional]);
    expect(movers.map((m) => m.id)).toContain("c");
    expect(movers.map((m) => m.id)).not.toContain("b");
  });

  it("flags stablecoins by id or symbol", () => {
    const usdc: CoinGeckoMarketRecord = {
      id: "usd-coin",
      symbol: "USDC",
      name: "USD Coin",
      currentPriceUsd: 1,
      change24hPct: 0.01,
      marketCapRank: 5,
      imageUrl: null,
    };
    const eth: CoinGeckoMarketRecord = {
      ...usdc,
      id: "ethereum",
      symbol: "ETH",
    };
    expect(isStableAsset(usdc)).toBe(true);
    expect(isStableAsset(eth)).toBe(false);
  });

  it("ranks movers: excludes price coins + stablecoins + rank>200, sorts by |24h|, caps at 6", () => {
    const record = (
      id: string,
      symbol: string,
      change: number,
      rank: number | null,
    ): CoinGeckoMarketRecord => ({
      id,
      symbol,
      name: id,
      currentPriceUsd: 10,
      change24hPct: change,
      marketCapRank: rank,
      imageUrl: null,
    });

    const markets: CoinGeckoMarketRecord[] = [
      record("bitcoin", "BTC", 50, 1), // excluded: tracked price id
      record("usd-coin", "USDC", 40, 3), // excluded: stablecoin
      record("deep", "DEEP", 99, 500), // excluded: rank > 200
      record("aaa", "AAA", -30, 10),
      record("bbb", "BBB", 20, 20),
      record("ccc", "CCC", 45, 30),
      record("ddd", "DDD", 5, 40),
      record("eee", "EEE", -60, 50),
      record("fff", "FFF", 12, 60),
      record("ggg", "GGG", 8, 70),
      record("hhh", "HHH", 2, null), // null rank allowed
    ];

    const movers = buildMarketMovers(markets);
    expect(movers).toHaveLength(6);
    expect(movers.map((m) => m.id)).toEqual([
      "eee", // 60
      "ccc", // 45
      "aaa", // 30
      "bbb", // 20
      "fff", // 12
      "ggg", // 8
    ]);
  });

  it("builds price snapshots in MARKET_PRICE_IDS order, skipping absent coins", () => {
    expect(MARKET_PRICE_IDS).toEqual(["bitcoin", "ethereum", "solana"]);
    const markets: CoinGeckoMarketRecord[] = [
      {
        id: "solana",
        symbol: "SOL",
        name: "Solana",
        currentPriceUsd: 150,
        change24hPct: 3,
        marketCapRank: 6,
        imageUrl: null,
      },
      {
        id: "bitcoin",
        symbol: "BTC",
        name: "Bitcoin",
        currentPriceUsd: 60000,
        change24hPct: 1,
        marketCapRank: 1,
        imageUrl: null,
      },
    ];
    const snapshots = buildMarketPriceSnapshots(markets);
    // ethereum absent → skipped; ordering follows MARKET_PRICE_IDS not input.
    expect(snapshots.map((s) => s.id)).toEqual(["bitcoin", "solana"]);
    expect(snapshots[0].symbol).toBe("BTC");
  });
});
