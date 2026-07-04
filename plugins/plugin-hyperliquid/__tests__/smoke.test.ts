/**
 * Smoke tests for `handleHyperliquidRoute` and `createHyperliquidInfoClient`:
 * markets/funding/status/positions/orders route payloads, non-GET 501
 * execution-disabled responses, and position/order normalization math
 * (mark price, distance-to-liquidation, effective leverage). Fetch is mocked
 * against fixed responses — no live Hyperliquid API calls.
 */
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  createHyperliquidInfoClient,
  type HyperliquidFetch,
  handleHyperliquidRoute,
} from "../src/routes";

function responseRecorder() {
  const res = {
    status: 0,
    headers: {} as Record<string, string>,
    body: "",
    headersSent: false,
    statusCode: 0,
    setHeader(key: string, value: string) {
      this.headers[key.toLowerCase()] = value;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this.status = status;
      this.statusCode = status;
      this.headers = headers ?? {};
    },
    end(body?: string) {
      this.status = this.statusCode;
      this.body = body ?? "";
      this.headersSent = true;
    },
  };
  return res;
}

function fixedNow() {
  return new Date("2026-05-01T12:00:00.000Z");
}

describe("Hyperliquid route and info client behavior", () => {
  it("fetches markets through the Info API and returns parsed route payloads", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init).toMatchObject({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "meta" }),
        });
        return Response.json({
          universe: [
            { name: "BTC", szDecimals: 5, maxLeverage: 50 },
            {
              name: "ETH",
              szDecimals: 4,
              onlyIsolated: true,
              isDelisted: false,
            },
          ],
        });
      },
    ) as HyperliquidFetch;
    const res = responseRecorder();

    await expect(
      handleHyperliquidRoute(
        {} as http.IncomingMessage,
        res as unknown as http.ServerResponse,
        "/api/hyperliquid/markets",
        "GET",
        { fetchImpl, now: fixedNow },
      ),
    ).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.hyperliquid.xyz/info",
      expect.any(Object),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      markets: [
        {
          name: "BTC",
          index: 0,
          szDecimals: 5,
          maxLeverage: 50,
          onlyIsolated: false,
          isDelisted: false,
        },
        {
          name: "ETH",
          index: 1,
          szDecimals: 4,
          maxLeverage: null,
          onlyIsolated: true,
          isDelisted: false,
        },
      ],
      source: "hyperliquid-info-meta",
      fetchedAt: "2026-05-01T12:00:00.000Z",
    });
  });

  it("fetches current funding rates through metaAndAssetCtxs", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init).toMatchObject({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "metaAndAssetCtxs" }),
        });
        return Response.json([
          {
            universe: [
              { name: "BTC", szDecimals: 5, maxLeverage: 50 },
              { name: "ETH", szDecimals: 4, maxLeverage: 50 },
            ],
          },
          [
            {
              funding: "0.0000125",
              premium: "0.00031774",
              markPx: "14.3161",
              oraclePx: "14.32",
              openInterest: "688.11",
            },
            {
              funding: "-0.000001",
              premium: "-0.00002",
              markPx: "6.0436",
              oraclePx: "6.0457",
              openInterest: "1882.55",
            },
          ],
        ]);
      },
    ) as HyperliquidFetch;
    const res = responseRecorder();

    await expect(
      handleHyperliquidRoute(
        {} as http.IncomingMessage,
        res as unknown as http.ServerResponse,
        "/api/hyperliquid/funding",
        "GET",
        { fetchImpl, now: fixedNow },
      ),
    ).resolves.toBe(true);

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      rates: [
        {
          coin: "BTC",
          index: 0,
          funding: "0.0000125",
          premium: "0.00031774",
          markPx: "14.3161",
          oraclePx: "14.32",
          openInterest: "688.11",
        },
        {
          coin: "ETH",
          index: 1,
          funding: "-0.000001",
          premium: "-0.00002",
          markPx: "6.0436",
          oraclePx: "6.0457",
          openInterest: "1882.55",
        },
      ],
      source: "hyperliquid-info-meta-and-asset-ctxs",
      fetchedAt: "2026-05-01T12:00:00.000Z",
    });
  });

  it("returns status without fetch and rejects non-GET methods as execution-disabled", async () => {
    const statusRes = responseRecorder();
    await expect(
      handleHyperliquidRoute(
        {} as http.IncomingMessage,
        statusRes as unknown as http.ServerResponse,
        "/api/hyperliquid/status",
        "GET",
        { env: {} as NodeJS.ProcessEnv },
      ),
    ).resolves.toBe(true);

    expect(statusRes.status).toBe(200);
    expect(JSON.parse(statusRes.body)).toMatchObject({
      publicReadReady: true,
      signerReady: false,
      executionReady: false,
      credentialMode: "none",
      readiness: {
        accountReads: false,
        execution: false,
      },
    });

    const postRes = responseRecorder();
    await expect(
      handleHyperliquidRoute(
        {} as http.IncomingMessage,
        postRes as unknown as http.ServerResponse,
        "/api/hyperliquid/orders",
        "POST",
        { env: {} as NodeJS.ProcessEnv },
      ),
    ).resolves.toBe(true);
    expect(postRes.status).toBe(501);
    expect(JSON.parse(postRes.body)).toMatchObject({
      executionReady: false,
      credentialMode: "none",
    });
  });

  it("returns blocked positions when no account is configured and false for unrelated routes", async () => {
    const res = responseRecorder();

    await expect(
      handleHyperliquidRoute(
        {} as http.IncomingMessage,
        res as unknown as http.ServerResponse,
        "/api/hyperliquid/positions",
        "GET",
        {
          env: {} as NodeJS.ProcessEnv,
          fetchImpl: vi.fn() as unknown as HyperliquidFetch,
        },
      ),
    ).resolves.toBe(true);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      accountAddress: null,
      positions: [],
      fetchedAt: null,
    });

    await expect(
      handleHyperliquidRoute(
        {} as http.IncomingMessage,
        responseRecorder() as unknown as http.ServerResponse,
        "/api/not-hyperliquid",
        "GET",
      ),
    ).resolves.toBe(false);
  });

  it("normalizes positions and orders through the info client and throws on malformed payloads", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          assetPositions: [
            {
              position: {
                coin: "ETH",
                szi: "1.25",
                entryPx: "3000",
                // positionValue 4000 / size 1.25 => mark 3200, deliberately
                // above the 3000 entry so the derived mark (not entry) drives
                // the distance-to-liquidation calc.
                positionValue: "4000",
                unrealizedPnl: "12.5",
                returnOnEquity: "0.05",
                liquidationPx: "2400",
                marginUsed: "1000",
                leverage: { type: "cross", value: 3 },
              },
            },
          ],
          marginSummary: {
            accountValue: "5000",
            totalNtlPos: "4000",
            totalMarginUsed: "1000",
            totalRawUsd: "5012.5",
          },
          withdrawable: "4000",
        }),
      )
      .mockResolvedValueOnce(
        Response.json([
          {
            coin: "BTC",
            side: "B",
            limitPx: "65000",
            sz: "0.1",
            oid: 123,
            timestamp: 171000,
            reduceOnly: true,
            orderType: "Limit",
            tif: "Gtc",
          },
        ]),
      )
      .mockResolvedValueOnce(
        Response.json({ notUniverse: [] }),
      ) as unknown as vi.MockedFunction<HyperliquidFetch>;
    const client = createHyperliquidInfoClient({ fetchImpl });
    const account = "0x0000000000000000000000000000000000000001";

    await expect(client.getPositions(account)).resolves.toEqual({
      positions: [
        {
          coin: "ETH",
          size: "1.25",
          entryPx: "3000",
          positionValue: "4000",
          unrealizedPnl: "12.5",
          returnOnEquity: "0.05",
          liquidationPx: "2400",
          marginUsed: "1000",
          leverageType: "cross",
          leverageValue: 3,
          // mark = 4000 / 1.25 = 3200; (3200 - 2400) / 3200 = 25% to liq.
          markPx: "3200",
          distanceToLiquidationPct: 25,
        },
      ],
      summary: {
        accountValue: "5000",
        totalNotionalPosition: "4000",
        totalMarginUsed: "1000",
        totalRawUsd: "5012.5",
        withdrawable: "4000",
        totalUnrealizedPnl: "12.50",
        // effective leverage = totalNtlPos 4000 / accountValue 5000 = 0.8.
        effectiveLeverage: 0.8,
      },
    });
    await expect(client.getOpenOrders(account)).resolves.toEqual([
      {
        coin: "BTC",
        side: "B",
        limitPx: "65000",
        size: "0.1",
        oid: 123,
        timestamp: 171000,
        reduceOnly: true,
        orderType: "Limit",
        tif: "Gtc",
        cloid: null,
      },
    ]);
    await expect(client.getMarkets()).rejects.toThrow(
      "Hyperliquid meta response missing universe",
    );

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://api.hyperliquid.xyz/info",
      expect.objectContaining({
        body: JSON.stringify({ type: "clearinghouseState", user: account }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://api.hyperliquid.xyz/info",
      expect.objectContaining({
        body: JSON.stringify({ type: "openOrders", user: account }),
      }),
    );
  });
});
