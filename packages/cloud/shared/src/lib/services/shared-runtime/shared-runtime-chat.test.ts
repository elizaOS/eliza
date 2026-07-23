/**
 * Covers the cache-only shared chat engine across response and SSE boundaries.
 *
 * Real history-store and waitUntil contracts are used; only model and money
 * providers are deterministic seams.
 */

process.env.MOCK_REDIS = "1";

import { beforeEach, describe, expect, mock, test } from "bun:test";

let turn: Record<string, unknown>;
let streamTurn: Record<string, unknown>;
let admissionError: Error | null;
let billError: Error | null;
let billingGate: Promise<void> | null;
let releaseBilling = () => {};
const settleCalls: number[] = [];
const billCalls: unknown[] = [];
let characterReads = 0;

mock.module("../organization-inference-admission", () => ({
  admitOrganizationInference: async (params: {
    executionCtx?: { waitUntil(promise: Promise<unknown>): void };
  }) => {
    if (admissionError) throw admissionError;
    params.executionCtx?.waitUntil(Promise.resolve());
    return {
      mode: "deferred_kv_ledger",
      settle: async (cost: number) => {
        settleCalls.push(cost);
        return null;
      },
    };
  },
}));
mock.module("../ai-billing", () => ({
  estimateInputTokens: () => 12,
  reserveCredits: async () => {
    throw new Error("synchronous reserve must not run");
  },
  billUsage: async (...args: unknown[]) => {
    billCalls.push(args);
    if (billingGate) await billingGate;
    if (billError) throw billError;
    return { totalCost: 0.004, inputTokens: 12, outputTokens: 4 };
  },
  recordUsageAnalytics: async () => null,
  InsufficientCreditsError: class InsufficientCreditsError extends Error {
    required = 1;
    available = 0;
  },
}));
mock.module("../ai-billing-records", () => ({
  aiBillingRecordsService: { record: async () => undefined },
}));
mock.module("../../../db/repositories/characters", () => ({
  userCharactersRepository: {
    findByIdInOrganization: async (id: string) => {
      characterReads++;
      return {
        id,
        organization_id: agent.organization_id,
        name: "Cached Nova",
        system: "Be cached.",
      };
    },
  },
}));
mock.module("./run-shared-agent-turn", () => ({
  resolveSharedAgentTurnModel: () => "openai/gpt-oss-120b",
  runSharedAgentTurn: async () => turn,
  runSharedAgentTurnStream: async () => streamTurn,
}));

// Sibling suites in the same bun process mock ../../cache/client globally with
// partial doubles (server-wallets-provision-proof exposes only setIfNotExists;
// resolve-shared-agent substitutes its own get/set), and bun's mock.module
// patches the process-wide registry — so batch composition decided whether the
// character-hydration get/set flow here saw a working cache. Pin this suite's
// own Map-backed double instead. It cannot be built from the real module: a
// sibling that loaded first has already replaced the registry entry, so an
// import here returns that sibling's partial mock, not the real exports.
const localCacheStore = new Map<string, unknown>();
mock.module("../../cache/client", () => ({
  NEGATIVE_CACHE_SENTINEL: { __none: true },
  cache: {
    isAvailable: () => true,
    get: async (key: string) => (localCacheStore.has(key) ? localCacheStore.get(key) : null),
    set: async (key: string, value: unknown) => {
      localCacheStore.set(key, value);
      return { ok: true };
    },
    getOrSet: async (key: string, compute: () => Promise<unknown>) => {
      if (localCacheStore.has(key)) return localCacheStore.get(key);
      const value = await compute();
      localCacheStore.set(key, value);
      return value;
    },
    setIfNotExists: async (key: string) => {
      if (localCacheStore.has(key)) return false;
      localCacheStore.set(key, "1");
      return true;
    },
  },
}));

const { InsufficientCreditsError } = await import("../ai-billing");
const { SharedRuntimeChatService } = await import("./shared-runtime-chat");

const agent = {
  id: "00000000-0000-4000-8000-000000000001",
  organization_id: "00000000-0000-4000-8000-000000000002",
  user_id: "00000000-0000-4000-8000-000000000003",
  execution_tier: "shared",
  agent_name: "Nova",
  character_id: null,
  agent_config: {
    character: {
      name: "Nova",
      system: "Be useful.",
      model: "openai/gpt-oss-120b",
    },
  },
} as never;
const rpc = {
  jsonrpc: "2.0" as const,
  id: "turn-1",
  method: "message.send",
  params: { text: "hello", roomId: "room-1" },
};

function harness() {
  let history = [{ role: "assistant" as const, content: "prior" }];
  const background: Promise<unknown>[] = [];
  return {
    background,
    historyStore: {
      load: async () => history,
      save: async (_agentId: string, _channelId: string, next: typeof history) => {
        history = next;
      },
    },
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    },
    history: () => history,
  };
}

beforeEach(() => {
  settleCalls.length = 0;
  billCalls.length = 0;
  admissionError = null;
  billError = null;
  characterReads = 0;
  billingGate = null;
  releaseBilling = () => {};
  turn = {
    degraded: false,
    reply: "hello back",
    history: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hello back" },
    ],
    model: "openai/gpt-oss-120b",
  };
  streamTurn = {
    degraded: false,
    parts: (async function* () {
      yield { type: "text-delta", text: "hello " };
      yield {
        type: "finish",
        text: "hello back",
        usage: { inputTokens: 12, outputTokens: 4 },
      };
    })(),
  };
});

describe("SharedRuntimeChatService", () => {
  test("handles status, unknown methods, and invalid message input", async () => {
    const service = new SharedRuntimeChatService();
    expect((await service.bridge(agent, { ...rpc, method: "heartbeat" })).result).toMatchObject({
      ready: true,
      runtime: "shared",
    });
    expect((await service.bridge(agent, { ...rpc, method: "unknown" })).error?.code).toBe(-32601);
    expect(
      (
        await service.bridge(agent, {
          ...rpc,
          params: { text: " " },
        })
      ).error?.code,
    ).toBe(-32602);
  });

  test("returns before billing and persists ordered cache-local history", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    billingGate = new Promise((resolve) => {
      releaseBilling = resolve;
    });
    const response = await service.bridge(agent, rpc, h);
    expect(response.result?.text).toBe("hello back");
    expect(h.history()).toHaveLength(2);
    expect(h.background).toHaveLength(2);
    expect(settleCalls).toHaveLength(0);
    releaseBilling();
    await Promise.all(h.background);
    expect(billCalls).toHaveLength(1);
    expect(settleCalls).toEqual([0.004]);
  });

  test("cold linked character returns warming while hydration stays off path", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    const linkedAgent = {
      ...agent,
      character_id: "00000000-0000-4000-8000-000000000099",
    };

    await expect(service.bridge(linkedAgent, rpc, h)).rejects.toMatchObject({
      name: "SharedRuntimeCacheWarmingError",
    });
    expect(characterReads).toBe(1);
    await Promise.all(h.background.splice(0));

    expect((await service.bridge(linkedAgent, rpc, h)).result?.text).toBe("hello back");
    expect(characterReads).toBe(1);
  });

  test("degraded and failed turns release admission at zero", async () => {
    const service = new SharedRuntimeChatService();
    turn = {
      degraded: true,
      reply: "fallback",
      history: [],
      model: "openai/gpt-oss-120b",
    };
    expect((await service.bridge(agent, rpc, harness())).result?.degraded).toBe(true);
    expect(settleCalls).toEqual([0]);

    turn = {
      degraded: false,
      reply: "unused",
      get history() {
        throw new Error("turn failed");
      },
    };
    await expect(service.bridge(agent, rpc, harness())).rejects.toThrow("turn failed");
    expect(settleCalls.at(-1)).toBe(0);
  });

  test("billing failure is contained and retries settlement without changing cost", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    billError = new Error("meter unavailable");
    await service.bridge(agent, rpc, h);
    await Promise.all(h.background);
    expect(settleCalls).toEqual([0]);
  });

  test("translates insufficient admission to the bridge credit code", async () => {
    const service = new SharedRuntimeChatService();
    admissionError = new InsufficientCreditsError("no credits");
    expect((await service.bridge(agent, rpc, harness())).error?.code).toBe(-32002);
  });

  test("streams chunks, persists the completed turn, and bills off path", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    const response = await service.stream(agent, rpc, h);
    const body = await response.text();
    expect(body).toContain("event: chunk");
    expect(body).toContain("event: done");
    expect(h.history()).toHaveLength(3);
    await Promise.all(h.background);
    expect(settleCalls).toEqual([0.004]);
  });

  test("stream error and no-parts paths settle zero and emit terminal errors", async () => {
    const service = new SharedRuntimeChatService();
    streamTurn = { degraded: false };
    expect(await (await service.stream(agent, rpc, harness())).text()).toContain("did not start");
    expect(settleCalls).toEqual([0]);

    settleCalls.length = 0;
    streamTurn = {
      degraded: false,
      parts: (async function* () {
        yield await Promise.reject(new Error("provider disconnected"));
      })(),
    };
    expect(await (await service.stream(agent, rpc, harness())).text()).toContain(
      "Shared runtime stream failed",
    );
    expect(settleCalls).toEqual([0]);
  });
});
