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

async function post(pathname: string, body: unknown): Promise<Response> {
  return handleIosLocalAgentRequest(
    new Request(`http://127.0.0.1:31337${pathname}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
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

  it("reports the real iOS-local backend capability boundary", async () => {
    await expect(getJson("/api/health")).resolves.toMatchObject({
      localAgent: {
        mode: "ios-local",
        transport: "ittp",
        fullAgentRuntime: false,
        taskService: false,
      },
    });

    await expect(getJson("/api/local-agent/capabilities")).resolves.toMatchObject(
      {
        mode: "ios-local",
        transport: {
          foreground: "ittp",
          background: "unavailable",
          tcpListener: false,
          nativeRequestProxy: false,
        },
        backendRuntime: {
          state: "compatibility-kernel",
          fullAgentRuntime: false,
          taskService: false,
          pluginLoader: false,
        },
        scheduledTasks: {
          state: "unavailable",
          primitive: "ScheduledTask",
        },
      },
    );
  });

  it("matches runtime-mode response contracts for iOS local", async () => {
    await expect(getJson("/api/runtime/mode")).resolves.toEqual({
      mode: "local",
      deploymentRuntime: "local",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
  });

  it("does not invent a parallel background task runner", async () => {
    const response = await post("/api/background/run-due-tasks", {});
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "task_service_unavailable",
      reason: expect.stringContaining("BackgroundRunner"),
      ranTasks: 0,
      capabilities: {
        scheduledTasks: {
          state: "unavailable",
          primitive: "ScheduledTask",
        },
      },
    });
  });

  it("serves no-op app and skill management contracts without claiming local runtime support", async () => {
    await expect(getJson("/api/apps/runs")).resolves.toEqual([]);
    await expect(getJson("/api/apps/favorites")).resolves.toEqual({
      favoriteApps: [],
    });
    await expect(getJson("/api/plugins/installed")).resolves.toEqual({
      count: 0,
      plugins: [],
    });
    await expect(getJson("/api/plugins/core")).resolves.toEqual({
      core: [],
      optional: [],
    });
    await expect(getJson("/api/skills/curated")).resolves.toEqual({
      skills: [],
    });
    await expect(getJson("/api/skills/catalog")).resolves.toMatchObject({
      total: 0,
      installedCount: 0,
      skills: [],
    });

    const launch = await post("/api/apps/launch", { name: "app-lifeops" });
    expect(launch.status).toBe(503);
    await expect(launch.json()).resolves.toMatchObject({
      ok: false,
      error: "app_manager_unavailable",
    });
  });

  it("serves stable empty contracts for dashboard subsystems that are not mounted locally", async () => {
    await expect(getJson("/api/workbench/overview")).resolves.toMatchObject({
      tasks: [],
      triggers: [],
      todos: [],
      tasksAvailable: false,
      triggersAvailable: false,
      todosAvailable: false,
    });
    await expect(getJson("/api/triggers")).resolves.toEqual({ triggers: [] });
    await expect(getJson("/api/documents")).resolves.toMatchObject({
      documents: [],
      total: 0,
    });
    await expect(getJson("/api/mcp/status")).resolves.toEqual({
      servers: [],
    });
    await expect(getJson("/api/secrets/manager/backends")).resolves.toMatchObject(
      {
        backends: [
          {
            id: "in-house",
            available: false,
          },
        ],
      },
    );
    await expect(getJson("/api/training/status")).resolves.toEqual({
      available: false,
    });
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

  it("resets local iOS agent state and keeps the kernel running", async () => {
    const localStorage = stubLocalStorage();
    vi.stubGlobal("window", { localStorage });

    const opened = await postJson("/api/conversations", {
      title: "Reset candidate",
    });
    expect(opened).toMatchObject({
      conversation: { title: "Reset candidate" },
    });

    await expect(getJson("/api/conversations")).resolves.toMatchObject({
      conversations: [expect.objectContaining({ title: "Reset candidate" })],
    });

    await expect(postJson("/api/agent/reset", {})).resolves.toEqual({
      ok: true,
    });

    await expect(getJson("/api/conversations")).resolves.toEqual({
      conversations: [],
    });
    await expect(getJson("/api/status")).resolves.toMatchObject({
      state: "running",
      model: null,
    });
  });
});
