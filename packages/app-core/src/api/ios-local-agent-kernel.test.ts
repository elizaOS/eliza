import { afterEach, describe, expect, it, vi } from "vitest";
import { handleIosLocalAgentRequest } from "./ios-local-agent-kernel";

async function getJson(pathname: string): Promise<unknown> {
  const response = await handleIosLocalAgentRequest(
    new Request(`http://127.0.0.1:31337${pathname}`),
  );

  expect(response.status).toBe(200);
  return response.json();
}

async function postJson(pathname: string, body: unknown): Promise<unknown> {
  const response = await handleIosLocalAgentRequest(
    new Request(`http://127.0.0.1:31337${pathname}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

  expect(response.status).toBe(200);
  return response.json();
}

function stubLocalStorage(): Storage {
  const items = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => items.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      items.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      items.delete(key);
    }),
    clear: vi.fn(() => {
      items.clear();
    }),
    key: vi.fn((index: number) => [...items.keys()][index] ?? null),
    get length() {
      return items.size;
    },
  } as Storage;
}

describe("handleIosLocalAgentRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("matches app catalog response contracts", async () => {
    await expect(getJson("/api/apps")).resolves.toEqual([]);
    await expect(getJson("/api/catalog/apps")).resolves.toEqual([]);
  });

  it("matches plugin and skill list response contracts", async () => {
    await expect(getJson("/api/plugins")).resolves.toEqual({ plugins: [] });
    await expect(getJson("/api/skills")).resolves.toEqual({ skills: [] });
  });

  it("serves empty local wallet contracts instead of 404s", async () => {
    await expect(getJson("/api/wallet/addresses")).resolves.toEqual({
      evmAddress: null,
      solanaAddress: null,
    });
    await expect(getJson("/api/wallet/balances")).resolves.toEqual({
      evm: null,
      solana: null,
    });

    const config = await getJson("/api/wallet/config");
    expect(config).toMatchObject({
      evmAddress: null,
      solanaAddress: null,
      walletSource: "none",
      executionReady: false,
      wallets: [],
    });

    const overview = await getJson("/api/wallet/market-overview");
    expect(overview).toMatchObject({
      prices: [],
      movers: [],
      predictions: [],
    });
  });

  it("loads and caches local wallet market overview data", async () => {
    const localStorage = stubLocalStorage();
    vi.stubGlobal("window", { localStorage });
    const fetchMock = vi.fn(async () =>
      Response.json({
        generatedAt: "2026-05-06T00:00:00.000Z",
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
            priceUsd: 103000,
            change24hPct: 2.1,
            imageUrl: null,
          },
        ],
        movers: [],
        predictions: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getJson("/api/wallet/market-overview")).resolves.toMatchObject(
      {
        prices: [{ id: "bitcoin", symbol: "BTC" }],
      },
    );
    await expect(getJson("/api/wallet/market-overview")).resolves.toMatchObject(
      {
        prices: [{ id: "bitcoin", symbol: "BTC" }],
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves local web browser workspace contracts instead of 404s", async () => {
    await expect(getJson("/api/browser-workspace")).resolves.toEqual({
      mode: "web",
      tabs: [],
    });

    const opened = await postJson("/api/browser-workspace/tabs", {
      url: "https://docs.elizaos.ai/",
      title: "Docs",
    });
    expect(opened).toMatchObject({
      tab: {
        title: "Docs",
        url: "https://docs.elizaos.ai/",
        visible: true,
      },
    });
  });
});
