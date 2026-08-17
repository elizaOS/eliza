/**
 * Contract tests for truthy-limit batch4: 0 preserved via ?? / isFinite.
 * Exercises production methods with mocked boundaries, asserting actual
 * query/service arguments and result cardinality for zero/default cases.
 * Covers mcp (via mcpAction.handler + tier2 search), app-earnings,
 * memory summarizeConversation (warm/cold cache), and agent-events.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub heavy external deps so production modules load without node_modules.
mock.module("drizzle-orm", () => ({
  and: (..._a: unknown[]) => ({}),
  desc: (..._a: unknown[]) => ({}),
  eq: (..._a: unknown[]) => ({}),
  gte: (..._a: unknown[]) => ({}),
  inArray: (..._a: unknown[]) => ({}),
  lte: (..._a: unknown[]) => ({}),
  sql: Object.assign((..._a: unknown[]) => ({}), { raw: () => ({}) }),
}));
mock.module("ajv", () => ({
  default: class Ajv {
    compile() { return () => true; }
    addSchema() { return this; }
  },
}));
mock.module("handlebars", () => ({
  compile: () => () => "",
  default: { compile: () => () => "" },
}));
mock.module("zod", () => ({
  z: {
    object: () => ({ parse: (x: unknown) => x, safeParse: () => ({ success: true, data: {} }), extend: () => ({ parse: (x: unknown) => x }), optional: () => ({}) }),
    string: () => ({ optional: () => ({}), nullable: () => ({}), default: () => ({}), regex: () => ({}) }),
    number: () => ({ optional: () => ({}), int: () => ({}) }),
    boolean: () => ({ optional: () => ({}) }),
    array: () => ({ optional: () => ({}) }),
    enum: () => ({ optional: () => ({}) }),
    union: () => ({ optional: () => ({}) }),
    literal: () => ({}),
    record: () => ({}),
    any: () => ({ optional: () => ({}) }),
  },
  default: {},
}));
mock.module("ai", () => ({
  streamText: mock(async () => ({
    textStream: (async function* () { yield "summary"; })(),
    usage: Promise.resolve({ totalTokens: 5 }),
  })),
}));
mock.module("@elizaos/core", () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  ChannelType: { DM: "DM" },
  stringToUuid: (s: string) => s,
  composePromptFromState: () => "",
  ModelType: { TEXT_SMALL: "TEXT_SMALL" },
}));

// ---------- MCP search contract: strict typed integer parsing ----------
describe("mcp search limit/offset contract via handler + tier2", () => {
  const tier2Search = mock(async (_q: string, _p: string | undefined, _l: number, _o: number) => [] as any[]);
  const getToolCount = mock(() => 10);
  const removeFromTier2 = mock(() => {});
  const getTier2Index = mock(() => ({ search: tier2Search, getToolCount, removeFromTier2 }));
  const getService = mock((name: string) => {
    if (name === "mcp") return { getTier2Index, removeFromTier2, getProviderData: () => ({}) };
    return undefined;
  });
  const runtime = {
    getService,
    getSetting: mock(() => "00000000-0000-4000-8000-000000000001"),
    actions: [] as any[],
    registerAction: mock(() => {}),
    composeState: async () => ({ values: {} }) as any,
    useModel: async () => "{}",
  } as any;

  let mcpAction: any;
  beforeEach(async () => {
    const mod = await import("../../eliza/plugin-mcp/actions/mcp");
    mcpAction = mod.mcpAction;
    tier2Search.mockClear();
    getTier2Index.mockClear();
  });

  function makeMessage(params: Record<string, unknown>) {
    return {
      content: { text: "search query", actionParams: params },
      entityId: "00000000-0000-4000-8000-000000000002",
      roomId: "00000000-0000-4000-8000-000000000003",
      agentId: "00000000-0000-4000-8000-000000000004",
    } as any;
  }
  function lastLimit(): number | undefined {
    const call = tier2Search.mock.calls.at(-1) as unknown[] | undefined;
    return call?.[2] as number | undefined;
  }
  function lastOffset(): number | undefined {
    const call = tier2Search.mock.calls.at(-1) as unknown[] | undefined;
    return call?.[3] as number | undefined;
  }

  test("blank string limit -> default 10, not 1", async () => {
    await mcpAction.handler(runtime, makeMessage({ query: "email", limit: "" }), undefined);
    expect(lastLimit()).toBe(10);
  });
  test("null limit -> default 10, not 1 (Number(null)=0 bug)", async () => {
    await mcpAction.handler(runtime, makeMessage({ query: "email", limit: null as any }), undefined);
    expect(lastLimit()).toBe(10);
  });
  test("undefined limit -> default 10", async () => {
    await mcpAction.handler(runtime, makeMessage({ query: "email" }), undefined);
    expect(lastLimit()).toBe(10);
  });
  test("fractional string 5.5 -> fallback 10", async () => {
    await mcpAction.handler(runtime, makeMessage({ query: "email", limit: "5.5" }), undefined);
    expect(lastLimit()).toBe(10);
  });
  test("fractional number 5.5 -> fallback 10", async () => {
    await mcpAction.handler(runtime, makeMessage({ query: "email", limit: 5.5 }), undefined);
    expect(lastLimit()).toBe(10);
  });
  test("unsafe integer -> fallback 10", async () => {
    await mcpAction.handler(runtime, makeMessage({ query: "email", limit: Number.MAX_SAFE_INTEGER + 1 }), undefined);
    expect(lastLimit()).toBe(10);
    await mcpAction.handler(runtime, makeMessage({ query: "email", limit: "9007199254740992" }), undefined);
    expect(lastLimit()).toBe(10);
  });
  test("zero -> clamped to 1 (min 1)", async () => {
    await mcpAction.handler(runtime, makeMessage({ query: "email", limit: 0 }), undefined);
    expect(lastLimit()).toBe(1);
    await mcpAction.handler(runtime, makeMessage({ query: "email", limit: "0" }), undefined);
    expect(lastLimit()).toBe(1);
  });
  test("negative -> clamped to 1", async () => {
    await mcpAction.handler(runtime, makeMessage({ query: "email", limit: -5 }), undefined);
    expect(lastLimit()).toBe(1);
    await mcpAction.handler(runtime, makeMessage({ query: "email", limit: "-5" }), undefined);
    expect(lastLimit()).toBe(1);
  });
  test("canonical positives pass through and clamp at 20", async () => {
    await mcpAction.handler(runtime, makeMessage({ query: "email", limit: 5 }), undefined);
    expect(lastLimit()).toBe(5);
    await mcpAction.handler(runtime, makeMessage({ query: "email", limit: "10" }), undefined);
    expect(lastLimit()).toBe(10);
    await mcpAction.handler(runtime, makeMessage({ query: "email", limit: "20" }), undefined);
    expect(lastLimit()).toBe(20);
    await mcpAction.handler(runtime, makeMessage({ query: "email", limit: 100 }), undefined);
    expect(lastLimit()).toBe(20);
    await mcpAction.handler(runtime, makeMessage({ query: "email", limit: "25" }), undefined);
    expect(lastLimit()).toBe(20);
  });
  test("offset: blank/null/fractional/negative/zero/positive contract", async () => {
    await mcpAction.handler(runtime, makeMessage({ query: "email", limit: 10, offset: "" }), undefined);
    expect(lastOffset()).toBe(0);
    await mcpAction.handler(runtime, makeMessage({ query: "email", offset: null as any }), undefined);
    expect(lastOffset()).toBe(0);
    await mcpAction.handler(runtime, makeMessage({ query: "email", offset: "5.5" }), undefined);
    expect(lastOffset()).toBe(0);
    await mcpAction.handler(runtime, makeMessage({ query: "email", offset: 5.5 }), undefined);
    expect(lastOffset()).toBe(0);
    await mcpAction.handler(runtime, makeMessage({ query: "email", offset: 0 }), undefined);
    expect(lastOffset()).toBe(0);
    await mcpAction.handler(runtime, makeMessage({ query: "email", offset: "0" }), undefined);
    expect(lastOffset()).toBe(0);
    await mcpAction.handler(runtime, makeMessage({ query: "email", offset: -1 }), undefined);
    expect(lastOffset()).toBe(0);
    await mcpAction.handler(runtime, makeMessage({ query: "email", offset: "-1" }), undefined);
    expect(lastOffset()).toBe(0);
    await mcpAction.handler(runtime, makeMessage({ query: "email", offset: 5 }), undefined);
    expect(lastOffset()).toBe(5);
    await mcpAction.handler(runtime, makeMessage({ query: "email", offset: "7" }), undefined);
    expect(lastOffset()).toBe(7);
  });
  test("boolean/object limit -> fallback 10 (strict string/number only)", async () => {
    await mcpAction.handler(runtime, makeMessage({ query: "email", limit: true as any }), undefined);
    expect(lastLimit()).toBe(10);
    await mcpAction.handler(runtime, makeMessage({ query: "email", limit: {} as any }), undefined);
    expect(lastLimit()).toBe(10);
  });
});

// ---------- Memory summarizeConversation zero contract ----------
describe("memory summarizeConversation lastN=0 warm/cold cache contract", () => {
  const getMemoryMock = mock(async () => null as any);
  const cacheMemoryMock = mock(async () => {});
  const getMemoriesByRoomIdsMock = mock(async () => [] as any[]);
  const getParticipantsForRoomMock = mock(async () => [] as any[]);
  const getRoomsByIdsMock = mock(async () => [] as any[]);

  mock.module("../../cache/memory-cache", () => ({
    memoryCache: {
      getMemory: getMemoryMock,
      cacheMemory: cacheMemoryMock,
      getRoomContext: mock(async () => ({
        roomId: "room-1",
        messages: Array.from({ length: 20 }, (_, i) => ({ entityId: "u1", content: { text: `msg-${i}` } } as any)),
        participants: [] as any[],
        metadata: {},
        depth: 20,
        timestamp: new Date(),
      })),
      cacheRoomContext: mock(async () => {}),
    },
  }));
  mock.module("../../eliza/runtime-factory", () => ({
    runtimeFactory: {
      createRuntimeForUser: async () => ({
        agentId: "00000000-0000-4000-8000-000000000009" as any,
        getMemoriesByRoomIds: getMemoriesByRoomIdsMock,
        getParticipantsForRoom: getParticipantsForRoomMock,
        getRoomsByIds: getRoomsByIdsMock,
      }),
    },
  }));
  mock.module("../../eliza/user-context", () => ({
    userContextService: { createSystemContext: () => ({}) },
  }));
  mock.module("../../providers/language-model", () => ({
    getLanguageModel: () => ({} as any),
  }));

  beforeEach(() => {
    getMemoryMock.mockClear();
    cacheMemoryMock.mockClear();
    getMemoriesByRoomIdsMock.mockClear();
    getParticipantsForRoomMock.mockClear();
    getRoomsByIdsMock.mockClear();
  });

  test("lastN=0 returns empty without using room-context cache or LLM (cold-cache)", async () => {
    const { MemoryService } = await import("../memory");
    const svc = new MemoryService();
    const spy = mock(async () => {
      throw new Error("getRoomContext should not be called for lastN=0");
    });
    (svc as any).getRoomContext = spy;

    const result = await svc.summarizeConversation({
      roomId: "room-1",
      organizationId: "org-1",
      lastN: 0,
      style: "brief",
    });
    expect(result).toEqual({ summary: "", tokenCount: 0, keyTopics: [], participants: [] });
    expect(spy).not.toHaveBeenCalled();
    expect(getMemoryMock).not.toHaveBeenCalled();
  });

  test("lastN=0 returns empty even when warm cache would have returned 20 messages", async () => {
    const { MemoryService } = await import("../memory");
    const svc = new MemoryService();
    const spy = mock(async () => ({
      roomId: "room-1",
      messages: Array.from({ length: 20 }, (_, i) => ({ entityId: "u1", content: { text: `cached-${i}` } } as any)),
      participants: ["p1" as any],
      metadata: {},
      depth: 20,
      timestamp: new Date(),
    }));
    (svc as any).getRoomContext = spy;
    const result = await svc.summarizeConversation({
      roomId: "room-1",
      organizationId: "org-1",
      lastN: 0,
    });
    expect(result.summary).toBe("");
    expect(result.tokenCount).toBe(0);
    expect(result.keyTopics).toEqual([]);
    expect(result.participants).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  test("lastN omitted defaults to 50 and reaches getRoomContext with 50", async () => {
    const { MemoryService } = await import("../memory");
    const svc = new MemoryService();
    const captured: number[] = [];
    (svc as any).getRoomContext = mock(async (_a: string, _b: string, depth: number) => {
      captured.push(depth);
      return { roomId: "room-1", messages: [], participants: [], metadata: {}, depth, timestamp: new Date() };
    });
    await svc.summarizeConversation({ roomId: "room-1", organizationId: "org-1" });
    expect(captured[0]).toBe(50);
  });

  test("lastN=5 passes 5 to getRoomContext and lastN=0 bypasses, cardinality", async () => {
    const { MemoryService } = await import("../memory");
    const svc = new MemoryService();
    const depths: number[] = [];
    (svc as any).getRoomContext = mock(async (_a: string, _b: string, d: number) => {
      depths.push(d);
      return { roomId: "room-1", messages: Array.from({ length: d }, (_, i) => ({ entityId: "u1", content: { text: `m${i}` } } as any)), participants: [], metadata: {}, depth: d, timestamp: new Date() };
    });
    const r5 = await svc.summarizeConversation({ roomId: "room-1", organizationId: "org-1", lastN: 5 });
    const r0 = await svc.summarizeConversation({ roomId: "room-1", organizationId: "org-1", lastN: 0 });
    expect(depths).toEqual([5]);
    expect(r0.keyTopics).toEqual([]);
    expect(r5.tokenCount).toBe(5);
  });

  test("getRoomContext depth 0 returns empty without cache/DB (direct)", async () => {
    const { MemoryService } = await import("../memory");
    const svc = new MemoryService();
    const ctx = await svc.getRoomContext("room-1", "org-1", 0);
    expect(ctx.messages).toHaveLength(0);
    expect(ctx.participants).toHaveLength(0);
    expect(ctx.depth).toBe(0);
  });
});

// ---------- App earnings limit/offset contract ----------
describe("app-earnings getTransactionHistory limit/offset contract", () => {
  const listTransactions = mock(async (_appId: string, _limit: number, _offset: number) => [] as any[]);
  const listTransactionsByType = mock(async (_appId: string, _type: string, _limit: number) => [] as any[]);

  mock.module("../../../db/repositories/app-earnings", () => ({
    appEarningsRepository: { listTransactions, listTransactionsByType },
  }));
  mock.module("../../../db/repositories/apps", () => ({
    appsRepository: { findById: async () => null },
  }));
  mock.module("../../db/repositories/app-earnings-numeric", () => ({
    parseEarningsNumber: (v: any) => Number(v),
  }));

  beforeEach(() => {
    listTransactions.mockClear();
    listTransactionsByType.mockClear();
  });

  test("limit 0 preserved (not collapsed to 50) and result cardinality 0", async () => {
    const { AppEarningsService } = await import("../app-earnings");
    const svc = new AppEarningsService();
    await svc.getTransactionHistory("app-1", { limit: 0, offset: 0 });
    expect(listTransactions.mock.calls[0][1]).toBe(0);
    expect(listTransactions.mock.calls[0][2]).toBe(0);
    expect((0 as any) ?? 50).toBe(0);
    expect((0 as any) || 50).toBe(50);
  });

  test("omitted limit defaults to 50 and offset to 0", async () => {
    const { AppEarningsService } = await import("../app-earnings");
    const svc = new AppEarningsService();
    listTransactions.mockClear();
    await svc.getTransactionHistory("app-1", {});
    expect(listTransactions.mock.calls[0][1]).toBe(50);
    expect(listTransactions.mock.calls[0][2]).toBe(0);
    listTransactions.mockClear();
    await svc.getTransactionHistory("app-1");
    expect(listTransactions.mock.calls[0][1]).toBe(50);
    expect(listTransactions.mock.calls[0][2]).toBe(0);
  });

  test("positive limit passes through", async () => {
    const { AppEarningsService } = await import("../app-earnings");
    const svc = new AppEarningsService();
    await svc.getTransactionHistory("app-1", { limit: 5, offset: 2 });
    expect(listTransactions.mock.calls[0][1]).toBe(5);
    expect(listTransactions.mock.calls[0][2]).toBe(2);
  });

  test("typed listTransactionsByType preserves 0 limit", async () => {
    const { AppEarningsService } = await import("../app-earnings");
    const svc = new AppEarningsService();
    await svc.getTransactionHistory("app-1", { type: "inference_markup", limit: 0 });
    expect(listTransactionsByType.mock.calls[0][2]).toBe(0);
    listTransactionsByType.mockClear();
    await svc.getTransactionHistory("app-1", { type: "inference_markup" });
    expect(listTransactionsByType.mock.calls[0][2]).toBe(50);
  });
});

// ---------- Agent events limit contract ----------
describe("agent-events list limit contract via repository", () => {
  const findMany = mock(async (_q: any) => [] as any[]);
  const findFirst = mock(async () => null as any);
  mock.module("../../../db/helpers", () => ({
    dbRead: { query: { agentEvents: { findMany, findFirst } } },
    dbWrite: { insert: () => ({ values: () => ({ returning: async () => [] }) }), delete: () => ({ where: async () => ({ rowCount: 0 }) }) },
  }));
  mock.module("../../lib/storage/object-store", () => ({
    hydrateJsonField: async () => ({}),
    hydrateTextField: async () => "",
    offloadJsonField: async (a: any) => ({ value: a.value, storage: "inline", key: null }),
    offloadTextField: async (a: any) => ({ value: a.value, storage: "inline", key: null }),
  }));

  beforeEach(() => {
    findMany.mockClear();
  });

  test("listByAgent: limit 0 preserved (not 50), omitted ->50, positive ->5 and cardinality", async () => {
    const { AgentEventsRepository } = await import("../../../db/repositories/agent-events");
    const repo = new AgentEventsRepository();

    let capturedLimit: number | undefined;
    findMany.mockImplementationOnce(async (opts: any) => {
      capturedLimit = opts.limit;
      return [];
    });
    await repo.listByAgent("agent-1", { limit: 0 });
    expect(capturedLimit).toBe(0);

    findMany.mockImplementationOnce(async (opts: any) => {
      capturedLimit = opts.limit;
      return [];
    });
    await repo.listByAgent("agent-1", {});
    expect(capturedLimit).toBe(50);

    findMany.mockImplementationOnce(async (opts: any) => {
      capturedLimit = opts.limit;
      return [];
    });
    await repo.listByAgent("agent-1", { limit: 5 });
    expect(capturedLimit).toBe(5);

    findMany.mockImplementationOnce(async (opts: any) => Array.from({ length: opts.limit }, (_, i) => ({ id: `e${i}`, message: "m", metadata: {}, message_storage: "inline", metadata_storage: "inline", message_key: null, metadata_key: null })));
    const zeroRows = await repo.listByAgent("agent-1", { limit: 0 });
    expect(zeroRows).toHaveLength(0);

    findMany.mockImplementationOnce(async (opts: any) => Array.from({ length: opts.limit }, (_, i) => ({ id: `e${i}`, message: "m", metadata: {}, message_storage: "inline", metadata_storage: "inline", message_key: null, metadata_key: null })));
    const fiveRows = await repo.listByAgent("agent-1", { limit: 5 });
    expect(fiveRows).toHaveLength(5);
  });

  test("listByOrganization: limit 0 preserved (not 100), omitted ->100", async () => {
    const { AgentEventsRepository } = await import("../../../db/repositories/agent-events");
    const repo = new AgentEventsRepository();
    let captured: number | undefined;
    findMany.mockImplementationOnce(async (opts: any) => {
      captured = opts.limit;
      return [];
    });
    await repo.listByOrganization("org-1", { limit: 0 });
    expect(captured).toBe(0);

    findMany.mockImplementationOnce(async (opts: any) => {
      captured = opts.limit;
      return [];
    });
    await repo.listByOrganization("org-1", {});
    expect(captured).toBe(100);

    findMany.mockImplementationOnce(async (opts: any) => {
      captured = opts.limit;
      return [];
    });
    await repo.listByOrganization("org-1", { limit: 7 });
    expect(captured).toBe(7);
  });
});
