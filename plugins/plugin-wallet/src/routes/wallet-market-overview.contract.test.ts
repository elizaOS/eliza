/**
 * Replays recorded and adversarial provider payloads through the real wallet
 * market-overview route. The harness is keyless and deterministic; the live
 * drift suite separately checks CoinGecko's current public wire shape.
 */

import { readFileSync } from "node:fs";
import type http from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetWalletMarketOverviewCacheForTests,
  __setWalletMarketOverviewFetchForTests,
  handleWalletMarketOverviewRoute,
} from "./wallet-market-overview-route";

const recorded = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "__fixtures__/coingecko-markets.recorded.json",
    ),
    "utf8",
  ),
) as { coinGeckoMarkets: unknown[] };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Inject a fetch that serves the recorded CoinGecko markets and an empty
// Polymarket list, so the route's real aggregation + parse runs offline.
function installMarketFetch(
  coinGeckoMarkets: unknown[],
  polymarketMarkets: unknown[] = [],
): void {
  __setWalletMarketOverviewFetchForTests((async (url: URL | string) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.includes("coingecko.com")) {
      return jsonResponse(coinGeckoMarkets);
    }
    if (href.includes("polymarket.com")) {
      return jsonResponse(polymarketMarkets);
    }
    throw new Error(`unexpected fetch to ${href}`);
  }) as never);
}

function installRecordedFetch(): void {
  installMarketFetch(recorded.coinGeckoMarkets);
}

function createRequest(): http.IncomingMessage {
  return {
    method: "GET",
    url: "/api/wallet/market-overview",
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as http.IncomingMessage;
}

function createResponse() {
  const res = {
    statusCode: 0,
    body: "",
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body?: string) {
      if (typeof body === "string") this.body = body;
    },
    json<T = unknown>(): T {
      return JSON.parse(this.body) as T;
    },
  };
  return res as typeof res & http.ServerResponse;
}

interface CryptoMarket {
  id: string;
  symbol: string;
  name: string;
  priceUsd: number;
  change24hPct: number;
}

afterEach(() => {
  __resetWalletMarketOverviewCacheForTests();
});

describe("wallet market overview provider contracts", () => {
  it("parses the real /coins/markets shape into a contract-shaped DTO", async () => {
    __resetWalletMarketOverviewCacheForTests();
    installRecordedFetch();

    const res = createResponse();
    const handled = await handleWalletMarketOverviewRoute(createRequest(), res);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);

    const dto = res.json<{
      prices: CryptoMarket[];
      movers: CryptoMarket[];
      sources: {
        prices: { available: boolean };
        movers: { available: boolean };
      };
    }>();

    // The CoinGecko source parsed cleanly (no error path).
    expect(dto.sources.prices.available).toBe(true);
    expect(dto.sources.movers.available).toBe(true);

    // Both crypto arrays are parsed from the real /coins/markets response.
    const markets = [...dto.prices, ...dto.movers];
    expect(markets.length).toBeGreaterThan(0);

    // Real-shape facts: CoinGecko `symbol` is lowercase (btc); the parser
    // upper-cases it. current_price -> priceUsd (number). bitcoin leads the
    // market_cap_desc recording and is a non-stable top-rank asset (in movers).
    const btc =
      dto.movers.find((m) => m.id === "bitcoin") ??
      dto.prices.find((m) => m.id === "bitcoin");
    expect(
      btc,
      "bitcoin must parse from the real markets response",
    ).toBeTruthy();
    expect(btc?.symbol).toBe("BTC");
    expect((btc?.priceUsd ?? 0) > 0).toBe(true);
    expect(typeof btc?.change24hPct).toBe("number");

    // Every parsed market carries the required contract fields with the
    // parser's normalization (upper-cased symbol, numeric price).
    for (const m of markets) {
      expect(typeof m.id).toBe("string");
      expect(m.symbol).toBe(m.symbol.toUpperCase());
      expect(typeof m.priceUsd).toBe("number");
    }
  });

  it("drops malformed numeric strings from both direct provider feeds", async () => {
    installMarketFetch(
      [
        {
          id: "bitcoin",
          symbol: "btc",
          name: "Bitcoin",
          current_price: "60000 USD",
          price_change_percentage_24h: "1.5%",
          market_cap_rank: "1st",
        },
      ],
      [
        {
          slug: "malformed-market",
          question: "Will malformed data be accepted?",
          outcomes: '["Yes","No"]',
          outcomePrices: '["0.75","0.25"]',
          volume24hr: "100 USD",
        },
      ],
    );

    const res = createResponse();
    const handled = await handleWalletMarketOverviewRoute(createRequest(), res);
    const dto = res.json<{
      prices: unknown[];
      movers: unknown[];
      predictions: unknown[];
    }>();

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(dto.prices).toEqual([]);
    expect(dto.movers).toEqual([]);
    expect(dto.predictions).toEqual([]);
  });
});
