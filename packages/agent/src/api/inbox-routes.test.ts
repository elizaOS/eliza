/**
 * Route-contract tests for the inbox HTTP boundary in inbox-routes.ts.
 * Deterministic: an in-memory world/room/memory store stands in for the
 * runtime, the real @elizaos/core mute-state and connector-account-manager
 * helpers drive persistence and account policy, and only the optional
 * plugin-discord dynamic import is isolated. No network and no live model.
 */
import type http from "node:http";
import type {
  AgentRuntime,
  ConnectorAccount,
  Memory,
  RoleGateRole,
  Room,
  RouteHelpers,
  UUID,
  World,
} from "@elizaos/core";
import {
  getConnectorAccountManager,
  InMemoryConnectorAccountStorage,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleInboxRoute,
  MAX_DISCORD_PROFILE_CACHE_ENTRIES,
} from "./inbox-routes.js";

vi.mock("@elizaos/plugin-discord", () => ({
  cacheDiscordAvatarUrl: async (avatarUrl: string | undefined) => avatarUrl,
}));

const uuid = (value: string) => value as UUID;

const AGENT_ID = uuid("00000000-0000-4000-8000-00000000a001");

type MemorySeed = {
  id?: string;
  entityId?: string;
  roomId?: string;
  createdAt?: number;
  source?: string;
  text?: string;
  inReplyTo?: string;
  responseId?: string;
  url?: string;
  metadata?: Record<string, unknown>;
};

function makeMemory(seed: MemorySeed): Memory {
  const content: Record<string, unknown> = {};
  if (seed.source !== undefined) content.source = seed.source;
  if (seed.text !== undefined) content.text = seed.text;
  if (seed.inReplyTo !== undefined) content.inReplyTo = seed.inReplyTo;
  if (seed.responseId !== undefined) content.responseId = seed.responseId;
  if (seed.url !== undefined) content.url = seed.url;
  return {
    ...(seed.id === undefined ? {} : { id: seed.id }),
    ...(seed.entityId === undefined ? {} : { entityId: seed.entityId }),
    ...(seed.roomId === undefined ? {} : { roomId: uuid(seed.roomId) }),
    ...(seed.createdAt === undefined ? {} : { createdAt: seed.createdAt }),
    content,
    ...(seed.metadata === undefined ? {} : { metadata: seed.metadata }),
  } as unknown as Memory;
}

function makeRoom(seed: {
  id: string;
  name?: string;
  source?: string;
  worldId?: string;
  channelId?: string;
  serverId?: string;
  createdAt?: number;
  metadata?: Record<string, unknown>;
}): Room {
  return {
    id: uuid(seed.id),
    ...(seed.name === undefined ? {} : { name: seed.name }),
    ...(seed.source === undefined ? {} : { source: seed.source }),
    ...(seed.worldId === undefined ? {} : { worldId: uuid(seed.worldId) }),
    ...(seed.channelId === undefined ? {} : { channelId: seed.channelId }),
    ...(seed.serverId === undefined ? {} : { serverId: seed.serverId }),
    ...(seed.createdAt === undefined ? {} : { createdAt: seed.createdAt }),
    ...(seed.metadata === undefined ? {} : { metadata: seed.metadata }),
  } as Room;
}

function makeWorld(id: string, name?: string): World {
  return {
    id: uuid(id),
    ...(name === undefined ? {} : { name }),
    metadata: {},
  } as World;
}

class InboxHarness {
  agentId = AGENT_ID;
  worlds = new Map<string, World>();
  rooms = new Map<string, Room>();
  memories: Memory[] = [];
  participantStates = new Map<string, "FOLLOWED" | "MUTED" | null>();
  sendHandlers = new Map<string, unknown>();
  sent: Array<{
    target: Record<string, unknown>;
    content: Record<string, unknown>;
  }> = [];
  bulkQueries: Array<{
    tableName: string;
    roomIds?: string[];
    limit?: number;
  }> = [];
  roomQueries: Array<{ tableName: string; roomId?: string; limit?: number }> =
    [];
  logs: Array<{ level: string; args: unknown[] }> = [];
  sendError: Error | null = null;
  failBulkReads = false;
  serviceOverrides = new Map<string, unknown>();

  getService(name: string): unknown {
    return this.serviceOverrides.get(name) ?? null;
  }

  logger = {
    info: (...args: unknown[]) => {
      this.logs.push({ level: "info", args });
    },
    warn: (...args: unknown[]) => {
      this.logs.push({ level: "warn", args });
    },
    error: (...args: unknown[]) => {
      this.logs.push({ level: "error", args });
    },
  };

  addWorld(world: World) {
    this.worlds.set(String(world.id), world);
  }

  addRoom(room: Room) {
    this.rooms.set(String(room.id), room);
  }

  addMemory(memory: Memory) {
    this.memories.push(memory);
  }

  private newestFirst(list: Memory[]): Memory[] {
    return [...list].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  async getAllWorlds(): Promise<World[]> {
    return [...this.worlds.values()];
  }

  async getRoomsByWorlds(
    worldIds: UUID[],
    limit: number,
    offset: number,
  ): Promise<Room[]> {
    const wanted = new Set(worldIds.map(String));
    return [...this.rooms.values()]
      .filter((room) => wanted.has(String(room.worldId)))
      .slice(offset, offset + limit);
  }

  async getRoom(roomId: UUID): Promise<Room | null> {
    return this.rooms.get(String(roomId)) ?? null;
  }

  async updateRoom(room: Room): Promise<boolean> {
    this.rooms.set(String(room.id), room);
    return true;
  }

  async getWorld(worldId: UUID): Promise<World | null> {
    return this.worlds.get(String(worldId)) ?? null;
  }

  async updateWorld(world: World): Promise<boolean> {
    this.worlds.set(String(world.id), world);
    return true;
  }

  async getParticipantUserState(
    roomId: UUID,
    entityId: UUID,
  ): Promise<"FOLLOWED" | "MUTED" | null> {
    return (
      this.participantStates.get(`${String(roomId)}:${String(entityId)}`) ??
      null
    );
  }

  async updateParticipantUserState(
    roomId: UUID,
    entityId: UUID,
    state: "FOLLOWED" | "MUTED" | null,
  ): Promise<void> {
    const key = `${String(roomId)}:${String(entityId)}`;
    if (state === null) this.participantStates.delete(key);
    else this.participantStates.set(key, state);
  }

  async getMemories(params: {
    tableName: string;
    roomId?: UUID;
    limit?: number;
  }): Promise<Memory[]> {
    this.roomQueries.push({
      tableName: params.tableName,
      roomId: params.roomId === undefined ? undefined : String(params.roomId),
      limit: params.limit,
    });
    const scoped = params.roomId
      ? this.memories.filter(
          (memory) => String(memory.roomId) === String(params.roomId),
        )
      : this.memories;
    return this.newestFirst(scoped).slice(0, params.limit ?? scoped.length);
  }

  async getMemoriesByRoomIds(params: {
    tableName: string;
    roomIds: UUID[];
    limit?: number;
  }): Promise<Memory[]> {
    this.bulkQueries.push({
      tableName: params.tableName,
      roomIds: params.roomIds.map(String),
      limit: params.limit,
    });
    if (this.failBulkReads) throw new Error("db down");
    const wanted = new Set(params.roomIds.map(String));
    const scoped = this.memories.filter((memory) =>
      wanted.has(String(memory.roomId)),
    );
    return this.newestFirst(scoped).slice(0, params.limit ?? scoped.length);
  }

  async sendMessageToTarget(
    target: Record<string, unknown>,
    content: Record<string, unknown>,
  ): Promise<Memory> {
    this.sent.push({ target, content });
    if (this.sendError) throw this.sendError;
    const memory = makeMemory({
      id: `sent-${this.sent.length}`,
      entityId: AGENT_ID,
      roomId: String(target.roomId ?? ""),
      createdAt: 99_000,
      source: typeof content.source === "string" ? content.source : undefined,
      text: typeof content.text === "string" ? content.text : "",
    });
    this.addMemory(memory);
    return memory;
  }
}

type HarnessResponse = {
  jsonBodies: Array<{ body: unknown; status: number }>;
  errors: Array<{ message: string; status: number }>;
  readCalls: Array<{ maxBytes?: number }>;
};

function makeHelpers(payload: Record<string, unknown> | null): {
  helpers: RouteHelpers;
  response: HarnessResponse;
} {
  const response: HarnessResponse = {
    jsonBodies: [],
    errors: [],
    readCalls: [],
  };
  const helpers: RouteHelpers = {
    json: (_res, data, status) => {
      response.jsonBodies.push({ body: data, status: status ?? 200 });
    },
    error: (_res, message, status) => {
      response.errors.push({ message, status: status ?? 500 });
    },
    readJsonBody: async <T extends object>(
      _req: http.IncomingMessage,
      _res: http.ServerResponse,
      options?: { maxBytes?: number },
    ) => {
      response.readCalls.push(options ?? {});
      return payload as T | null;
    },
  };
  return { helpers, response };
}

const NO_RES = {} as http.ServerResponse;

async function runRoute(options: {
  harness: InboxHarness | null;
  pathname: string;
  method?: string;
  url?: string;
  callerAuthorization?: {
    ok: boolean;
    role: RoleGateRole;
    identityId?: string;
  };
  body?: Record<string, unknown> | null;
}) {
  const harness = options.harness;
  const { helpers, response } = makeHelpers(options.body ?? null);
  const matched = await handleInboxRoute(
    { url: options.url ?? options.pathname } as http.IncomingMessage,
    NO_RES,
    options.pathname,
    options.method ?? "GET",
    {
      runtime: harness ? (harness as unknown as AgentRuntime) : null,
      callerAuthorization: options.callerAuthorization,
    },
    helpers,
  );
  return { matched, response, harness };
}

function callerOk(role: RoleGateRole = "USER") {
  return { ok: true, role };
}

function account(seed: {
  id: string;
  provider: string;
  status?: ConnectorAccount["status"];
  accessGate?: ConnectorAccount["accessGate"];
  role?: ConnectorAccount["role"];
  isDefault?: boolean;
}): ConnectorAccount {
  return {
    id: seed.id,
    provider: seed.provider,
    role: seed.role ?? "AGENT",
    purpose: ["messaging"],
    accessGate: seed.accessGate ?? "open",
    status: seed.status ?? "connected",
    createdAt: 100,
    updatedAt: 100,
    ...(seed.isDefault === undefined
      ? {}
      : { metadata: { isDefault: seed.isDefault } }),
  } as ConnectorAccount;
}

async function seedAccounts(
  harness: InboxHarness,
  accounts: ConnectorAccount[],
) {
  const storage = new InMemoryConnectorAccountStorage();
  for (const entry of accounts) await storage.upsertAccount(entry);
  getConnectorAccountManager(harness as unknown as AgentRuntime, storage);
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("handleInboxRoute dispatch", () => {
  it("returns false without responding for paths outside /api/inbox", async () => {
    const { matched, response } = await runRoute({
      harness: new InboxHarness(),
      pathname: "/api/messages",
    });
    expect(matched).toBe(false);
    expect(response.jsonBodies).toHaveLength(0);
    expect(response.errors).toHaveLength(0);
  });

  it("returns false without responding for unmatched inbox subpaths and methods", async () => {
    for (const attempt of [
      { pathname: "/api/inbox/nope", method: "GET" },
      { pathname: "/api/inbox/messages", method: "DELETE" },
      { pathname: "/api/inbox/sources", method: "POST" },
    ]) {
      const { matched, response } = await runRoute({
        harness: new InboxHarness(),
        pathname: attempt.pathname,
        method: attempt.method,
      });
      expect(matched).toBe(false);
      expect(response.jsonBodies).toHaveLength(0);
      expect(response.errors).toHaveLength(0);
    }
  });
});

describe("GET /api/inbox/messages", () => {
  function seededHarness() {
    const harness = new InboxHarness();
    harness.addWorld(makeWorld("world-1", "Guild"));
    harness.addRoom(
      makeRoom({ id: "room-1", source: "telegram", worldId: "world-1" }),
    );
    harness.addRoom(
      makeRoom({ id: "room-2", source: "imessage", worldId: "world-1" }),
    );
    return harness;
  }

  it("answers with an empty feed before boot without touching storage", async () => {
    const { matched, response } = await runRoute({
      harness: null,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages",
    });
    expect(matched).toBe(true);
    expect(response.jsonBodies).toEqual([
      { body: { messages: [], count: 0 }, status: 200 },
    ]);
  });

  it("rejects a malformed limit with 400", async () => {
    for (const bad of ["0", "-5", "12.5", "abc", "1e3", " 5 ", "050"]) {
      const { matched, response } = await runRoute({
        harness: seededHarness(),
        pathname: "/api/inbox/messages",
        url: `/api/inbox/messages?limit=${encodeURIComponent(bad)}`,
      });
      expect(matched).toBe(true);
      expect(response.errors).toEqual([
        {
          message: "limit must be a positive integer",
          status: 400,
        },
      ]);
    }
  });

  it("defaults the limit to 100 and over-fetches rooms by 3x", async () => {
    const harness = seededHarness();
    await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages",
    });
    expect(harness.bulkQueries[0]?.limit).toBe(300);
  });

  it("caps a huge limit at 500 while accepting the canonical cap", async () => {
    const capped = seededHarness();
    await runRoute({
      harness: capped,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages?limit=9999",
    });
    const exact = seededHarness();
    await runRoute({
      harness: exact,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages?limit=500",
    });
    expect(capped.bulkQueries[0]?.limit).toBe(1500);
    expect(exact.bulkQueries[0]?.limit).toBe(1500);
  });

  it("scans no storage when every world is internal scratch space", async () => {
    const harness = new InboxHarness();
    harness.addWorld(
      makeWorld("00000000-0000-0000-0000-000000000001", "Guild"),
    );
    harness.addWorld(makeWorld("world-named", "Autonomy World"));
    harness.addRoom(
      makeRoom({
        id: "room-1",
        source: "telegram",
        worldId: "00000000-0000-0000-0000-000000000001",
      }),
    );
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages",
    });
    expect(matched).toBe(true);
    expect(harness.bulkQueries).toHaveLength(0);
    expect(response.jsonBodies[0]).toEqual({
      body: { messages: [], count: 0 },
      status: 200,
    });
  });

  it("keeps connector sources in the default filter and drops client/system/untagged-source rows", async () => {
    const harness = seededHarness();
    harness.addMemory(
      makeMemory({
        id: "m-tg",
        entityId: "user-1",
        roomId: "room-1",
        createdAt: 3000,
        source: "telegram",
        text: "hello from telegram",
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-im",
        entityId: "user-2",
        roomId: "room-2",
        createdAt: 2000,
        source: "imessage",
        text: "hello from imessage",
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-chat",
        entityId: "user-3",
        roomId: "room-1",
        createdAt: 2500,
        source: "client_chat",
        text: "dashboard turn",
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-sys",
        entityId: "user-4",
        roomId: "room-1",
        createdAt: 2400,
        source: "system",
        text: "internal event",
      }),
    );
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages",
    });
    expect(matched).toBe(true);
    const body = response.jsonBodies[0]?.body as {
      messages: Array<{ id: string; source: string }>;
      count: number;
    };
    expect(body.count).toBe(2);
    expect(body.messages.map((message) => message.id)).toEqual([
      "m-tg",
      "m-im",
    ]);
  });

  it("attributes an untagged row to its room's trusted source when the room is in the filter", async () => {
    const harness = seededHarness();
    harness.addMemory(
      makeMemory({
        id: "m-none",
        entityId: "user-5",
        roomId: "room-1",
        createdAt: 2300,
        text: "no explicit source",
      }),
    );
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages",
    });
    expect(matched).toBe(true);
    const body = response.jsonBodies[0]?.body as {
      messages: Array<{ id: string; source: string }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({
      id: "m-none",
      source: "telegram",
    });
  });

  it("normalizes the sources query parameter and falls back to defaults when it is empty", async () => {
    const filtered = seededHarness();
    filtered.addMemory(
      makeMemory({
        id: "m-tg",
        entityId: "user-1",
        roomId: "room-1",
        createdAt: 3000,
        source: "TELEGRAM",
        text: "tg",
      }),
    );
    filtered.addMemory(
      makeMemory({
        id: "m-im",
        entityId: "user-2",
        roomId: "room-2",
        createdAt: 2000,
        source: "imessage",
        text: "im",
      }),
    );
    const { response } = await runRoute({
      harness: filtered,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages?sources=%20TELEGRAM%20,",
    });
    const body = response.jsonBodies[0]?.body as {
      messages: Array<{ id: string }>;
    };
    expect(body.messages.map((message) => message.id)).toEqual(["m-tg"]);

    const defaulted = seededHarness();
    defaulted.addMemory(
      makeMemory({
        id: "m-im",
        entityId: "user-2",
        roomId: "room-2",
        createdAt: 2000,
        source: "imessage",
        text: "im",
      }),
    );
    const defaultedRun = await runRoute({
      harness: defaulted,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages?sources=,,",
    });
    const defaultedBody = defaultedRun.response.jsonBodies[0]?.body as {
      messages: Array<{ id: string }>;
    };
    expect(defaultedBody.messages.map((message) => message.id)).toEqual([
      "m-im",
    ]);
  });

  it("scopes reads to one room without enumerating worlds when roomId is set", async () => {
    const harness = seededHarness();
    harness.addMemory(
      makeMemory({
        id: "m-1",
        entityId: "user-1",
        roomId: "room-1",
        createdAt: 3000,
        source: "telegram",
        text: "in room",
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-2",
        entityId: "user-2",
        roomId: "room-2",
        createdAt: 2500,
        source: "imessage",
        text: "elsewhere",
      }),
    );
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages?roomId=room-1&limit=10",
    });
    expect(matched).toBe(true);
    expect(harness.bulkQueries).toHaveLength(0);
    expect(harness.roomQueries[0]).toEqual({
      tableName: "messages",
      roomId: "room-1",
      limit: 30,
    });
    const body = response.jsonBodies[0]?.body as {
      messages: Array<{ id: string }>;
    };
    expect(body.messages.map((message) => message.id)).toEqual(["m-1"]);
  });

  it("falls back to the roomSource query hint when neither the room nor memories carry a source", async () => {
    const harness = new InboxHarness();
    harness.addWorld(makeWorld("world-1", "Guild"));
    harness.addRoom(makeRoom({ id: "room-bare" }));
    harness.addMemory(
      makeMemory({
        id: "m-1",
        entityId: "user-1",
        roomId: "room-bare",
        createdAt: 3000,
        text: "unattributed",
      }),
    );
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages?roomId=room-bare&roomSource=telegram&limit=5",
    });
    expect(matched).toBe(true);
    const body = response.jsonBodies[0]?.body as {
      messages: Array<{ id: string; source: string }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({
      id: "m-1",
      source: "telegram",
    });
  });

  it("maps agent rows to assistant, keeps sender fields, and tolerates missing ids and timestamps", async () => {
    const harness = seededHarness();
    harness.addMemory(
      makeMemory({
        entityId: AGENT_ID,
        roomId: "room-1",
        source: "telegram",
        text: "agent turn",
        metadata: {
          entityName: "Eliza",
          entityUserName: "eliza_bot",
          entityAvatarUrl: "https://cdn.example/a.png",
        },
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-user",
        entityId: "user-1",
        roomId: "room-1",
        source: "telegram",
        text: "human turn",
      }),
    );
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages",
    });
    expect(matched).toBe(true);
    const body = response.jsonBodies[0]?.body as {
      messages: Array<Record<string, unknown>>;
    };
    expect(body.messages[0]).toMatchObject({
      id: "",
      role: "assistant",
      timestamp: 0,
      from: "Eliza",
      fromUserName: "eliza_bot",
      avatarUrl: "https://cdn.example/a.png",
    });
    expect(body.messages[1]).toMatchObject({
      id: "m-user",
      role: "user",
    });
  });

  it("orders newest first, breaks ties by id ascending, and slices to the limit", async () => {
    const harness = seededHarness();
    harness.addMemory(
      makeMemory({
        id: "m-b",
        entityId: "user-1",
        roomId: "room-1",
        createdAt: 1000,
        source: "telegram",
        text: "oldest",
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-z",
        entityId: "user-1",
        roomId: "room-1",
        createdAt: 2000,
        source: "telegram",
        text: "tie z",
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-a",
        entityId: "user-1",
        roomId: "room-1",
        createdAt: 2000,
        source: "telegram",
        text: "tie a",
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-new",
        entityId: "user-1",
        roomId: "room-1",
        createdAt: 5000,
        source: "telegram",
        text: "newest",
      }),
    );
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages?limit=3",
    });
    expect(matched).toBe(true);
    const body = response.jsonBodies[0]?.body as {
      messages: Array<{ text: string }>;
    };
    expect(body.messages.map((message) => message.text)).toEqual([
      "newest",
      "tie a",
      "tie z",
    ]);
  });

  it("aggregates structured reaction events onto their target and drops the event rows", async () => {
    const harness = seededHarness();
    harness.addMemory(
      makeMemory({
        id: "m-target",
        entityId: "user-1",
        roomId: "room-1",
        createdAt: 1000,
        source: "telegram",
        text: "target",
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-react-add-alice",
        entityId: "entity-alice",
        roomId: "room-1",
        createdAt: 1100,
        source: "telegram",
        inReplyTo: "m-target",
        metadata: {
          discordReaction: { action: "add", emoji: "👍" },
          entityName: "Alice",
        },
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-react-add-bob",
        entityId: "entity-bob",
        roomId: "room-1",
        createdAt: 1200,
        source: "telegram",
        inReplyTo: "m-target",
        metadata: {
          discordReaction: { action: "add", emoji: "👍" },
          entityName: "Bob",
        },
      }),
    );
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages",
    });
    expect(matched).toBe(true);
    const body = response.jsonBodies[0]?.body as {
      messages: Array<{
        id: string;
        reactions?: Array<{ emoji: string; count: number; users?: string[] }>;
      }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.reactions).toEqual([
      { emoji: "👍", count: 2, users: ["Alice", "Bob"] },
    ]);
  });

  it("removes an aggregated reaction once its user retracts it", async () => {
    const harness = seededHarness();
    harness.addMemory(
      makeMemory({
        id: "m-target",
        entityId: "user-1",
        roomId: "room-1",
        createdAt: 1000,
        source: "telegram",
        text: "target",
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-react-add",
        entityId: "entity-alice",
        roomId: "room-1",
        createdAt: 1100,
        source: "telegram",
        inReplyTo: "m-target",
        metadata: {
          discordReaction: { action: "add", emoji: "🔥" },
          entityName: "Alice",
        },
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-react-remove",
        entityId: "entity-alice",
        roomId: "room-1",
        createdAt: 1200,
        source: "telegram",
        inReplyTo: "m-target",
        metadata: {
          discordReaction: { action: "remove", emoji: "🔥" },
          entityName: "Alice",
        },
      }),
    );
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages",
    });
    const body = response.jsonBodies[0]?.body as {
      messages: Array<Record<string, unknown>>;
    };
    expect(matched).toBe(true);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.reactions).toBeUndefined();
  });

  it("parses legacy Discord reaction prose into the same aggregate", async () => {
    const harness = seededHarness();
    harness.addMemory(
      makeMemory({
        id: "m-target",
        entityId: "user-1",
        roomId: "room-1",
        createdAt: 1000,
        source: "discord",
        text: "target",
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-legacy",
        entityId: "entity-alice",
        roomId: "room-1",
        createdAt: 1100,
        source: "discord",
        text: "*Added <👀> to:",
        inReplyTo: "m-target",
        metadata: { entityName: "Alice" },
      }),
    );
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages",
    });
    expect(matched).toBe(true);
    const body = response.jsonBodies[0]?.body as {
      messages: Array<{
        reactions?: Array<{ emoji: string; count: number }>;
      }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.reactions).toEqual([
      { emoji: "👀", count: 1, users: ["Alice"] },
    ]);
  });

  it("collapses duplicate assistant sends sharing a responseId and keeps the newest copy", async () => {
    const harness = seededHarness();
    harness.addMemory(
      makeMemory({
        id: "m-old",
        entityId: AGENT_ID,
        roomId: "room-1",
        createdAt: 1000,
        source: "telegram",
        text: "same words",
        responseId: "resp-1",
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-new",
        entityId: AGENT_ID,
        roomId: "room-1",
        createdAt: 2000,
        source: "telegram",
        text: "same words",
        responseId: "resp-1",
      }),
    );
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages",
    });
    expect(matched).toBe(true);
    const body = response.jsonBodies[0]?.body as {
      messages: Array<{ id: string }>;
    };
    expect(body.messages.map((message) => message.id)).toEqual(["m-new"]);
  });

  it("merges an implicit shadow of an explicit assistant send within 15s preferring the richer record", async () => {
    const harness = new InboxHarness();
    harness.addWorld(makeWorld("world-1", "Guild"));
    harness.addRoom(
      makeRoom({ id: "room-d", source: "discord", worldId: "world-1" }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-explicit",
        entityId: AGENT_ID,
        roomId: "room-d",
        createdAt: 2000,
        source: "discord",
        text: "the reply",
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-shadow",
        entityId: AGENT_ID,
        roomId: "room-d",
        createdAt: 1500,
        text: "the reply",
      }),
    );
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages",
    });
    expect(matched).toBe(true);
    const body = response.jsonBodies[0]?.body as {
      messages: Array<{ id: string }>;
    };
    expect(body.messages.map((message) => message.id)).toEqual(["m-explicit"]);
  });

  it("keeps near-identical assistant sends that are more than 15 seconds apart", async () => {
    const harness = new InboxHarness();
    harness.addWorld(makeWorld("world-1", "Guild"));
    harness.addRoom(
      makeRoom({ id: "room-d", source: "discord", worldId: "world-1" }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-first",
        entityId: AGENT_ID,
        roomId: "room-d",
        createdAt: 1000,
        source: "discord",
        text: "again",
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-second",
        entityId: AGENT_ID,
        roomId: "room-d",
        createdAt: 17_000,
        text: "again",
      }),
    );
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages",
    });
    expect(matched).toBe(true);
    const body = response.jsonBodies[0]?.body as {
      messages: Array<{ id: string }>;
    };
    expect(body.messages.map((message) => message.id)).toEqual([
      "m-second",
      "m-first",
    ]);
  });

  it("suppresses an unsent Discord shadow only while a visible reply covers its target", async () => {
    const harness = new InboxHarness();
    harness.addWorld(makeWorld("world-1", "Guild"));
    harness.addRoom(
      makeRoom({ id: "room-d", source: "discord", worldId: "world-1" }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-covered-shadow",
        entityId: AGENT_ID,
        roomId: "room-d",
        createdAt: 1000,
        text: "draft",
        metadata: { replyToMessageId: "ext-1" },
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-visible",
        entityId: AGENT_ID,
        roomId: "room-d",
        createdAt: 1500,
        source: "discord",
        text: "sent",
        metadata: { replyToMessageId: "ext-1" },
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-lone-shadow",
        entityId: AGENT_ID,
        roomId: "room-d",
        createdAt: 900,
        text: "never sent",
        metadata: { replyToMessageId: "ext-2" },
      }),
    );
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages",
    });
    expect(matched).toBe(true);
    const body = response.jsonBodies[0]?.body as {
      messages: Array<{ id: string }>;
    };
    expect(body.messages.map((message) => message.id)).toEqual([
      "m-visible",
      "m-lone-shadow",
    ]);
  });
  it("translates storage failures into a 500 failed-to-load response", async () => {
    const harness = seededHarness();
    harness.failBulkReads = true;
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      url: "/api/inbox/messages",
    });
    expect(matched).toBe(true);
    expect(response.errors).toEqual([
      { message: "failed to load inbox: db down", status: 500 },
    ]);
  });
});

describe("POST /api/inbox/messages", () => {
  function sendHarness() {
    const harness = new InboxHarness();
    harness.addWorld(makeWorld("world-1", "Guild"));
    harness.addRoom(
      makeRoom({
        id: "room-1",
        name: "General",
        source: "telegram",
        channelId: "chan-1",
        serverId: "srv-1",
      }),
    );
    return harness;
  }

  const validBody = { roomId: "room-1", source: "telegram", text: "hi" };

  it("refuses with 503 while the runtime is absent", async () => {
    const { matched, response } = await runRoute({
      harness: null,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: validBody,
    });
    expect(matched).toBe(true);
    expect(response.errors).toEqual([
      { message: "runtime not ready", status: 503 },
    ]);
  });

  it("rejects unauthenticated or below-USER callers before reading the body", async () => {
    for (const callerAuthorization of [
      undefined,
      { ok: false, role: "NONE" as RoleGateRole },
      { ok: true, role: "NONE" as RoleGateRole },
      { ok: true, role: "GUEST" as RoleGateRole },
    ]) {
      const harness = sendHarness();
      const { matched, response } = await runRoute({
        harness,
        pathname: "/api/inbox/messages",
        method: "POST",
        callerAuthorization,
        body: validBody,
      });
      expect(matched).toBe(true);
      expect(response.jsonBodies).toEqual([
        {
          body: {
            error:
              "Authenticated caller is not allowed to send connector messages",
            code: "INBOX_CALLER_UNAUTHORIZED",
          },
          status: 403,
        },
      ]);
      expect(response.readCalls).toHaveLength(0);
      expect(harness.sent).toHaveLength(0);
      expect(harness.logs.some((log) => log.level === "warn")).toBe(true);
    }
  });

  it("stops silently when the body reader already answered and passes the 256 KiB ceiling", async () => {
    const harness = sendHarness();
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: null,
    });
    expect(matched).toBe(true);
    expect(response.jsonBodies).toHaveLength(0);
    expect(response.errors).toHaveLength(0);
    expect(response.readCalls).toEqual([{ maxBytes: 256 * 1024 }]);
    expect(harness.roomQueries).toHaveLength(0);
  });

  it("rejects schema-invalid bodies with the first issue path", async () => {
    const blank = sendHarness();
    const blankRun = await runRoute({
      harness: blank,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: { roomId: "room-1", source: "telegram", text: "   " },
    });
    expect(blankRun.matched).toBe(true);
    expect(blankRun.response.errors[0]?.status).toBe(400);
    expect(blankRun.response.errors[0]?.message).toContain(
      "Invalid request body at text",
    );

    const extra = sendHarness();
    const extraRun = await runRoute({
      harness: extra,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: { ...validBody, surprise: true },
    });
    expect(extraRun.response.errors[0]?.status).toBe(400);
    expect(extraRun.response.errors[0]?.message).toContain(
      "Invalid request body at",
    );
    expect(extra.roomQueries).toHaveLength(0);
  });

  it("answers 404 when the room does not exist", async () => {
    const harness = sendHarness();
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: { roomId: "room-missing", source: "telegram", text: "hi" },
    });
    expect(matched).toBe(true);
    expect(response.errors).toEqual([
      { message: "inbox room not found", status: 404 },
    ]);
  });

  it("rejects a send whose transport differs from the trusted room source", async () => {
    const harness = sendHarness();
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: { roomId: "room-1", source: "discord", text: "hi" },
    });
    expect(matched).toBe(true);
    expect(response.jsonBodies[0]?.status).toBe(409);
    expect(response.jsonBodies[0]?.body).toMatchObject({
      code: "INBOX_ROOM_SOURCE_MISMATCH",
      error: "Inbox room belongs to telegram, not discord",
    });
    expect(harness.sent).toHaveLength(0);
  });

  it("rejects a send when the room carries no trusted connector source at all", async () => {
    const harness = new InboxHarness();
    harness.addWorld(makeWorld("world-1", "Guild"));
    harness.addRoom(makeRoom({ id: "room-bare" }));
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: { roomId: "room-bare", source: "telegram", text: "hi" },
    });
    expect(matched).toBe(true);
    expect(response.jsonBodies[0]?.body).toMatchObject({
      code: "INBOX_ROOM_SOURCE_MISMATCH",
      error: "Inbox room has no trusted connector source",
    });
  });

  it("dispatches through the unscoped handler after legacy default routing and reloads the sent message", async () => {
    const harness = sendHarness();
    harness.sendHandlers.set("telegram", async () => {});
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: {
        roomId: "room-1",
        source: " TELEGRAM ",
        text: "  hello there  ",
        replyToMessageId: "m-target",
      },
    });
    expect(matched).toBe(true);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.target).toMatchObject({
      source: "telegram",
      roomId: "room-1",
      channelId: "chan-1",
      serverId: "srv-1",
    });
    expect(harness.sent[0]?.content).toMatchObject({
      source: "telegram",
      text: "hello there",
      inReplyTo: "m-target",
      agentVoiced: true,
    });
    expect(response.jsonBodies[0]?.body).toMatchObject({
      ok: true,
      message: { role: "assistant", text: "hello there" },
    });
  });

  it("answers ok:true alone when the reload cannot observe the delivery", async () => {
    const harness = sendHarness();
    harness.sendHandlers.set("telegram", async () => {});
    const externalOnly = makeMemory({
      id: "external-only",
      entityId: AGENT_ID,
      roomId: "room-1",
      createdAt: 99_000,
      source: "telegram",
      text: "delivered elsewhere",
    });
    harness.sendMessageToTarget = async () => {
      harness.sent.push({ target: {}, content: {} });
      return externalOnly;
    };
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: validBody,
    });
    expect(matched).toBe(true);
    expect(response.jsonBodies[0]).toEqual({ body: { ok: true }, status: 200 });
  });

  it("requires an account when only account-scoped handlers are registered", async () => {
    const harness = sendHarness();
    harness.sendHandlers.set("telegram\u0000acc-9", async () => {});
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: validBody,
    });
    expect(matched).toBe(true);
    expect(response.jsonBodies[0]?.body).toMatchObject({
      code: "INBOX_CONNECTOR_ACCOUNT_REQUIRED",
    });
    expect(response.jsonBodies[0]?.status).toBe(409);
  });

  it("reports 409 when no send handler exists for the resolved route", async () => {
    const harness = sendHarness();
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: validBody,
    });
    expect(matched).toBe(true);
    expect(response.errors).toEqual([
      {
        message: "no send handler registered for inbox source: telegram",
        status: 409,
      },
    ]);
  });

  it("sends through an explicitly requested usable account", async () => {
    const harness = sendHarness();
    await seedAccounts(harness, [
      account({ id: "acc-1", provider: "telegram" }),
    ]);
    harness.sendHandlers.set("telegram\u0000acc-1", async () => {});
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: { ...validBody, accountId: "acc-1" },
    });
    expect(matched).toBe(true);
    expect(harness.sent[0]?.target).toHaveProperty("accountId", "acc-1");
    expect(response.jsonBodies[0]?.body).toMatchObject({ ok: true });
  });

  it("distinguishes not-found from wrong-provider explicit accounts", async () => {
    const missing = sendHarness();
    const missingRun = await runRoute({
      harness: missing,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: { ...validBody, accountId: "acc-nope" },
    });
    expect(missingRun.response.jsonBodies[0]?.body).toMatchObject({
      code: "INBOX_CONNECTOR_ACCOUNT_NOT_FOUND",
    });
    expect(missingRun.response.jsonBodies[0]?.status).toBe(404);

    const otherProvider = sendHarness();
    await seedAccounts(otherProvider, [
      account({ id: "acc-d", provider: "discord" }),
    ]);
    const mismatchRun = await runRoute({
      harness: otherProvider,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: { ...validBody, accountId: "acc-d" },
    });
    expect(mismatchRun.response.jsonBodies[0]?.body).toMatchObject({
      code: "INBOX_CONNECTOR_ACCOUNT_SOURCE_MISMATCH",
      context: { accountSource: "discord" },
    });
    expect(mismatchRun.response.jsonBodies[0]?.status).toBe(409);
  });

  it("refuses unavailable accounts with 409", async () => {
    const harness = sendHarness();
    await seedAccounts(harness, [
      account({ id: "acc-x", provider: "telegram", status: "pending" }),
    ]);
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: { ...validBody, accountId: "acc-x" },
    });
    expect(matched).toBe(true);
    expect(response.jsonBodies[0]?.status).toBe(409);
    expect(response.jsonBodies[0]?.body).toMatchObject({
      code: "INBOX_CONNECTOR_ACCOUNT_UNAVAILABLE",
    });
  });

  it("blocks non-owner callers from owner-gated accounts", async () => {
    const harness = sendHarness();
    await seedAccounts(harness, [
      account({
        id: "acc-owner",
        provider: "telegram",
        accessGate: "owner_binding",
        role: "OWNER",
      }),
    ]);
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk("USER"),
      body: { ...validBody, accountId: "acc-owner" },
    });
    expect(matched).toBe(true);
    expect(response.jsonBodies[0]?.status).toBe(403);
    expect(response.jsonBodies[0]?.body).toMatchObject({
      code: "INBOX_CONNECTOR_ACCOUNT_CALLER_UNAUTHORIZED",
    });
  });

  it("picks a lone usable account automatically among unusable siblings", async () => {
    const harness = sendHarness();
    await seedAccounts(harness, [
      account({ id: "acc-a", provider: "telegram", status: "disabled" }),
      account({ id: "acc-good", provider: "telegram" }),
    ]);
    harness.sendHandlers.set("telegram\u0000acc-good", async () => {});
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: validBody,
    });
    expect(matched).toBe(true);
    expect(harness.sent[0]?.target).toHaveProperty("accountId", "acc-good");
    expect(response.jsonBodies[0]?.body).toMatchObject({ ok: true });
  });

  it("demands an explicit choice when several usable accounts exist without a default", async () => {
    const harness = sendHarness();
    await seedAccounts(harness, [
      account({ id: "acc-a", provider: "telegram" }),
      account({ id: "acc-b", provider: "telegram" }),
    ]);
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: validBody,
    });
    expect(matched).toBe(true);
    expect(response.jsonBodies[0]?.status).toBe(409);
    expect(response.jsonBodies[0]?.body).toMatchObject({
      code: "INBOX_CONNECTOR_ACCOUNT_AMBIGUOUS",
      context: {
        accountIds: ["acc-a", "acc-b"],
        defaultAccountIds: [],
      },
    });
  });

  it("routes to the single marked default among several usable accounts", async () => {
    const harness = sendHarness();
    await seedAccounts(harness, [
      account({ id: "acc-a", provider: "telegram" }),
      account({ id: "acc-b", provider: "telegram", isDefault: true }),
    ]);
    harness.sendHandlers.set("telegram\u0000acc-b", async () => {});
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: validBody,
    });
    expect(matched).toBe(true);
    expect(harness.sent[0]?.target).toHaveProperty("accountId", "acc-b");
    expect(response.jsonBodies[0]?.body).toMatchObject({ ok: true });
  });

  it("translates account-registry crashes into a structured 500 without dispatching", async () => {
    const harness = sendHarness();
    harness.serviceOverrides.set("connector_account", {
      registerProvider: () => {},
      evaluatePolicy: async () => ({ allowed: false }),
      listAccounts: () => {
        throw new Error("registry exploded");
      },
    });
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: validBody,
    });
    expect(matched).toBe(true);
    expect(response.jsonBodies[0]?.status).toBe(500);
    expect(response.jsonBodies[0]?.body).toMatchObject({
      code: "INBOX_CONNECTOR_ACCOUNT_LOOKUP_FAILED",
    });
    expect(harness.sent).toHaveLength(0);
  });

  it("returns 500 when delivery throws or is not confirmed", async () => {
    const throwing = sendHarness();
    throwing.sendHandlers.set("telegram", async () => {});
    throwing.sendError = new Error("provider down");
    const thrownRun = await runRoute({
      harness: throwing,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: validBody,
    });
    expect(thrownRun.response.errors).toEqual([
      {
        message: "failed to send inbox reply: provider down",
        status: 500,
      },
    ]);

    const refused = sendHarness();
    refused.sendHandlers.set("telegram", async () => {});
    refused.sendMessageToTarget = async () =>
      ({ kind: "not_delivered", reason: "rate_limited" }) as never;
    const refusedRun = await runRoute({
      harness: refused,
      pathname: "/api/inbox/messages",
      method: "POST",
      callerAuthorization: callerOk(),
      body: validBody,
    });
    expect(refusedRun.response.errors[0]?.status).toBe(500);
    expect(refusedRun.response.errors[0]?.message).toContain(
      "failed to send inbox reply",
    );
  });
});

describe("POST /api/inbox/chats/mute", () => {
  function muteHarness() {
    const harness = new InboxHarness();
    harness.addWorld(makeWorld("world-1", "Guild"));
    harness.addRoom(
      makeRoom({ id: "room-1", source: "telegram", worldId: "world-1" }),
    );
    harness.addRoom(makeRoom({ id: "room-noworld", source: "telegram" }));
    return harness;
  }

  it("refuses with 503 while the runtime is absent", async () => {
    const { matched, response } = await runRoute({
      harness: null,
      pathname: "/api/inbox/chats/mute",
      method: "POST",
      body: { roomId: "room-1", action: "mute" },
    });
    expect(matched).toBe(true);
    expect(response.errors).toEqual([
      { message: "runtime not ready", status: 503 },
    ]);
  });

  it("passes the 16 KiB ceiling to the body reader and stops when it already answered", async () => {
    const harness = muteHarness();
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/chats/mute",
      method: "POST",
      body: null,
    });
    expect(matched).toBe(true);
    expect(response.jsonBodies).toHaveLength(0);
    expect(response.errors).toHaveLength(0);
    expect(response.readCalls).toEqual([{ maxBytes: 16 * 1024 }]);
  });

  it("rejects invalid bodies naming the offending field", async () => {
    const harness = muteHarness();
    for (const body of [
      { roomId: "", action: "mute" },
      { roomId: "room-1", action: "banana" },
      { roomId: "room-1", action: "mute", durationMinutes: 43_201 },
      { roomId: "room-1", action: "mute", durationMinutes: 1.5 },
    ]) {
      const { matched, response } = await runRoute({
        harness,
        pathname: "/api/inbox/chats/mute",
        method: "POST",
        body: body as Record<string, unknown>,
      });
      expect(matched).toBe(true);
      expect(response.errors[0]?.status).toBe(400);
      expect(response.errors[0]?.message).toContain("Invalid request body at");
    }
  });

  it("accepts the maximum timed-mute duration at the boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const harness = muteHarness();
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/chats/mute",
      method: "POST",
      body: { roomId: "room-1", action: "mute", durationMinutes: 43_200 },
    });
    expect(matched).toBe(true);
    const body = response.jsonBodies[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      roomId: "room-1",
      scope: "room",
      action: "mute",
      muted: true,
      mutedScope: "room",
    });
    const room = harness.rooms.get("room-1") as Room;
    expect((room.metadata as Record<string, unknown>).agentMuteUntilIso).toBe(
      new Date("2026-01-31T00:00:00.000Z").toISOString(),
    );
  });

  it("mutes and unmutes a room through participant state", async () => {
    const harness = muteHarness();
    const muted = await runRoute({
      harness,
      pathname: "/api/inbox/chats/mute",
      method: "POST",
      body: { roomId: "room-1", action: "mute" },
    });
    expect(muted.response.jsonBodies[0]?.body).toMatchObject({
      ok: true,
      muted: true,
      mutedScope: "room",
    });
    expect(harness.participantStates.get(`room-1:${AGENT_ID}`)).toBe("MUTED");

    const cleared = await runRoute({
      harness,
      pathname: "/api/inbox/chats/mute",
      method: "POST",
      body: { roomId: "room-1", action: "unmute" },
    });
    const body = cleared.response.jsonBodies[0]?.body as Record<
      string,
      unknown
    >;
    expect(body.muted).toBe(false);
    expect("mutedScope" in body).toBe(false);
  });

  it("answers 404 for a missing room", async () => {
    const harness = muteHarness();
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/chats/mute",
      method: "POST",
      body: { roomId: "room-missing", action: "mute" },
    });
    expect(matched).toBe(true);
    expect(response.errors).toEqual([
      { message: "inbox room not found", status: 404 },
    ]);
  });

  it("refuses server-scoped mutes on rooms without a world", async () => {
    const harness = muteHarness();
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/chats/mute",
      method: "POST",
      body: { roomId: "room-noworld", action: "mute", scope: "server" },
    });
    expect(matched).toBe(true);
    expect(response.errors).toEqual([
      { message: "inbox room has no server/world", status: 400 },
    ]);
  });

  it("persists a server-scoped mute on the owning world and reports inherited scope", async () => {
    const harness = muteHarness();
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/chats/mute",
      method: "POST",
      body: { roomId: "room-1", action: "mute", scope: "server" },
    });
    expect(matched).toBe(true);
    expect(response.jsonBodies[0]?.body).toMatchObject({
      ok: true,
      scope: "server",
      muted: true,
      mutedScope: "server",
    });
    const world = harness.worlds.get("world-1") as World;
    expect((world.metadata as Record<string, unknown>).agentMuteState).toBe(
      "MUTED",
    );

    const cleared = await runRoute({
      harness,
      pathname: "/api/inbox/chats/mute",
      method: "POST",
      body: { roomId: "room-1", action: "unmute", scope: "server" },
    });
    const body = cleared.response.jsonBodies[0]?.body as Record<
      string,
      unknown
    >;
    expect(body.muted).toBe(false);
    expect(
      (
        (harness.worlds.get("world-1") as World).metadata as Record<
          string,
          unknown
        >
      ).agentMuteState,
    ).toBeUndefined();
  });

  it("translates state-write failures into a 500", async () => {
    const harness = muteHarness();
    harness.updateParticipantUserState = async () => {
      throw new Error("store offline");
    };
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/chats/mute",
      method: "POST",
      body: { roomId: "room-1", action: "mute" },
    });
    expect(matched).toBe(true);
    expect(response.errors[0]?.status).toBe(500);
    expect(response.errors[0]?.message).toContain(
      "failed to update inbox mute state",
    );
  });
});

describe("GET /api/inbox/chats", () => {
  it("answers empty before boot and when no external rooms exist", async () => {
    const booted = await runRoute({
      harness: null,
      pathname: "/api/inbox/chats",
    });
    expect(booted.response.jsonBodies).toEqual([
      { body: { chats: [], count: 0 }, status: 200 },
    ]);

    const harness = new InboxHarness();
    harness.addWorld(makeWorld("world-1", "Guild"));
    const empty = await runRoute({ harness, pathname: "/api/inbox/chats" });
    expect(empty.response.jsonBodies[0]?.body).toEqual({
      chats: [],
      count: 0,
    });
  });

  it("groups connector rooms into sidebar chats ordered by latest activity", async () => {
    const harness = new InboxHarness();
    harness.addWorld(makeWorld("world-1", "Guild"));
    harness.addRoom(
      makeRoom({
        id: "r-general",
        name: "General",
        source: "telegram",
        worldId: "world-1",
        createdAt: 1500,
      }),
    );
    harness.addRoom(
      makeRoom({
        id: "r-imsg",
        source: "imessage",
        worldId: "world-1",
        createdAt: 1500,
      }),
    );
    harness.addRoom(
      makeRoom({
        id: "r-long",
        source: "telegram",
        worldId: "world-1",
        createdAt: 1400,
      }),
    );
    harness.sendHandlers.set("imessage", async () => {});
    harness.addMemory(
      makeMemory({
        id: "m-old",
        entityId: "alice",
        roomId: "r-general",
        createdAt: 1000,
        source: "Telegram",
        text: "first half",
        metadata: { entityName: "Alice" },
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-new",
        entityId: "alice",
        roomId: "r-general",
        createdAt: 2000,
        source: "Telegram",
        text: "second half",
        metadata: { entityName: "Alice" },
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-long",
        entityId: "bob",
        roomId: "r-long",
        createdAt: 3000,
        source: "telegram",
        text: `x`.repeat(300),
      }),
    );

    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/chats",
    });
    expect(matched).toBe(true);
    const body = response.jsonBodies[0]?.body as {
      chats: Array<Record<string, unknown>>;
      count: number;
    };
    expect(body.count).toBe(3);
    expect(body.chats.map((chat) => chat.id)).toEqual([
      "r-long",
      "r-general",
      "r-imsg",
    ]);

    const general = body.chats[1] as Record<string, unknown>;
    expect(general).toMatchObject({
      title: "General",
      source: "telegram",
      transportSource: "Telegram",
      canSend: false,
      worldLabel: "Guild",
      worldId: "world-1",
      lastMessageText: "second half",
      lastMessageAt: 2000,
      messageCount: 2,
      muted: false,
    });

    const imessage = body.chats[2] as Record<string, unknown>;
    expect(imessage).toMatchObject({
      title: "imessage chat",
      canSend: true,
      lastMessageText: "",
      lastMessageAt: 1500,
      messageCount: 0,
    });

    const long = body.chats[0] as Record<string, unknown>;
    expect(String(long.lastMessageText).length).toBeLessThanOrEqual(140);
  });

  it("skips internal scratch worlds when collecting sidebar rooms", async () => {
    const harness = new InboxHarness();
    harness.addWorld(
      makeWorld("00000000-0000-0000-0000-000000000001", "Autonomy World"),
    );
    harness.addRoom(
      makeRoom({
        id: "r-auto",
        source: "telegram",
        worldId: "00000000-0000-0000-0000-000000000001",
      }),
    );
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/chats",
    });
    expect(matched).toBe(true);
    expect(response.jsonBodies[0]?.body).toEqual({ chats: [], count: 0 });
  });

  it("backfills orphan rooms observed only through recent memories", async () => {
    const harness = new InboxHarness();
    harness.addWorld(makeWorld("world-1", "Guild"));
    harness.addRoom(
      makeRoom({
        id: "r-known",
        source: "telegram",
        worldId: "world-1",
      }),
    );
    harness.addMemory(
      makeMemory({
        id: "m-orphan",
        entityId: "alice",
        roomId: "r-orphan",
        createdAt: 4000,
        source: "telegram",
        text: "who are you",
        metadata: { entityName: "Alice" },
      }),
    );
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/chats",
    });
    expect(matched).toBe(true);
    const body = response.jsonBodies[0]?.body as {
      chats: Array<Record<string, unknown>>;
    };
    const orphan = body.chats.find((chat) => chat.id === "r-orphan");
    expect(orphan).toBeDefined();
    expect(orphan).toMatchObject({
      title: "telegram chat",
      worldLabel: "Unknown world",
      lastMessageText: "who are you",
      lastMessageAt: 4000,
      messageCount: 1,
    });
  });

  it("translates aggregation failures into a 500", async () => {
    const harness = new InboxHarness();
    harness.addWorld(makeWorld("world-1", "Guild"));
    harness.addRoom(
      makeRoom({
        id: "r-1",
        source: "telegram",
        worldId: "world-1",
      }),
    );
    harness.failBulkReads = true;
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/chats",
    });
    expect(matched).toBe(true);
    expect(response.errors[0]?.status).toBe(500);
    expect(response.errors[0]?.message).toContain("failed to load inbox chats");
  });
});

describe("GET /api/inbox/sources", () => {
  it("answers empty before boot and without rooms", async () => {
    const booted = await runRoute({
      harness: null,
      pathname: "/api/inbox/sources",
    });
    expect(booted.response.jsonBodies).toEqual([
      { body: { sources: [] }, status: 200 },
    ]);
  });

  it("lists distinct canonical inbox sources sorted, skipping everything else", async () => {
    const harness = new InboxHarness();
    harness.addWorld(makeWorld("world-1", "Guild"));
    harness.addRoom(
      makeRoom({ id: "r-1", source: "telegram", worldId: "world-1" }),
    );
    for (const [id, source] of [
      ["m-1", "TELEGRAM"],
      ["m-2", "telegram"],
      ["m-3", "discord"],
      ["m-4", "client_chat"],
      ["m-5", ""],
    ] as const) {
      harness.addMemory(
        makeMemory({
          id,
          entityId: "someone",
          roomId: "r-1",
          createdAt: 1000,
          source: source || undefined,
          text: `text ${id}`,
        }),
      );
    }
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/sources",
    });
    expect(matched).toBe(true);
    expect(response.jsonBodies[0]?.body).toEqual({
      sources: ["discord", "telegram"],
    });
  });

  it("translates scan failures into a 500", async () => {
    const harness = new InboxHarness();
    harness.addWorld(makeWorld("world-1", "Guild"));
    harness.addRoom(
      makeRoom({ id: "r-1", source: "telegram", worldId: "world-1" }),
    );
    harness.failBulkReads = true;
    const { matched, response } = await runRoute({
      harness,
      pathname: "/api/inbox/sources",
    });
    expect(matched).toBe(true);
    expect(response.errors).toEqual([
      { message: "failed to load inbox sources: db down", status: 500 },
    ]);
  });
});

describe("module surface", () => {
  it("exports a safe integer cache ceiling above one page of messages", () => {
    expect(Number.isSafeInteger(MAX_DISCORD_PROFILE_CACHE_ENTRIES)).toBe(true);
    expect(MAX_DISCORD_PROFILE_CACHE_ENTRIES).toBeGreaterThanOrEqual(500);
  });
});
