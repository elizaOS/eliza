/**
 * Tests `applyScenarioSeedStep` (seeds.ts) against a runtime stub, covering the
 * todo / contact / memory / LifeOps / Gmail-inbox seed types. Gmail seeding is
 * exercised through a real local HTTP server so the loopback-URL gate is hit.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntime, UUID } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioSeedStep,
} from "@elizaos/scenario-runner/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyScenarioSeedStep } from "./seeds";

type MockRequest = {
  method: string;
  path: string;
  body: Record<string, unknown>;
};

let activeServer: http.Server | null = null;
const originalGoogleBase = process.env.ELIZA_MOCK_GOOGLE_BASE;

afterEach(async () => {
  process.env.ELIZA_MOCK_GOOGLE_BASE = originalGoogleBase;
  if (!activeServer) return;
  await new Promise<void>((resolve, reject) => {
    activeServer?.close((error) => (error ? reject(error) : resolve()));
  });
  activeServer = null;
});

async function readRequestBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function startGmailSeedMock(): Promise<{
  baseUrl: string;
  requests: MockRequest[];
}> {
  const requests: MockRequest[] = [];
  const fixtureIds = new Set(["msg-finance", "msg-sarah", "msg-newsletter"]);

  activeServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = (req.method ?? "GET").toUpperCase();
    const body = await readRequestBody(req);
    requests.push({ method, path: url.pathname, body });

    if (method === "DELETE" && url.pathname === "/__mock/google/gmail/fault") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (method === "DELETE" && url.pathname === "/__mock/requests") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (method === "POST" && url.pathname === "/__mock/google/gmail/fault") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, fault: body }));
      return;
    }
    const messageId = url.pathname.match(
      /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/,
    )?.[1];
    if (method === "GET" && messageId && fixtureIds.has(messageId)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: messageId, threadId: messageId }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve, reject) => {
    activeServer?.once("error", reject);
    activeServer?.listen(0, "127.0.0.1", () => resolve());
  });

  const address = activeServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Gmail seed mock did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    requests,
  };
}

const gmailSeedContext: ScenarioContext = { actionsCalled: [] };

type ConnectorContributionForTest = {
  kind: string;
  capabilities: string[];
  modes: Array<"local" | "cloud">;
  describe: { label: string };
  start: () => Promise<void>;
  disconnect: () => Promise<void>;
  verify: () => Promise<boolean>;
  status: () => Promise<{
    state: "ok" | "degraded" | "disconnected";
    message?: string;
    observedAt: string;
  }>;
  send?: (payload: unknown) => Promise<unknown>;
};

type ConnectorRegistryModuleForTest = {
  createConnectorRegistry: () => {
    register: (contribution: ConnectorContributionForTest) => void;
    get: (kind: string) => ConnectorContributionForTest | null;
    list: (filter?: {
      capability?: string;
      mode?: "local" | "cloud";
    }) => ConnectorContributionForTest[];
    byCapability: (capability: string) => ConnectorContributionForTest[];
  };
  getConnectorRegistry: (
    runtime: AgentRuntime,
  ) => ReturnType<
    ConnectorRegistryModuleForTest["createConnectorRegistry"]
  > | null;
  registerConnectorRegistry: (
    runtime: AgentRuntime,
    registry: ReturnType<
      ConnectorRegistryModuleForTest["createConnectorRegistry"]
    >,
  ) => void;
};

async function loadConnectorRegistryForTest(): Promise<ConnectorRegistryModuleForTest> {
  const specifier = new URL(
    "../../../plugins/plugin-personal-assistant/src/lifeops/connectors/registry.ts",
    import.meta.url,
  ).href;
  return import(specifier) as Promise<ConnectorRegistryModuleForTest>;
}

function createSeedContext() {
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
  } as unknown as AgentRuntime;
  return { runtime, ctx: { runtime } as ScenarioContext };
}

function createSeedHarness() {
  const relationships = {
    getContact: vi.fn(async () => null),
    addContact: vi.fn(async () => undefined),
    updateContact: vi.fn(async () => undefined),
    addHandle: vi.fn(async () => undefined),
    recordInteraction: vi.fn(async () => undefined),
    setRelationshipGoal: vi.fn(async () => undefined),
  };
  const createMemory = vi.fn(
    async (
      _memory: Record<string, unknown>,
      _tableName: string,
      _unique?: boolean,
    ) => "fact-id" as UUID,
  );
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    getService: vi.fn((serviceName: string) =>
      serviceName === "relationships" ? relationships : null,
    ),
    getEntityById: vi.fn(async () => null),
    createEntity: vi.fn(async () => undefined),
    createMemory,
  } as unknown as AgentRuntime;
  return {
    ctx: {
      runtime,
      scenarioId: "seed-test",
      primaryRoomId: "00000000-0000-0000-0000-0000000000aa",
      primaryUserId: "00000000-0000-0000-0000-0000000000bb",
    } as ScenarioContext,
    relationships,
    runtime,
    createMemory,
  };
}

function baseConnector(
  overrides: Partial<ConnectorContributionForTest> = {},
): ConnectorContributionForTest {
  return {
    kind: "telegram",
    capabilities: ["telegram.send"],
    modes: ["local"],
    describe: { label: "Telegram bridge" },
    start: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    verify: vi.fn(async () => true),
    status: vi.fn(async () => ({
      state: "ok" as const,
      observedAt: "2026-01-01T00:00:00.000Z",
    })),
    send: vi.fn(async () => ({ ok: true, messageId: "sent-1" })),
    ...overrides,
  };
}

describe("scenario memory seeds", () => {
  it("maps rolodex-entity memory seeds into relationship contacts", async () => {
    const { ctx, relationships, runtime } = createSeedHarness();

    const result = await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: {
        kind: "rolodex-entity",
        id: "ent-acme-buyer",
        displayName: "Tomas Reyes",
        company: "Acme Inc.",
        tags: ["vip"],
        handles: [{ platform: "gmail", handle: "tomas.reyes@acme.com" }],
      },
    } satisfies ScenarioSeedStep);

    expect(result).toBeUndefined();
    expect(runtime.createEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        names: ["Tomas Reyes"],
      }),
    );
    expect(relationships.addContact).toHaveBeenCalledWith(
      expect.any(String),
      ["acquaintance"],
      expect.objectContaining({
        notes: expect.stringContaining("Company: Acme Inc."),
      }),
      { displayName: "Tomas Reyes" },
    );
    expect(relationships.addHandle).toHaveBeenCalledWith(expect.any(String), {
      platform: "gmail",
      identifier: "tomas.reyes@acme.com",
      displayLabel: undefined,
      isPrimary: undefined,
    });
    expect(relationships.updateContact).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tags: ["vip"],
        relationshipStatus: "active",
      }),
    );
  });

  it("maps direct rolodex platform handles and recent news", async () => {
    const { ctx, relationships } = createSeedHarness();

    const result = await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: {
        kind: "rolodex-entity",
        name: "Alex Rivera",
        primaryChannel: "telegram",
        telegramHandle: "@arivera",
        recentNews: "promoted to VP Engineering at Acme",
      },
    } satisfies ScenarioSeedStep);

    expect(result).toBeUndefined();
    expect(relationships.addHandle).toHaveBeenCalledWith(expect.any(String), {
      platform: "telegram",
      identifier: "@arivera",
      displayLabel: "Alex Rivera",
      isPrimary: true,
    });
    expect(relationships.addContact).toHaveBeenCalledWith(
      expect.any(String),
      ["acquaintance"],
      expect.objectContaining({
        notes: expect.stringContaining(
          "Recent news: promoted to VP Engineering at Acme",
        ),
      }),
      { displayName: "Alex Rivera" },
    );
  });

  it("maps merged-entity memory seeds into relationship contacts with all handles", async () => {
    const { ctx, relationships, runtime } = createSeedHarness();

    const result = await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: {
        kind: "merged-entity",
        id: "ent-alex-lee-merged",
        displayName: "Alex Lee",
        handles: [
          {
            platform: "gmail",
            handle: "alex.lee@quanta.com",
            realPerson: "alex-1",
          },
          {
            platform: "telegram",
            handle: "@alexlee",
            realPerson: "alex-2",
          },
        ],
        mergedAccidentally: true,
      },
    } satisfies ScenarioSeedStep);

    expect(result).toBeUndefined();
    expect(runtime.createEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        names: ["Alex Lee"],
      }),
    );
    expect(relationships.addContact).toHaveBeenCalledWith(
      expect.any(String),
      ["merged-entity"],
      {
        notes:
          "Scenario entity id: ent-alex-lee-merged\n" +
          "Merged accidentally: true\n" +
          "gmail alex.lee@quanta.com real person: alex-1\n" +
          "telegram @alexlee real person: alex-2",
      },
      { displayName: "Alex Lee" },
    );
    const addedHandles = relationships.addHandle.mock.calls.map(
      (call) =>
        (
          call as unknown as [
            unknown,
            {
              platform: string;
              identifier: string;
            },
          ]
        )[1],
    );
    expect(addedHandles).toEqual([
      expect.objectContaining({
        platform: "gmail",
        identifier: "alex.lee@quanta.com",
      }),
      expect.objectContaining({
        platform: "telegram",
        identifier: "@alexlee",
      }),
    ]);
    expect(relationships.updateContact).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        relationshipStatus: "active",
        tags: ["merged-entity"],
      }),
    );
  });

  it("keeps direct platform handles and authored tags on merged-entity seeds", async () => {
    const { ctx, relationships } = createSeedHarness();

    await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: {
        kind: "merged-entity",
        platform: "discord",
        handle: "priyam#0042",
        tags: ["vip", "studio"],
      },
    } satisfies ScenarioSeedStep);

    expect(relationships.addHandle).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        platform: "discord",
        identifier: "priyam#0042",
      }),
    );
    expect(relationships.updateContact).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tags: ["vip", "studio"],
      }),
    );
  });

  it("writes plain-text memory seeds as durable owner facts in the facts table", async () => {
    const { ctx, createMemory } = createSeedHarness();

    const result = await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: {
        text: "Owner fact: largest account is Halcyon Freight; their contact sometimes messages from a plain personal address with no signature.",
      },
    } satisfies ScenarioSeedStep);

    expect(result).toBeUndefined();
    expect(createMemory).toHaveBeenCalledTimes(1);
    const [memory, tableName, unique] = createMemory.mock.calls[0];
    expect(tableName).toBe("facts");
    expect(unique).toBe(true);
    expect(memory.roomId).toBe(ctx.primaryRoomId);
    expect(memory.entityId).toBe(ctx.primaryUserId);
    expect(memory.content).toEqual({
      text: "Owner fact: largest account is Halcyon Freight; their contact sometimes messages from a plain personal address with no signature.",
    });
    // Durable kind is load-bearing: the FACTS provider's keyword-miss
    // fallback only applies to durable facts, which is what guarantees a
    // seeded fact surfaces even without lexical overlap with the turn text.
    expect(memory.metadata).toMatchObject({
      kind: "durable",
      source: "scenario-seed",
    });
  });

  it.each([
    [
      "profile",
      {
        homeTimezone: "America/Los_Angeles",
        loyalty: { marriott: "MR12345678" },
      },
    ],
    [
      "trip",
      {
        destination: "JFK",
        flight: { carrier: "United", flightNumber: "UA245" },
      },
    ],
    [
      "booking",
      {
        carrier: "United",
        flightNumber: "UA245",
        origin: "SFO",
        destination: "JFK",
      },
    ],
    [
      "upgrade-offer",
      {
        carrier: "United",
        flightNumber: "UA245",
        priceUSD: 480,
      },
    ],
    [
      "calendar-focus-window",
      {
        title: "Deep work — no travel",
        rule: "no-travel",
      },
    ],
  ])("writes %s structured travel memory seeds as durable owner facts", async (kind, fields) => {
    const { ctx, createMemory } = createSeedHarness();

    const result = await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: {
        kind,
        ...fields,
      },
    } satisfies ScenarioSeedStep);

    expect(result).toBeUndefined();
    expect(createMemory).toHaveBeenCalledTimes(1);
    const [memory, tableName, unique] = createMemory.mock.calls[0];
    expect(tableName).toBe("facts");
    expect(unique).toBe(true);
    expect(memory.roomId).toBe(ctx.primaryRoomId);
    expect(memory.entityId).toBe(ctx.primaryUserId);
    const memoryContent = memory.content as { text: string };
    expect(memoryContent.text).toContain(
      `Scenario-seeded travel ${kind} context:`,
    );
    for (const [key, value] of Object.entries(fields)) {
      expect(memoryContent.text).toContain(`"${key}"`);
      if (typeof value === "string" || typeof value === "number") {
        expect(memoryContent.text).toContain(String(value));
      }
    }
    expect(memory.metadata).toMatchObject({
      kind: "durable",
      source: "scenario-seed",
      seedKind: kind,
    });
  });

  it("fails the seed (never silently no-ops) on unsupported memory kinds", async () => {
    const { ctx, relationships, createMemory } = createSeedHarness();

    const result = await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: {
        kind: "inbound-message",
        text: "hello",
      },
    } satisfies ScenarioSeedStep);

    expect(result).toMatch(/unsupported memory seed kind "inbound-message"/);
    expect(createMemory).not.toHaveBeenCalled();
    expect(relationships.addContact).not.toHaveBeenCalled();
  });

  it("fails the seed when memory content has neither text nor a contact kind", async () => {
    const { ctx, createMemory } = createSeedHarness();

    const result = await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: {},
    } satisfies ScenarioSeedStep);

    expect(result).toMatch(/non-empty text or a contact-like kind/);
    expect(createMemory).not.toHaveBeenCalled();
  });

  it("fails the seed when the executor did not provide the primary room identity", async () => {
    const { ctx, createMemory } = createSeedHarness();
    delete (ctx as { primaryRoomId?: string }).primaryRoomId;

    const result = await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: { text: "Owner fact: something important." },
    } satisfies ScenarioSeedStep);

    expect(result).toMatch(/primaryRoomId/);
    expect(createMemory).not.toHaveBeenCalled();
  });
});

describe("scenario gmail seeds", () => {
  it("forwards bounded gmailInbox faultInjection to the loopback Google mock", async () => {
    const { baseUrl, requests } = await startGmailSeedMock();
    process.env.ELIZA_MOCK_GOOGLE_BASE = baseUrl;

    const result = await applyScenarioSeedStep(gmailSeedContext, {
      type: "gmailInbox",
      fixture: "default",
      faultInjection: { mode: "server_error", method: "GET", limit: 0 },
    } satisfies ScenarioSeedStep);

    expect(result).toBeUndefined();
    expect(
      requests.map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      "DELETE /__mock/google/gmail/fault",
      "GET /gmail/v1/users/me/messages/msg-finance",
      "GET /gmail/v1/users/me/messages/msg-sarah",
      "GET /gmail/v1/users/me/messages/msg-newsletter",
      "DELETE /__mock/requests",
      "POST /__mock/google/gmail/fault",
    ]);
    expect(requests.at(-1)?.body).toEqual({
      mode: "server_error",
      method: "GET",
      path: "/gmail/v1/users/me/messages",
      remaining: 0,
    });
  });

  it("defaults partial_failure gmailInbox faults to batchModify", async () => {
    const { baseUrl, requests } = await startGmailSeedMock();
    process.env.ELIZA_MOCK_GOOGLE_BASE = baseUrl;

    const result = await applyScenarioSeedStep(gmailSeedContext, {
      type: "gmailInbox",
      fixture: "default",
      faultInjection: { mode: "partial_failure" },
    } satisfies ScenarioSeedStep);

    expect(result).toBeUndefined();
    expect(
      requests.map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      "DELETE /__mock/google/gmail/fault",
      "GET /gmail/v1/users/me/messages/msg-finance",
      "GET /gmail/v1/users/me/messages/msg-sarah",
      "GET /gmail/v1/users/me/messages/msg-newsletter",
      "DELETE /__mock/requests",
      "POST /__mock/google/gmail/fault",
    ]);
    expect(requests.at(-1)?.body).toEqual({
      mode: "partial_failure",
      method: "POST",
      path: "/gmail/v1/users/me/messages/batchModify",
    });
  });

  it("rejects invalid gmailInbox faultInjection limits", async () => {
    const { baseUrl } = await startGmailSeedMock();
    process.env.ELIZA_MOCK_GOOGLE_BASE = baseUrl;

    const result = await applyScenarioSeedStep(gmailSeedContext, {
      type: "gmailInbox",
      faultInjection: { mode: "server_error", limit: -1 },
    } satisfies ScenarioSeedStep);

    expect(result).toContain("faultInjection.limit");
  });
});

describe("scenario connector seeds", () => {
  it("registers connectorStatus seeds as degraded connector contributions", async () => {
    const { ctx, runtime } = createSeedContext();
    const { getConnectorRegistry } = await loadConnectorRegistryForTest();

    const result = await applyScenarioSeedStep(ctx, {
      type: "connectorStatus",
      connector: "gmail",
      provider: "Gmail API",
      state: "missing-scope",
      capabilities: ["google.gmail.triage"],
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    } as ScenarioSeedStep);

    expect(result).toBeUndefined();
    const registry = getConnectorRegistry(runtime);
    const connector = registry?.get("gmail");
    expect(connector?.describe.label).toBe("Gmail API");
    expect(connector?.capabilities).toEqual([
      "google.gmail.triage",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
    await expect(connector?.status()).resolves.toMatchObject({
      state: "degraded",
      message: "Gmail API seeded missing scope",
    });
  });

  it("overrides existing connector auth status and send failures", async () => {
    const { ctx, runtime } = createSeedContext();
    const {
      createConnectorRegistry,
      getConnectorRegistry,
      registerConnectorRegistry,
    } = await loadConnectorRegistryForTest();
    const base = createConnectorRegistry();
    base.register(baseConnector());
    registerConnectorRegistry(runtime, base);

    await applyScenarioSeedStep(ctx, {
      type: "connectorAuthSession",
      connector: "telegram",
      provider: "Telegram bridge",
      state: "auth-expired",
    } as ScenarioSeedStep);

    const connector = getConnectorRegistry(runtime)?.get("telegram");
    await expect(connector?.status()).resolves.toMatchObject({
      state: "disconnected",
      message: "Telegram bridge seeded auth expired",
    });
    await expect(connector?.send?.({ text: "hello" })).resolves.toMatchObject({
      ok: false,
      reason: "auth_expired",
      userActionable: true,
    });
  });

  it("limits transportFault failures before delegating to the base sender", async () => {
    const { ctx, runtime } = createSeedContext();
    const {
      createConnectorRegistry,
      getConnectorRegistry,
      registerConnectorRegistry,
    } = await loadConnectorRegistryForTest();
    const base = createConnectorRegistry();
    base.register(
      baseConnector({
        kind: "whatsapp",
        capabilities: ["whatsapp.send"],
        describe: { label: "WhatsApp bridge" },
      }),
    );
    registerConnectorRegistry(runtime, base);

    await applyScenarioSeedStep(ctx, {
      type: "transportFault",
      connector: "whatsapp",
      provider: "WhatsApp bridge",
      state: "rate-limited",
      limit: 1,
    } as ScenarioSeedStep);

    const connector = getConnectorRegistry(runtime)?.get("whatsapp");
    await expect(connector?.status()).resolves.toMatchObject({
      state: "degraded",
      message: "WhatsApp bridge seeded rate limited",
    });
    await expect(connector?.send?.({ text: "first" })).resolves.toMatchObject({
      ok: false,
      reason: "rate_limited",
      retryAfterMinutes: 5,
      userActionable: false,
    });
    await expect(connector?.send?.({ text: "second" })).resolves.toMatchObject({
      ok: true,
      messageId: "sent-1",
    });
  });
});
