// Keyless contract test: replays REAL recorded Polymarket API responses
// (__fixtures__/polymarket-real.recorded.json, captured from the live public
// gamma/clob APIs) through the actual `handlePolymarketRoute` parser and asserts
// the produced BFF DTO is contract-shaped.
//
// This is the "validated against the real API" tie that the inline UI mocks
// never had: the parser is exercised against the real wire shape (JSON-string
// `outcomes`/`clobTokenIds`, float `volume24hr`/`bestBid`) with no network, so it
// runs in every keyless lane. routes.real.test.ts re-fetches the live API to
// catch drift from this recording.

import { readFileSync } from "node:fs";
import type http from "node:http";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  validateMarketResponse,
  validateMarketsResponse,
  validateOrderbookResponse,
  validateStatusResponse,
} from "./__fixtures__/contract";
import { handlePolymarketRoute } from "./routes";

interface Recorded {
  gammaMarkets: unknown[];
  gammaMarket: unknown[];
  clobBook: unknown;
}

const recorded = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "__fixtures__/polymarket-real.recorded.json"),
    "utf8",
  ),
) as Recorded;

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

// A fetch that ignores the URL and returns the recorded body — the handler's
// URL-building is exercised; only the network hop is replaced by the recording.
function fetchReturning(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("polymarket routes — recorded real API contract", () => {
  it("parses real Gamma markets into a contract-shaped DTO", async () => {
    const res = createResponse();
    const handled = await handlePolymarketRoute(
      createRequest("/api/polymarket/markets?limit=2"),
      res,
      "/api/polymarket/markets",
      "GET",
      { fetchImpl: fetchReturning(recorded.gammaMarkets) },
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);

    const body =
      res.json<import("./polymarket-contracts").PolymarketMarketsResponse>();
    expect(validateMarketsResponse(body)).toEqual([]);
    expect(body.markets.length).toBe(recorded.gammaMarkets.length);

    // Real-shape facts the inline mock got wrong / never exercised:
    const first = body.markets[0];
    // liquidity arrives as a raw numeric string ("4279700.63974"), NOT "$12,345".
    expect(first?.liquidity).toMatch(/^\d/);
    // volume24hr arrives from the real API as a float and is normalized to string.
    expect(typeof first?.volume24hr).toBe("string");
    // outcomes arrive as a JSON STRING from Gamma and must be parsed to objects.
    expect(first?.outcomes.length).toBeGreaterThanOrEqual(2);
    expect(first?.outcomes[0]?.name).toBeTruthy();
    // clobTokenIds arrive as a JSON STRING and must be parsed to a string[].
    expect(first?.clobTokenIds.length).toBeGreaterThanOrEqual(2);
  });

  it("parses a real single Gamma market into a contract-shaped DTO", async () => {
    const res = createResponse();
    await handlePolymarketRoute(
      createRequest("/api/polymarket/market?slug=recorded"),
      res,
      "/api/polymarket/market",
      "GET",
      { fetchImpl: fetchReturning(recorded.gammaMarket) },
    );
    expect(res.statusCode).toBe(200);
    expect(validateMarketResponse(res.json())).toEqual([]);
  });

  it("parses a real CLOB orderbook into a contract-shaped DTO", async () => {
    const res = createResponse();
    await handlePolymarketRoute(
      createRequest("/api/polymarket/orderbook?token_id=recorded"),
      res,
      "/api/polymarket/orderbook",
      "GET",
      { fetchImpl: fetchReturning(recorded.clobBook) },
    );
    expect(res.statusCode).toBe(200);
    const dto = res.json();
    expect(validateOrderbookResponse(dto)).toEqual([]);
    const book =
      dto as import("./polymarket-contracts").PolymarketOrderbookResponse;
    // Top-of-book is derived from real levels, not echoed.
    expect(book.bids.length).toBeGreaterThan(0);
    expect(book.asks.length).toBeGreaterThan(0);
    expect(book.bestBid).toBeTruthy();
    expect(book.bestAsk).toBeTruthy();
  });

  it("status response is contract-shaped", async () => {
    const res = createResponse();
    await handlePolymarketRoute(
      createRequest("/api/polymarket/status"),
      res,
      "/api/polymarket/status",
      "GET",
      { env: {} },
    );
    expect(res.statusCode).toBe(200);
    expect(validateStatusResponse(res.json())).toEqual([]);
  });
});
