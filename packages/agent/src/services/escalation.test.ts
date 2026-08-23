/**
 * Unit coverage for EscalationService and the channel helpers it exports.
 * Drives the real module against an in-memory runtime stand-in. Config I/O is
 * replaced so the suite does not mutate the operator eliza.json; send handlers,
 * cache, and rooms are real Maps/functions whose effects the assertions read.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OwnerContactRoutingHint } from "../config/owner-contacts.ts";
import {
  EscalationService,
  registerEscalationChannel,
  resolveDeliverableChannels,
} from "./escalation.ts";

type MutableConfig = {
  agents?: {
    defaults?: {
      escalation?: {
        channels?: string[];
        waitMinutes?: number;
        maxRetries?: number;
      };
      ownerContacts?: Record<
        string,
        {
          source?: string;
          entityId?: string;
          channelId?: string;
          roomId?: string;
        }
      >;
    };
  };
};

const { configState } = vi.hoisted(() => ({
  configState: {
    current: {} as MutableConfig,
    throwOnLoad: false,
    throwOnSave: false,
  },
}));

vi.mock("../config/config.ts", () => ({
  loadElizaConfig: () => {
    if (configState.throwOnLoad) {
      throw new Error("config load failed");
    }
    return configState.current;
  },
  saveElizaConfig: (cfg: MutableConfig) => {
    if (configState.throwOnSave) {
      throw new Error("config save failed");
    }
    configState.current = cfg;
  },
}));

const AGENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OWNER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ROOM_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CACHE_KEY = `agent:escalation:active:${AGENT_ID}`;

type CacheStore = Map<string, unknown>;

type SendCall = {
  target: { source?: string; entityId?: string; channelId?: string };
  content: { text?: string };
};

function deliveredOutcome() {
  return {
    kind: "delivered" as const,
    receipt: {
      providerMessageIds: ["provider-message-1"] as [string],
      acceptedAt: 1_780_000_000_000,
      persistence: { status: "persisted" as const, memoryIds: [] as string[] },
    },
    memories: [] as unknown[],
  };
}

function hint(
  lastResponseAt: string | null,
  extras?: Partial<OwnerContactRoutingHint>,
): OwnerContactRoutingHint {
  return {
    source: "x",
    entityId: null,
    channelId: null,
    roomId: null,
    preferredCommunicationChannel: null,
    platformIdentities: [],
    lastResponseAt,
    lastResponseChannel: null,
    resolvedFrom: "relationships",
    ...extras,
  };
}

function makeRuntime(options?: {
  agentId?: string;
  cache?: CacheStore;
  handlers?: string[];
  ownerId?: string | null;
  sendImpl?: (
    target: SendCall["target"],
    content: SendCall["content"],
  ) => unknown;
  rooms?: string[];
  memories?: Array<{ entityId: string; createdAt: number | null }>;
  roomsError?: Error;
  cacheGetError?: Error;
  cacheSetError?: Error;
  cacheDeleteError?: Error;
}): {
  runtime: IAgentRuntime;
  cache: CacheStore;
  sends: SendCall[];
} {
  const cache = options?.cache ?? new Map<string, unknown>();
  const sends: SendCall[] = [];
  const agentId = options?.agentId ?? AGENT_ID;
  const ownerId = options?.ownerId === undefined ? OWNER_ID : options.ownerId;
  const sendHandlers = options?.handlers
    ? new Map(options.handlers.map((source) => [source, {}]))
    : undefined;

  const runtime = {
    agentId,
    character: { name: `agent-${agentId}` },
    sendHandlers,
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? (ownerId ?? undefined) : undefined,
    getRoomsForParticipant: async () => {
      if (options?.roomsError) {
        throw options.roomsError;
      }
      return options?.rooms ?? [];
    },
    getRoom: async () => null,
    getWorld: async () => null,
    getService: () => null,
    getEntityById: async () => null,
    getMemoriesByRoomIds: async () => options?.memories ?? [],
    setCache: async (key: string, value: unknown) => {
      if (options?.cacheSetError) {
        throw options.cacheSetError;
      }
      cache.set(key, value);
      return true;
    },
    getCache: async (key: string) => {
      if (options?.cacheGetError) {
        throw options.cacheGetError;
      }
      return cache.get(key) ?? null;
    },
    deleteCache: async (key: string) => {
      if (options?.cacheDeleteError) {
        throw options.cacheDeleteError;
      }
      cache.delete(key);
      return true;
    },
    sendMessageToTarget: async (
      target: SendCall["target"],
      content: SendCall["content"],
    ) => {
      sends.push({ target, content });
      if (options?.sendImpl) {
        return options.sendImpl(target, content);
      }
      return deliveredOutcome();
    },
  };

  return { runtime: runtime as unknown as IAgentRuntime, cache, sends };
}

beforeEach(() => {
  configState.current = {};
  configState.throwOnLoad = false;
  configState.throwOnSave = false;
});

afterEach(() => {
  EscalationService._reset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("resolveDeliverableChannels", () => {
  test("explicit operator order wins untouched, including a single channel", () => {
    expect(
      resolveDeliverableChannels(
        { channels: ["telegram"] },
        { discord: {} },
        { discord: hint("2026-08-16T10:00:00Z") },
      ),
    ).toEqual(["telegram"]);
  });

  test("empty configured list is unconfigured and keeps the client_chat default", () => {
    expect(resolveDeliverableChannels({ channels: [] }, {}, {})).toEqual([
      "client_chat",
    ]);
  });

  test("unconfigured order sorts hinted channels by lastResponseAt, most recent first", () => {
    const channels = resolveDeliverableChannels(
      {},
      {},
      {
        telegram: hint("2026-08-01T00:00:00Z"),
        discord: hint("2026-08-16T10:00:00Z"),
      },
    );
    expect(channels).toEqual(["client_chat", "discord", "telegram"]);
  });

  test("tied lastResponseAt keeps Object.entries insertion order", () => {
    const stamp = "2026-08-16T10:00:00Z";
    const channels = resolveDeliverableChannels(
      {},
      {},
      {
        telegram: hint(stamp),
        discord: hint(stamp),
      },
    );
    expect(channels.slice(1)).toEqual(["telegram", "discord"]);
  });

  test("invalid lastResponseAt sorts behind a parseable timestamp", () => {
    const channels = resolveDeliverableChannels(
      {},
      {},
      {
        stale: hint("not-a-date"),
        recent: hint("2026-08-16T10:00:00Z"),
      },
    );
    expect(channels.slice(1)).toEqual(["recent", "stale"]);
  });

  test("null hints are dropped and owner-contact channels append without duplicates", () => {
    const channels = resolveDeliverableChannels(
      {},
      { discord: {}, imessage: {} },
      {
        discord: hint("2026-08-16T10:00:00Z"),
        gone: null as unknown as OwnerContactRoutingHint,
      },
    );
    expect(channels).toEqual(["client_chat", "discord", "imessage"]);
  });
});

describe("registerEscalationChannel", () => {
  test("rejects empty, non-string, and whitespace-only names without writing config", () => {
    expect(registerEscalationChannel("")).toBe(false);
    expect(registerEscalationChannel("   ")).toBe(false);
    expect(registerEscalationChannel(123 as unknown as string)).toBe(false);
    expect(configState.current.agents).toBeUndefined();
  });

  test("appends a new channel after client_chat and lowercases the name", () => {
    expect(registerEscalationChannel(" Discord ")).toBe(true);
    expect(configState.current.agents?.defaults?.escalation?.channels).toEqual([
      "client_chat",
      "discord",
    ]);
    expect(registerEscalationChannel("discord")).toBe(false);
  });

  test("prepends client_chat when the existing ordered list omitted it", () => {
    configState.current = {
      agents: { defaults: { escalation: { channels: ["telegram"] } } },
    };
    expect(registerEscalationChannel("discord")).toBe(true);
    expect(configState.current.agents?.defaults?.escalation?.channels).toEqual([
      "client_chat",
      "telegram",
      "discord",
    ]);
  });

  test("treats a non-array channels field as the default list", () => {
    configState.current = {
      agents: {
        defaults: {
          escalation: { channels: "telegram" as unknown as string[] },
        },
      },
    };
    expect(registerEscalationChannel("discord")).toBe(true);
    expect(configState.current.agents?.defaults?.escalation?.channels).toEqual([
      "client_chat",
      "discord",
    ]);
  });

  test("returns false when config load or save throws", () => {
    configState.throwOnLoad = true;
    expect(registerEscalationChannel("discord")).toBe(false);
    configState.throwOnLoad = false;
    configState.throwOnSave = true;
    expect(registerEscalationChannel("discord")).toBe(false);
  });
});

describe("EscalationService.startEscalation", () => {
  test("creates an unresolved escalation and persists it under the agent cache key", async () => {
    const { runtime, cache } = makeRuntime();
    const state = await EscalationService.startEscalation(
      runtime,
      "stalled task",
      "please look",
    );

    expect(state.id).toMatch(/^esc-\d+-1$/);
    expect(state.reason).toBe("stalled task");
    expect(state.text).toBe("please look");
    expect(state.resolved).toBe(false);
    expect(state.currentStep).toBe(0);
    expect(state.channelsSent).toEqual([]);
    expect(cache.get(CACHE_KEY)).toEqual(state);
    expect(EscalationService.getActiveEscalationSync(runtime)?.id).toBe(
      state.id,
    );
  });

  test("coalesces a second start on the same agent into the active escalation", async () => {
    const { runtime, cache } = makeRuntime();
    const first = await EscalationService.startEscalation(
      runtime,
      "reason 1",
      "first burst",
    );
    const second = await EscalationService.startEscalation(
      runtime,
      "reason 2",
      "second burst",
    );

    expect(second.id).toBe(first.id);
    expect(second.reason).toBe("reason 1; reason 2");
    expect(second.text).toBe("first burst\n---\nsecond burst");
    expect((cache.get(CACHE_KEY) as { text: string }).text).toBe(
      "first burst\n---\nsecond burst",
    );
  });

  test("falls through a failed first channel and records the first successful send", async () => {
    configState.current = {
      agents: {
        defaults: {
          escalation: { channels: ["telegram", "discord"] },
          ownerContacts: {
            telegram: { entityId: OWNER_ID, channelId: "tg-1" },
            discord: { entityId: OWNER_ID, channelId: "dc-1" },
          },
        },
      },
    };
    const { runtime, sends } = makeRuntime({ handlers: ["discord"] });
    const state = await EscalationService.startEscalation(
      runtime,
      "boot",
      "handler missing on telegram",
    );

    expect(sends).toHaveLength(1);
    expect(sends[0]?.target.source).toBe("discord");
    expect(sends[0]?.content.text).toBe("handler missing on telegram");
    expect(state.channelsSent).toEqual(["discord"]);
    expect(state.currentStep).toBe(1);
  });

  test("uses owner-entity fallback to deliver on client_chat when contacts are empty", async () => {
    const { runtime, sends } = makeRuntime({ handlers: ["client_chat"] });
    const state = await EscalationService.startEscalation(
      runtime,
      "urgent",
      "dashboard ping",
    );

    expect(sends[0]?.target.source).toBe("client_chat");
    expect(sends[0]?.target.entityId).toBe(OWNER_ID);
    expect(state.channelsSent).toEqual(["client_chat"]);
    expect(state.currentStep).toBe(0);
  });

  test("prefers a contact source over the channel key and scopes a compound key to a registered handler", async () => {
    configState.current = {
      agents: {
        defaults: {
          escalation: { channels: ["discord-nubs-test"] },
          ownerContacts: {
            "discord-nubs-test": {
              source: "  ",
              entityId: OWNER_ID,
              channelId: "dc-1",
            },
          },
        },
      },
    };
    const { runtime, sends } = makeRuntime({ handlers: ["discord"] });
    const state = await EscalationService.startEscalation(
      runtime,
      "scoped",
      "nubs",
    );
    expect(sends[0]?.target.source).toBe("discord");
    expect(state.channelsSent).toEqual(["discord-nubs-test"]);
  });

  test("skips a channel whose send throws or is unconfirmed", async () => {
    configState.current = {
      agents: {
        defaults: {
          escalation: { channels: ["discord"] },
          ownerContacts: { discord: { entityId: OWNER_ID } },
        },
      },
    };
    const throwing = makeRuntime({
      handlers: ["discord"],
      sendImpl: () => {
        throw new Error("transport down");
      },
    });
    const thrown = await EscalationService.startEscalation(
      throwing.runtime,
      "send-throw",
      "x",
    );
    expect(thrown.channelsSent).toEqual([]);

    EscalationService._reset();
    const unconfirmed = makeRuntime({
      handlers: ["discord"],
      sendImpl: () => ({
        kind: "not_delivered" as const,
        code: "SKIPPED",
        message: "no evidence",
      }),
    });
    const skipped = await EscalationService.startEscalation(
      unconfirmed.runtime,
      "unconfirmed",
      "y",
    );
    expect(skipped.channelsSent).toEqual([]);
  });

  test("still returns state when cache persist throws", async () => {
    const { runtime } = makeRuntime({
      cacheSetError: new Error("cache full"),
    });
    const state = await EscalationService.startEscalation(
      runtime,
      "persist",
      "ok",
    );
    expect(state.resolved).toBe(false);
    expect(EscalationService.getActiveEscalationSync(runtime)?.id).toBe(
      state.id,
    );
  });

  test("does not schedule a follow-up when there is one channel and maxRetries is 1", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    configState.current = {
      agents: {
        defaults: { escalation: { channels: ["client_chat"], maxRetries: 1 } },
      },
    };
    const { runtime } = makeRuntime();
    await EscalationService.startEscalation(runtime, "once", "no retry");
    expect(vi.getTimerCount()).toBe(0);
    expect(EscalationService._hasPendingTimerBucket(AGENT_ID)).toBe(false);
  });

  test("uses default wait and retry when waitMinutes and maxRetries are not positive numbers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    configState.current = {
      agents: {
        defaults: {
          escalation: {
            channels: ["client_chat"],
            waitMinutes: 0,
            maxRetries: -1,
          },
        },
      },
    };
    const { runtime } = makeRuntime();
    await EscalationService.startEscalation(runtime, "defaults", "x");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(
      EscalationService.getActiveEscalationSync(runtime)?.currentStep,
    ).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      EscalationService.getActiveEscalationSync(runtime)?.currentStep,
    ).toBe(1);
  });
});

describe("EscalationService.checkEscalation", () => {
  test("is a no-op for an unknown id and does not allocate a bucket", async () => {
    const { runtime } = makeRuntime();
    await EscalationService.checkEscalation(runtime, "missing");
    expect(EscalationService._hasActiveEscalationBucket(AGENT_ID)).toBe(false);
  });

  test("resolves when the owner has a message newer than lastSentAt", async () => {
    const { runtime } = makeRuntime({
      rooms: [ROOM_ID],
      memories: [{ entityId: OWNER_ID, createdAt: Date.now() + 60_000 }],
    });
    const state = await EscalationService.startEscalation(
      runtime,
      "need owner",
      "ping",
    );
    await EscalationService.checkEscalation(runtime, state.id);
    expect(EscalationService.getActiveEscalationSync(runtime)).toBeNull();
    expect(EscalationService._hasActiveEscalationBucket(AGENT_ID)).toBe(false);
  });

  test("does not resolve when owner messages are missing, null-dated, or older", async () => {
    const { runtime } = makeRuntime({
      rooms: [ROOM_ID],
      memories: [
        { entityId: OWNER_ID, createdAt: 1 },
        { entityId: OWNER_ID, createdAt: null },
        { entityId: "someone-else", createdAt: Date.now() + 60_000 },
      ],
    });
    const state = await EscalationService.startEscalation(
      runtime,
      "still waiting",
      "ping",
    );
    await EscalationService.checkEscalation(runtime, state.id);
    expect(EscalationService.getActiveEscalationSync(runtime)?.id).toBe(
      state.id,
    );
    expect(state.currentStep).toBe(1);
  });

  test("continues retrying when room lookup throws", async () => {
    const { runtime } = makeRuntime({
      roomsError: new Error("rooms unavailable"),
    });
    const state = await EscalationService.startEscalation(
      runtime,
      "rooms",
      "ping",
    );
    await EscalationService.checkEscalation(runtime, state.id);
    expect(state.resolved).toBe(false);
    expect(state.currentStep).toBe(1);
  });

  test("gives up once currentStep reaches maxRetries and drops the cache row", async () => {
    configState.current = {
      agents: {
        defaults: { escalation: { channels: ["client_chat"], maxRetries: 1 } },
      },
    };
    const { runtime, cache } = makeRuntime();
    const state = await EscalationService.startEscalation(
      runtime,
      "give up",
      "once",
    );
    expect(cache.has(CACHE_KEY)).toBe(true);
    await EscalationService.checkEscalation(runtime, state.id);
    expect(state.resolved).toBe(true);
    expect(state.resolvedAt).toEqual(expect.any(Number));
    expect(cache.has(CACHE_KEY)).toBe(false);
    expect(EscalationService.getActiveEscalationSync(runtime)).toBeNull();

    await EscalationService.checkEscalation(runtime, state.id);
    expect(state.currentStep).toBe(1);

    const next = await EscalationService.startEscalation(
      runtime,
      "fresh",
      "new",
    );
    expect(next.id).not.toBe(state.id);
    expect(next.reason).toBe("fresh");
  });

  test("walks channels by currentStep modulo length on each retry", async () => {
    configState.current = {
      agents: {
        defaults: {
          escalation: {
            channels: ["telegram", "discord"],
            maxRetries: 4,
            waitMinutes: 1,
          },
          ownerContacts: {
            telegram: { entityId: OWNER_ID, channelId: "tg-1" },
            discord: { entityId: OWNER_ID, channelId: "dc-1" },
          },
        },
      },
    };
    const { runtime, sends } = makeRuntime({
      handlers: ["telegram", "discord"],
    });
    const state = await EscalationService.startEscalation(
      runtime,
      "rotate",
      "body",
    );
    expect(state.channelsSent).toEqual(["telegram"]);

    await EscalationService.checkEscalation(runtime, state.id);
    await EscalationService.checkEscalation(runtime, state.id);
    expect(sends.map((call) => call.target.source)).toEqual([
      "telegram",
      "discord",
      "telegram",
    ]);
    expect(state.channelsSent).toEqual(["telegram", "discord", "telegram"]);
    expect(state.currentStep).toBe(2);
  });
});

describe("EscalationService.resolve, cache, and rehydrate", () => {
  test("resolveEscalation is a no-op for a missing id", async () => {
    const { runtime } = makeRuntime();
    await EscalationService.resolveEscalation("nope", runtime);
    expect(EscalationService._hasActiveEscalationBucket(AGENT_ID)).toBe(false);
  });

  test("resolveEscalation without a runtime scans every agent bucket", async () => {
    const { runtime } = makeRuntime();
    const state = await EscalationService.startEscalation(runtime, "scan", "x");
    await EscalationService.resolveEscalation(state.id);
    expect(EscalationService.getActiveEscalationSync(runtime)).toBeNull();
    expect(EscalationService._hasPendingTimerBucket(AGENT_ID)).toBe(false);
  });

  test("resolveEscalation is a no-op when the escalation is already resolved", async () => {
    configState.current = {
      agents: {
        defaults: { escalation: { channels: ["client_chat"], maxRetries: 1 } },
      },
    };
    const { runtime } = makeRuntime();
    const state = await EscalationService.startEscalation(
      runtime,
      "already",
      "x",
    );
    await EscalationService.checkEscalation(runtime, state.id);
    const resolvedAt = state.resolvedAt;
    await EscalationService.resolveEscalation(state.id, runtime);
    expect(state.resolvedAt).toBe(resolvedAt);
  });

  test("getActiveEscalation rehydrates unresolved cache state into memory", async () => {
    const { runtime, cache } = makeRuntime();
    const persisted = {
      id: "esc-cached-1",
      reason: "from cache",
      text: "hello",
      currentStep: 0,
      channelsSent: [] as string[],
      startedAt: 1,
      lastSentAt: 1,
      resolved: false,
    };
    cache.set(CACHE_KEY, persisted);

    const loaded = await EscalationService.getActiveEscalation(runtime);
    expect(loaded?.id).toBe("esc-cached-1");
    expect(EscalationService.getActiveEscalationSync(runtime)?.id).toBe(
      "esc-cached-1",
    );
  });

  test("getActiveEscalation returns null when cache load throws", async () => {
    const { runtime } = makeRuntime({
      cacheGetError: new Error("cache down"),
    });
    expect(await EscalationService.getActiveEscalation(runtime)).toBeNull();
  });

  test("rehydrateFromDb inserts missing cache state once and ignores an empty cache", async () => {
    const { runtime, cache } = makeRuntime();
    await EscalationService.rehydrateFromDb(runtime);
    expect(EscalationService._hasActiveEscalationBucket(AGENT_ID)).toBe(false);

    cache.set(CACHE_KEY, {
      id: "esc-rehydrate-1",
      reason: "rehydrated",
      text: "x",
      currentStep: 0,
      channelsSent: [],
      startedAt: 1,
      lastSentAt: 1,
      resolved: false,
    });
    await EscalationService.rehydrateFromDb(runtime);
    await EscalationService.rehydrateFromDb(runtime);
    expect(EscalationService.getActiveEscalationSync(runtime)?.id).toBe(
      "esc-rehydrate-1",
    );
  });

  test("_resetDb deletes the agent cache row even when deleteCache throws", async () => {
    const ok = makeRuntime();
    ok.cache.set(CACHE_KEY, { id: "x" });
    await EscalationService._resetDb(ok.runtime);
    expect(ok.cache.has(CACHE_KEY)).toBe(false);

    const failing = makeRuntime({
      cacheDeleteError: new Error("cannot delete"),
    });
    await expect(
      EscalationService._resetDb(failing.runtime),
    ).resolves.toBeUndefined();
  });

  test("getActiveEscalationSync skips resolved leftovers still sitting in the map", async () => {
    configState.current = {
      agents: {
        defaults: { escalation: { channels: ["client_chat"], maxRetries: 1 } },
      },
    };
    const { runtime } = makeRuntime();
    const state = await EscalationService.startEscalation(
      runtime,
      "leftover",
      "x",
    );
    await EscalationService.checkEscalation(runtime, state.id);
    expect(state.resolved).toBe(true);
    expect(EscalationService._hasActiveEscalationBucket(AGENT_ID)).toBe(true);
    expect(EscalationService.getActiveEscalationSync(runtime)).toBeNull();
  });
});

describe("EscalationService timers", () => {
  test("scheduled check advances the step and clears the timer bucket when it does not reschedule", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    configState.current = {
      agents: {
        defaults: {
          escalation: {
            channels: ["client_chat"],
            maxRetries: 2,
            waitMinutes: 1,
          },
        },
      },
    };
    const { runtime } = makeRuntime();
    const state = await EscalationService.startEscalation(
      runtime,
      "timer",
      "x",
    );
    expect(EscalationService._hasPendingTimerBucket(AGENT_ID)).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(state.currentStep).toBe(1);
    expect(state.resolved).toBe(false);
    expect(EscalationService._hasPendingTimerBucket(AGENT_ID)).toBe(false);
  });

  test("config load failure during start still uses the client_chat default", async () => {
    configState.throwOnLoad = true;
    const { runtime } = makeRuntime();
    const state = await EscalationService.startEscalation(
      runtime,
      "no config",
      "x",
    );
    expect(state.resolved).toBe(false);
    expect(state.channelsSent).toEqual([]);
  });
});
