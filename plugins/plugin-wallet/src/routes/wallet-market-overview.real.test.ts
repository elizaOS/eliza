// Live drift check against the REAL public CoinGecko API.
//
// CoinGecko's /coins/markets read endpoint is public, so this drives the real
// handleWalletMarketOverviewRoute against the live API (no injected fetch) and
// asserts the parsed DTO is still contract-shaped — catching drift from the
// recorded fixture replayed keyless in wallet-market-overview.contract.test.ts.
//
// Gated: opt-in via COINGECKO_LIVE_TEST=1 or the post-merge live lane
// (TEST_LANE=post-merge). Skips cleanly otherwise.

import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetWalletMarketOverviewCacheForTests,
  handleWalletMarketOverviewRoute,
} from "./wallet-market-overview-route";

const LIVE =
  process.env.COINGECKO_LIVE_TEST === "1" ||
  process.env.TEST_LANE === "post-merge";

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
    setHeader() {},
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
  priceUsd: number;
  change24hPct: number;
}

afterEach(() => {
  __resetWalletMarketOverviewCacheForTests();
});

describe.skipIf(!LIVE)(
  "wallet market overview — live CoinGecko drift check",
  () => {
    it("live /coins/markets still parses into a contract-shaped DTO", async () => {
      __resetWalletMarketOverviewCacheForTests();
      const res = createResponse();
      await handleWalletMarketOverviewRoute(createRequest(), res);
      expect(res.statusCode).toBe(200);

      const dto = res.json<{
        prices: CryptoMarket[];
        movers: CryptoMarket[];
        sources: { prices: { available: boolean } };
      }>();
      expect(dto.sources.prices.available).toBe(true);
      const markets = [...dto.prices, ...dto.movers];
      expect(markets.length).toBeGreaterThan(0);
      for (const m of markets) {
        expect(typeof m.id).toBe("string");
        expect(m.symbol).toBe(m.symbol.toUpperCase());
        expect(typeof m.priceUsd).toBe("number");
        expect(m.priceUsd).toBeGreaterThan(0);
      }
    }, 30_000);
  },
);
