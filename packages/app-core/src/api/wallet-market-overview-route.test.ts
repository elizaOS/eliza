import http from "node:http";
import type { AddressInfo } from "node:net";
import type { fetchWithTimeoutGuard } from "@elizaos/agent/api/server";
import type { WalletMarketOverviewResponse } from "@elizaos/shared/contracts/wallet";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetWalletMarketOverviewCacheForTests,
  __setWalletMarketOverviewFetchForTests,
  handleWalletMarketOverviewRoute,
} from "./wallet-market-overview-route";

type FetchWithTimeoutGuard = typeof fetchWithTimeoutGuard;

interface Harness {
  baseUrl: string;
  dispose: () => Promise<void>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function startHarness(): Promise<Harness> {
  const server = http.createServer(async (req, res) => {
    try {
      const handled = await handleWalletMarketOverviewRoute(req, res);
      if (!handled && !res.headersSent) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "not-found" }));
      }
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dispose: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}

const coinGeckoPayload = [
  {
    id: "bitcoin",
    symbol: "btc",
    name: "Bitcoin",
    current_price: 103_000,
    price_change_percentage_24h: 2.1,
    market_cap_rank: 1,
    image: "https://assets.example.com/btc.png",
  },
  {
    id: "ethereum",
    symbol: "eth",
    name: "Ethereum",
    current_price: 4_900,
    price_change_percentage_24h: 1.4,
    market_cap_rank: 2,
    image: "https://assets.example.com/eth.png",
  },
  {
    id: "solana",
    symbol: "sol",
    name: "Solana",
    current_price: 210,
    price_change_percentage_24h: 4.3,
    market_cap_rank: 5,
    image: "https://assets.example.com/sol.png",
  },
  {
    id: "dogecoin",
    symbol: "doge",
    name: "Dogecoin",
    current_price: 0.33,
    price_change_percentage_24h: 12.8,
    market_cap_rank: 8,
    image: "https://assets.example.com/doge.png",
  },
  {
    id: "pepe",
    symbol: "pepe",
    name: "Pepe",
    current_price: 0.000011,
    price_change_percentage_24h: -9.4,
    market_cap_rank: 32,
    image: "https://assets.example.com/pepe.png",
  },
];

const polymarketPayload = [
  {
    slug: "will-bitcoin-hit-150k-by-june-30-2026",
    question: "Will Bitcoin hit $150k by June 30, 2026?",
    outcomes: JSON.stringify(["Yes", "No"]),
    outcomePrices: JSON.stringify(["0.0135", "0.9865"]),
    volume24hr: "5821652.894196",
    volume: "15734008.014241",
    endDate: "2026-07-01T04:00:00Z",
    image: "https://assets.example.com/btc-market.png",
  },
];

const cloudPreviewPayload: WalletMarketOverviewResponse = {
  generatedAt: "2026-04-23T12:34:56.000Z",
  cacheTtlSeconds: 120,
  stale: false,
  sources: {
    prices: {
      providerId: "coingecko",
      providerName: "CoinGecko",
      providerUrl: "https://www.coingecko.com/",
      available: true,
      stale: false,
      error: null,
    },
    movers: {
      providerId: "coingecko",
      providerName: "CoinGecko",
      providerUrl: "https://www.coingecko.com/",
      available: true,
      stale: false,
      error: null,
    },
    predictions: {
      providerId: "polymarket",
      providerName: "Polymarket",
      providerUrl: "https://polymarket.com/",
      available: true,
      stale: false,
      error: null,
    },
  },
  prices: [
    {
      id: "bitcoin",
      symbol: "BTC",
      name: "Bitcoin",
      priceUsd: 103_000,
      change24hPct: 2.1,
      imageUrl: "https://assets.example.com/btc.png",
    },
  ],
  movers: [
    {
      id: "dogecoin",
      symbol: "DOGE",
      name: "Dogecoin",
      priceUsd: 0.33,
      change24hPct: 12.8,
      marketCapRank: 8,
      imageUrl: "https://assets.example.com/doge.png",
    },
  ],
  predictions: [
    {
      id: "preview-only-market",
      slug: "preview-only-market",
      question: "Preview-only market that should be replaced",
      highlightedOutcomeLabel: "Yes",
      highlightedOutcomeProbability: 0.62,
      volume24hUsd: 25,
      totalVolumeUsd: 50,
      endsAt: "2026-12-31T23:59:59.000Z",
      imageUrl: "https://assets.example.com/btc-market.png",
    },
  ],
};

describe("wallet-market-overview-route", () => {
  let harness: Harness;
  const fetchWithTimeoutGuardMock = vi.fn<FetchWithTimeoutGuard>();

  beforeEach(async () => {
    fetchWithTimeoutGuardMock.mockReset();
    __resetWalletMarketOverviewCacheForTests();
    __setWalletMarketOverviewFetchForTests(fetchWithTimeoutGuardMock);
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness.dispose();
    fetchWithTimeoutGuardMock.mockReset();
    __resetWalletMarketOverviewCacheForTests();
  });

  it("replaces cloud preview predictions with the live Polymarket feed", async () => {
    fetchWithTimeoutGuardMock
      .mockResolvedValueOnce(jsonResponse(cloudPreviewPayload))
      .mockResolvedValueOnce(jsonResponse(polymarketPayload));

    const response = await fetch(
      `${harness.baseUrl}/api/wallet/market-overview`,
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as WalletMarketOverviewResponse;
    expect(body.prices).toEqual(cloudPreviewPayload.prices);
    expect(body.movers).toEqual(cloudPreviewPayload.movers);
    expect(body.predictions).toEqual([
      {
        id: "will-bitcoin-hit-150k-by-june-30-2026",
        slug: "will-bitcoin-hit-150k-by-june-30-2026",
        question: "Will Bitcoin hit $150k by June 30, 2026?",
        highlightedOutcomeLabel: "Yes",
        highlightedOutcomeProbability: 0.0135,
        volume24hUsd: 5821652.894196,
        totalVolumeUsd: 15734008.014241,
        endsAt: "2026-07-01T04:00:00Z",
        imageUrl: "https://assets.example.com/btc-market.png",
      },
    ]);
    expect(fetchWithTimeoutGuardMock).toHaveBeenCalledTimes(2);
    expect(String(fetchWithTimeoutGuardMock.mock.calls[1]?.[0])).toContain(
      "order=volume24hr",
    );
  });

  it("falls back to direct feeds when the cloud preview is unavailable", async () => {
    fetchWithTimeoutGuardMock
      .mockRejectedValueOnce(new Error("Cloud preview responded 503"))
      .mockResolvedValueOnce(jsonResponse(polymarketPayload))
      .mockResolvedValueOnce(jsonResponse(coinGeckoPayload));

    const response = await fetch(
      `${harness.baseUrl}/api/wallet/market-overview`,
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as WalletMarketOverviewResponse;
    expect(body.prices).toHaveLength(3);
    expect(body.movers.length).toBeGreaterThan(0);
    expect(body.predictions[0]?.question).toBe(
      "Will Bitcoin hit $150k by June 30, 2026?",
    );
    expect(body.sources.prices.available).toBe(true);
    expect(body.sources.predictions.available).toBe(true);
    expect(String(fetchWithTimeoutGuardMock.mock.calls[1]?.[0])).toContain(
      "order=volume24hr",
    );
  });

  it("returns 502 when every market feed fails", async () => {
    fetchWithTimeoutGuardMock
      .mockRejectedValueOnce(new Error("Cloud preview responded 503"))
      .mockRejectedValueOnce(new Error("Polymarket responded 503"))
      .mockRejectedValueOnce(new Error("CoinGecko responded 429"));

    const response = await fetch(
      `${harness.baseUrl}/api/wallet/market-overview`,
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to load market overview",
    });
  });
});
