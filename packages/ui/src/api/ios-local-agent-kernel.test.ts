/**
 * Unit coverage for the iOS in-renderer fetch kernel's route handling. In-process
 * Request/Response, no real device.
 */
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

    await expect(
      getJson("/api/local-agent/capabilities"),
    ).resolves.toMatchObject({
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
    });
  });

  it("matches runtime-mode response contracts for iOS local", async () => {
    await expect(getJson("/api/runtime/mode")).resolves.toEqual({
      mode: "local",
      deploymentRuntime: "local",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
  });

  it("serves POST /api/first-run so local onboarding finish does not 404-loop", async () => {
    // Regression: the kernel implemented GET /api/first-run/status but not
    // POST /api/first-run, so finishLocal's submitFirstRun hit the catch-all
    // 404 ("Not found"), which the conductor turned into a re-offer of the
    // runtime chooser (the on-device "local path → not found → pick again"
    // loop). It must accept + ack the finish payload.
    await expect(getJson("/api/first-run/status")).resolves.toMatchObject({
      complete: true,
    });
    const res = await post("/api/first-run", {
      runtime: "local",
      localInference: "all-local",
      agentName: "Eliza",
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("reports paired Cloud state and forwards chat through the Cloud bridge", async () => {
    const localStorage = stubLocalStorage();
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "cloud:agent-1",
        kind: "cloud",
        label: "Cloud Agent",
        apiBase: "eliza-local-agent://ipc",
        accessToken: "cloud-token",
      }),
    );
    vi.stubGlobal("window", { localStorage });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          jsonrpc: "2.0",
          id: "cloud-1",
          result: {
            text: "cloud answer",
            model: "cloud-model",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getJson("/api/auth/status")).resolves.toMatchObject({
      cloudProvisioned: true,
      cloudAgentId: "agent-1",
      cloudConnectionStatus: "connected",
    });
    await expect(getJson("/api/status")).resolves.toMatchObject({
      cloud: {
        connectionStatus: "connected",
        activeAgentId: "agent-1",
        cloudProvisioned: true,
        hasApiKey: true,
      },
    });
    await expect(
      postJson("/api/cloud/chat", { prompt: "hello" }),
    ).resolves.toEqual({
      text: "cloud answer",
      promptTokens: 0,
      completionTokens: 0,
      modelId: "cloud-model",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1/bridge",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer cloud-token",
        }),
      }),
    );
    const requestBody = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(requestBody).toMatchObject({
      jsonrpc: "2.0",
      method: "message.send",
      params: { text: "hello" },
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
    await expect(
      getJson("/api/secrets/manager/backends"),
    ).resolves.toMatchObject({
      backends: [
        {
          id: "in-house",
          available: false,
        },
      ],
    });
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

  it("serves transcript CRUD from the local transcript store", async () => {
    const localStorage = stubLocalStorage();
    vi.stubGlobal("window", { localStorage });

    // Empty list before anything is recorded.
    await expect(getJson("/api/transcripts")).resolves.toEqual({
      transcripts: [],
    });

    // Invalid create: segments are required.
    const invalid = await post("/api/transcripts", { segments: [] });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({
      error: "segments are required",
    });

    const createResponse = await post("/api/transcripts", {
      title: "Standup",
      roomId: "room-1",
      segments: [
        {
          id: "seg-1",
          speakerLabel: "Speaker 1",
          startMs: 0,
          endMs: 1500,
          text: "hello from the meeting",
          words: [],
        },
      ],
      audioBase64: "AAAA",
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      transcript: {
        id: string;
        title: string;
        durationMs: number;
        speakerCount: number;
        audioUrl?: string;
      };
    };
    expect(created.transcript).toMatchObject({
      title: "Standup",
      durationMs: 1500,
      speakerCount: 1,
      status: "ready",
      audioUrl: "data:audio/wav;base64,AAAA",
      audioContentType: "audio/wav",
    });
    const id = created.transcript.id;

    // List returns the summary projection; roomId filters.
    await expect(getJson("/api/transcripts")).resolves.toMatchObject({
      transcripts: [
        {
          id,
          title: "Standup",
          preview: "hello from the meeting",
          hasAudio: true,
          speakerCount: 1,
        },
      ],
    });
    await expect(
      getJson("/api/transcripts?roomId=room-1"),
    ).resolves.toMatchObject({
      transcripts: [{ id }],
    });
    await expect(getJson("/api/transcripts?roomId=other")).resolves.toEqual({
      transcripts: [],
    });

    // Get by id returns the full record; unknown ids are 404.
    await expect(
      getJson(`/api/transcripts/${encodeURIComponent(id)}`),
    ).resolves.toMatchObject({
      transcript: { id, segments: [expect.objectContaining({ id: "seg-1" })] },
    });
    const missing = await handleIosLocalAgentRequest(
      new Request("http://127.0.0.1:31337/api/transcripts/nope"),
    );
    expect(missing.status).toBe(404);

    // Update validates its body and re-derives timing metadata.
    const emptyPatch = await handleIosLocalAgentRequest(
      new Request(`http://127.0.0.1:31337/api/transcripts/${id}`, {
        method: "PUT",
        body: JSON.stringify({}),
      }),
    );
    expect(emptyPatch.status).toBe(400);
    const updateResponse = await handleIosLocalAgentRequest(
      new Request(`http://127.0.0.1:31337/api/transcripts/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          title: "Renamed",
          segments: [
            { id: "seg-1", startMs: 0, endMs: 2500, text: "edited", words: [] },
          ],
        }),
      }),
    );
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({
      transcript: { id, title: "Renamed", durationMs: 2500, speakerCount: 0 },
    });

    // Delete removes the record.
    const deleteResponse = await handleIosLocalAgentRequest(
      new Request(`http://127.0.0.1:31337/api/transcripts/${id}`, {
        method: "DELETE",
      }),
    );
    await expect(deleteResponse.json()).resolves.toEqual({ ok: true });
    await expect(getJson("/api/transcripts")).resolves.toEqual({
      transcripts: [],
    });
  });

  it("serves the memory feed and browse routes from local conversations", async () => {
    const localStorage = stubLocalStorage();
    vi.stubGlobal("window", { localStorage });
    localStorage.setItem(
      "eliza:ios-local-agent:conversations:v1",
      JSON.stringify({
        conversations: [
          {
            id: "conv-1",
            title: "First",
            roomId: "room-1",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            messages: [
              { id: "m1", role: "user", text: "hello eliza", timestamp: 100 },
              { id: "m2", role: "assistant", text: "hi there", timestamp: 200 },
              { id: "m3", role: "assistant", text: "   ", timestamp: 300 },
            ],
          },
        ],
      }),
    );

    // Feed: newest first, blank messages excluded, envelope matches the server.
    await expect(getJson("/api/memories/feed")).resolves.toEqual({
      memories: [
        expect.objectContaining({
          id: "m2",
          type: "messages",
          text: "hi there",
          roomId: "room-1",
          createdAt: 200,
          entityId: null,
        }),
        expect.objectContaining({ id: "m1", createdAt: 100 }),
      ],
      count: 2,
      limit: 50,
      hasMore: false,
    });

    // Feed pagination + before cursor + clamped limit.
    await expect(getJson("/api/memories/feed?limit=1")).resolves.toMatchObject({
      memories: [expect.objectContaining({ id: "m2" })],
      count: 1,
      limit: 1,
      hasMore: true,
    });
    await expect(
      getJson("/api/memories/feed?before=200"),
    ).resolves.toMatchObject({
      memories: [expect.objectContaining({ id: "m1" })],
      count: 1,
    });
    await expect(
      getJson("/api/memories/feed?limit=junk"),
    ).resolves.toMatchObject({ limit: 50 });
    await expect(
      getJson("/api/memories/feed?limit=100000"),
    ).resolves.toMatchObject({ limit: 100 });

    // A known non-message table filter yields no local rows.
    await expect(getJson("/api/memories/feed?type=facts")).resolves.toEqual({
      memories: [],
      count: 0,
      limit: 50,
      hasMore: false,
    });

    // Browse: search + offset paging + entity filters (no local entity graph).
    await expect(getJson("/api/memories/browse")).resolves.toMatchObject({
      total: 2,
      limit: 50,
      offset: 0,
    });
    await expect(
      getJson("/api/memories/browse?q=hello"),
    ).resolves.toMatchObject({
      memories: [expect.objectContaining({ id: "m1" })],
      total: 1,
    });
    await expect(
      getJson("/api/memories/browse?offset=1&limit=1"),
    ).resolves.toMatchObject({
      memories: [expect.objectContaining({ id: "m1" })],
      total: 2,
      offset: 1,
    });
    await expect(
      getJson("/api/memories/browse?entityId=someone"),
    ).resolves.toMatchObject({ memories: [], total: 0 });
    await expect(
      getJson("/api/memories/by-entity/someone"),
    ).resolves.toMatchObject({
      entityId: "someone",
      memories: [],
      total: 0,
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
