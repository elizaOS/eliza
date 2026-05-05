import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { polymarketPlugin } from "../src/plugin";
import { handlePolymarketRoute } from "../src/routes";

vi.mock("@elizaos/core", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("Polymarket plugin route dispatch matching", () => {
  const routes = polymarketPlugin.routes ?? [];

  function requireRoute(type: string, path: string) {
    const route = routes.find(
      (item) => item.type === type && item.path === path,
    );
    if (!route) throw new Error(`Expected ${type} ${path} route`);
    return route;
  }

  it("registers the native Polymarket API routes", () => {
    for (const [type, path] of [
      ["GET", "/api/polymarket/status"],
      ["GET", "/api/polymarket/markets"],
      ["GET", "/api/polymarket/market"],
      ["GET", "/api/polymarket/orderbook"],
      ["GET", "/api/polymarket/orders"],
      ["POST", "/api/polymarket/orders"],
      ["GET", "/api/polymarket/positions"],
    ]) {
      const route = requireRoute(type, path);
      expect(route.path).toBe(path);
      expect(typeof route.handler).toBe("function");
    }
  });

  it("exposes Polymarket agent actions and provider when the app plugin is loaded", () => {
    expect(
      (polymarketPlugin.providers ?? []).map((item) => item.name),
    ).toContain("POLYMARKET_STATUS");
    expect((polymarketPlugin.actions ?? []).map((item) => item.name)).toEqual([
      "POLYMARKET_STATUS",
      "POLYMARKET_GET_MARKETS",
      "POLYMARKET_GET_MARKET",
      "POLYMARKET_GET_ORDERBOOK",
      "POLYMARKET_GET_POSITIONS",
      "POLYMARKET_PLACE_ORDER",
    ]);
  });

  it("does not expose fake betting or redeem endpoints", () => {
    for (const path of [
      "/api/polymarket/bet",
      "/api/polymarket/redeem",
      "/api/polymarket/trade",
    ]) {
      expect(routes.find((route) => route.path === path)).toBeUndefined();
    }
  });
});

describe("handlePolymarketRoute", () => {
  it("distinguishes public read readiness from trading readiness", async () => {
    const res = createJsonResponse();
    await handlePolymarketRoute(
      createRequest("/api/polymarket/status"),
      res.response,
      "/api/polymarket/status",
      "GET",
      { env: {} },
    );

    expect(res.statusCode()).toBe(200);
    expect(res.json()).toMatchObject({
      publicReads: { ready: true },
      trading: {
        ready: false,
        credentialsReady: false,
        missing: [
          "POLYMARKET_PRIVATE_KEY",
          "CLOB_API_KEY",
          "CLOB_API_SECRET",
          "CLOB_API_PASSPHRASE",
        ],
      },
    });
  });

  it("reads markets from Gamma through the injected fetch implementation", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requests.push(String(input));
      return Response.json([
        {
          id: "123",
          slug: "will-it-rain",
          question: "Will it rain tomorrow?",
          outcomes: '["Yes","No"]',
          outcomePrices: '["0.42","0.58"]',
          active: true,
          closed: false,
          enableOrderBook: true,
          volume24hr: "1000",
          liquidity: "250",
        },
      ]);
    };
    const res = createJsonResponse();

    await handlePolymarketRoute(
      createRequest("/api/polymarket/markets?limit=5&offset=10"),
      res.response,
      "/api/polymarket/markets",
      "GET",
      { fetchImpl },
    );

    expect(res.statusCode()).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("https://gamma-api.polymarket.com/markets?");
    expect(requests[0]).toContain("limit=5");
    expect(requests[0]).toContain("offset=10");
    expect(res.json()).toMatchObject({
      markets: [
        {
          id: "123",
          question: "Will it rain tomorrow?",
          outcomes: [
            { name: "Yes", price: "0.42" },
            { name: "No", price: "0.58" },
          ],
        },
      ],
    });
  });

  it("derives best bid and ask from all CLOB orderbook levels", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requests.push(String(input));
      return Response.json({
        market: "0xcondition",
        asset_id: "token-123",
        bids: [
          { price: "0.01", size: "4" },
          { price: "0.44", size: "8" },
          { price: "bad", size: "99" },
        ],
        asks: [
          { price: "0.99", size: "5" },
          { price: "0.49", size: "7" },
          { price: "0", size: "12" },
        ],
        last_trade_price: "0.46",
        tick_size: "0.01",
      });
    };
    const res = createJsonResponse();

    await handlePolymarketRoute(
      createRequest("/api/polymarket/orderbook?token_id=token-123"),
      res.response,
      "/api/polymarket/orderbook",
      "GET",
      { fetchImpl },
    );

    expect(res.statusCode()).toBe(200);
    expect(requests[0]).toBe(
      "https://clob.polymarket.com/book?token_id=token-123",
    );
    expect(res.json()).toMatchObject({
      bestBid: "0.44",
      bestBidSize: "8",
      bestAsk: "0.49",
      bestAskSize: "7",
      midpoint: "0.465",
      spread: "0.05",
      bidLevels: 3,
      askLevels: 3,
    });
  });

  it("returns 501 for order routes instead of faking trades", async () => {
    const res = createJsonResponse();
    await handlePolymarketRoute(
      createRequest("/api/polymarket/orders"),
      res.response,
      "/api/polymarket/orders",
      "POST",
    );

    expect(res.statusCode()).toBe(501);
    expect(res.json()).toMatchObject({
      enabled: false,
      requiredForTrading: [
        "POLYMARKET_PRIVATE_KEY",
        "CLOB_API_KEY",
        "CLOB_API_SECRET",
        "CLOB_API_PASSPHRASE",
      ],
    });
  });
});

function createRequest(url: string): http.IncomingMessage {
  return { url, method: "GET", headers: {} } as http.IncomingMessage;
}

function createJsonResponse() {
  let body = "";
  let code = 200;
  const response = {
    headersSent: false,
    setHeader: () => undefined,
    end: (chunk: string) => {
      body = chunk;
    },
    get statusCode() {
      return code;
    },
    set statusCode(value: number) {
      code = value;
    },
  } as unknown as http.ServerResponse;

  return {
    response,
    json: () => JSON.parse(body) as unknown,
    statusCode: () => code,
  };
}
