// Live drift check against the REAL public Polymarket APIs.
//
// Polymarket's gamma + clob read endpoints are public (no key), so this drives
// the real `handlePolymarketRoute` against the live API and asserts the response
// is still contract-shaped — catching the case where the provider changes its
// wire format and the recorded fixture (replayed keyless in routes.contract.test.ts)
// silently goes stale.
//
// Gated: opt-in via POLYMARKET_LIVE_TEST=1, or the post-merge live lane
// (TEST_LANE=post-merge picks up *.real.test.ts). Skips cleanly otherwise so a
// keyless PR never depends on network reachability.

import type http from "node:http";
import { describe, expect, it } from "vitest";

import {
  validateMarketsResponse,
  validateOrderbookResponse,
  validateStatusResponse,
} from "./__fixtures__/contract";
import type {
  PolymarketMarketsResponse,
  PolymarketOrderbookResponse,
} from "./polymarket-contracts";
import { handlePolymarketRoute } from "./routes";

const LIVE =
  process.env.POLYMARKET_LIVE_TEST === "1" ||
  process.env.TEST_LANE === "post-merge";

function createRequest(url: string): http.IncomingMessage {
  return { url } as http.IncomingMessage;
}

function createResponse() {
  const res = {
    headersSent: false,
    statusCode: 0,
    body: "",
    setHeader() {},
    end(body: string) {
      this.headersSent = true;
      this.body = body;
    },
    json<T = unknown>(): T {
      return JSON.parse(this.body) as T;
    },
  };
  return res as typeof res & http.ServerResponse;
}

async function drive(url: string, pathname: string) {
  const res = createResponse();
  await handlePolymarketRoute(createRequest(url), res, pathname, "GET");
  return res;
}

describe.skipIf(!LIVE)(
  "polymarket routes — live public API drift check",
  () => {
    it("live Gamma markets still parse into a contract-shaped DTO", async () => {
      const res = await drive(
        "/api/polymarket/markets?limit=5&active=true&closed=false",
        "/api/polymarket/markets",
      );
      expect(res.statusCode).toBe(200);
      const body = res.json<PolymarketMarketsResponse>();
      expect(validateMarketsResponse(body)).toEqual([]);
      expect(body.markets.length).toBeGreaterThan(0);
    }, 30_000);

    it("live CLOB orderbook still parses into a contract-shaped DTO", async () => {
      // Resolve a real, order-book-enabled market + token from the live feed.
      const marketsRes = await drive(
        "/api/polymarket/markets?limit=20&active=true&closed=false",
        "/api/polymarket/markets",
      );
      const markets = marketsRes
        .json<PolymarketMarketsResponse>()
        .markets.filter((m) => m.enableOrderBook && m.clobTokenIds.length > 0);
      expect(markets.length).toBeGreaterThan(0);
      const tokenId = markets[0]?.clobTokenIds[0];
      expect(tokenId).toBeTruthy();

      const res = await drive(
        `/api/polymarket/orderbook?token_id=${tokenId}`,
        "/api/polymarket/orderbook",
      );
      expect(res.statusCode).toBe(200);
      const book = res.json<PolymarketOrderbookResponse>();
      expect(validateOrderbookResponse(book)).toEqual([]);
    }, 30_000);

    it("live status is contract-shaped", async () => {
      const res = await drive(
        "/api/polymarket/status",
        "/api/polymarket/status",
      );
      expect(res.statusCode).toBe(200);
      expect(validateStatusResponse(res.json())).toEqual([]);
    }, 30_000);
  },
);
