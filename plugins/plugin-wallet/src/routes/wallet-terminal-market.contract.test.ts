/**
 * Drives the real terminal market and price-history routes with recorded and
 * adversarial CoinGecko payloads through an injected fetch. Deterministic and
 * keyless; it covers validation, stale-cache recovery, upstream 404s, and
 * concurrent-miss sharing.
 */
import { readFileSync } from "node:fs";
import type http from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  WalletTerminalChartResponse,
  WalletTerminalMarketsResponse,
} from "../contracts";
import {
  __expireWalletTerminalCachesForTests,
  __resetWalletTerminalMarketRouteForTests,
  __setWalletTerminalFetchForTests,
  handleWalletTerminalMarketRoute,
} from "./wallet-terminal-market-route";

const recorded = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "__fixtures__/coingecko-markets.recorded.json",
    ),
    "utf8",
  ),
) as { coinGeckoMarkets: unknown[] };

const chartPayload = {
  prices: [
    [1_700_000_120_000, 101.5],
    [1_700_000_000_000, 100],
    [1_700_000_060_000, 100.75],
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(
  handler: (href: string) => Response | Promise<Response>,
): string[] {
  const calls: string[] = [];
  __setWalletTerminalFetchForTests(async (input) => {
    const href = String(input);
    calls.push(href);
    return handler(href);
  });
  return calls;
}

function request(url: string, method = "GET"): http.IncomingMessage {
  return {
    method,
    url,
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as http.IncomingMessage;
}

function response() {
  const res = {
    statusCode: 0,
    body: "",
    headersSent: false,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body?: string) {
      if (typeof body === "string") this.body = body;
    },
    json<T>(): T {
      return JSON.parse(this.body) as T;
    },
  };
  return res;
}

async function call(url: string, method = "GET") {
  const res = response();
  const handled = await handleWalletTerminalMarketRoute(
    request(url, method),
    res as unknown as http.ServerResponse,
  );
  return { handled, res };
}

afterEach(() => {
  __resetWalletTerminalMarketRouteForTests();
});

describe("GET /api/wallet/terminal/markets", () => {
  it("lists every usable CoinGecko row as a live source", async () => {
    installFetch(() => jsonResponse(recorded.coinGeckoMarkets));
    const { handled, res } = await call("/api/wallet/terminal/markets");
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = res.json<WalletTerminalMarketsResponse>();
    expect(body.stale).toBe(false);
    expect(body.source).toMatchObject({
      providerId: "coingecko",
      available: true,
      error: null,
    });
    expect(body.markets).toHaveLength(recorded.coinGeckoMarkets.length);
    const bitcoin = body.markets.find((market) => market.id === "bitcoin");
    expect(bitcoin?.symbol).toBe("BTC");
    expect(bitcoin?.priceUsd).toBeGreaterThan(0);
  });

  it("answers 502 instead of an empty list when nothing is cached", async () => {
    installFetch(() => jsonResponse({ status: "down" }, 503));
    const { res } = await call("/api/wallet/terminal/markets");
    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: string }>().error).toMatch(/terminal markets/);
  });

  it("serves the last good list marked stale when a refresh fails", async () => {
    let fail = false;
    installFetch(() =>
      fail ? jsonResponse({}, 500) : jsonResponse(recorded.coinGeckoMarkets),
    );
    await call("/api/wallet/terminal/markets");
    fail = true;
    __expireWalletTerminalCachesForTests();
    const { res } = await call("/api/wallet/terminal/markets");
    expect(res.statusCode).toBe(200);
    const body = res.json<WalletTerminalMarketsResponse>();
    expect(body.stale).toBe(true);
    expect(body.source.stale).toBe(true);
    expect(body.source.error).toBe("CoinGecko responded 500");
    expect(body.markets.length).toBeGreaterThan(0);
  });

  it("shares one upstream request across concurrent misses", async () => {
    const calls = installFetch(() => jsonResponse(recorded.coinGeckoMarkets));
    await Promise.all([
      call("/api/wallet/terminal/markets"),
      call("/api/wallet/terminal/markets"),
      call("/api/wallet/terminal/markets"),
    ]);
    expect(calls).toHaveLength(1);
  });

  it("rejects non-GET methods and ignores foreign paths", async () => {
    installFetch(() => jsonResponse(recorded.coinGeckoMarkets));
    expect(
      (await call("/api/wallet/terminal/markets", "POST")).res.statusCode,
    ).toBe(405);
    expect((await call("/api/wallet/other")).handled).toBe(false);
  });
});

describe("GET /api/wallet/terminal/chart", () => {
  it("returns time-ordered USD points for a valid asset and window", async () => {
    const calls = installFetch(() => jsonResponse(chartPayload));
    const { res } = await call("/api/wallet/terminal/chart?id=bitcoin&days=7");
    expect(res.statusCode).toBe(200);
    const body = res.json<WalletTerminalChartResponse>();
    expect(body).toMatchObject({ id: "bitcoin", days: 7, stale: false });
    expect(body.points.map((point) => point.priceUsd)).toEqual([
      100, 100.75, 101.5,
    ]);
    expect(calls[0]).toContain("/coins/bitcoin/market_chart");
    expect(calls[0]).toContain("days=7");
  });

  it.each([
    ["id=../secrets&days=7", /id must be/],
    ["id=BITCOIN&days=7", /id must be/],
    ["days=7", /id must be/],
    ["id=bitcoin&days=2", /days must be/],
    ["id=bitcoin", /days must be/],
  ])("rejects %s before any upstream call", async (query, message) => {
    const calls = installFetch(() => jsonResponse(chartPayload));
    const { res } = await call(`/api/wallet/terminal/chart?${query}`);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(message);
    expect(calls).toHaveLength(0);
  });

  it("maps an unknown CoinGecko asset to 404", async () => {
    installFetch(() => jsonResponse({ error: "coin not found" }, 404));
    const { res } = await call(
      "/api/wallet/terminal/chart?id=no-such-coin&days=1",
    );
    expect(res.statusCode).toBe(404);
  });

  it.each([
    [{ prices: "nope" }],
    [{ prices: [[1, "100"]] }],
    [{ prices: [[1, 100]] }],
    [[]],
  ])("treats a malformed history payload as unavailable", async (payload) => {
    installFetch(() => jsonResponse(payload));
    const { res } = await call("/api/wallet/terminal/chart?id=bitcoin&days=30");
    expect(res.statusCode).toBe(502);
  });
});
