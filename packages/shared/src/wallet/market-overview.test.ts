/**
 * Unit tests for the wallet market-overview shared domain helpers in
 * ./market-overview.ts: the stablecoin id/symbol filter sets, the
 * CoinGecko/Polymarket provider metadata, the CoinGecko markets request URL,
 * raw-row mapping/parsing (dropping incomplete records), mover ranking, and
 * per-coin price snapshots. Assertions run entirely in-memory over fixture
 * rows with no network or mocks, pinning the domain data so the Cloud
 * market-preview service and the iOS agent kernel fallback cannot drift.
 */
import { describe, expect, it } from "vitest";
import {
  buildCoinGeckoMarketsUrl,
  buildMarketMovers,
  buildMarketPriceSnapshots,
  COINGECKO_MARKET_LIMIT,
  COINGECKO_MARKET_PROVIDER,
  type CoinGeckoMarketRecord,
  isStableAsset,
  MARKET_PRICE_IDS,
  mapCoinGeckoMarket,
  POLYMARKET_MARKET_PROVIDER,
  parseCoinGeckoMarkets,
  STABLE_ASSET_IDS,
  STABLE_ASSET_SYMBOLS,
} from "./market-overview.ts";

/**
 * These assertions pin the wallet market-overview domain data shared by the
 * Eliza Cloud market-preview service and the local iOS agent kernel fallback.
 * If either copy ever drifts, this test fails first.
 */
describe("wallet market-overview shared domain", () => {
  it("pins the stablecoin id/symbol filter sets", () => {
    expect([...STABLE_ASSET_IDS].sort()).toEqual(
      [
        "binance-usd",
        "dai",
        "ethena-usde",
        "first-digital-usd",
        "tether",
        "true-usd",
        "usd-coin",
        "usds",
      ].sort(),
    );
    expect([...STABLE_ASSET_SYMBOLS].sort()).toEqual(
      ["busd", "dai", "fdusd", "tusd", "usdc", "usde", "usds", "usdt"].sort(),
    );
  });

  it("pins provider metadata (ids + names + urls)", () => {
    expect(COINGECKO_MARKET_PROVIDER).toEqual({
      providerId: "coingecko",
      providerName: "CoinGecko",
      providerUrl: "https://www.coingecko.com/",
    });
    expect(POLYMARKET_MARKET_PROVIDER).toEqual({
      providerId: "polymarket",
      providerName: "Polymarket",
      providerUrl: "https://polymarket.com/",
    });
  });

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
