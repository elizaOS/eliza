/**
 * @fileoverview Test Utilities for Code App Tests
 *
 * Creates real AgentRuntime instances with an in-memory adapter.
 */

import {
  AgentRuntime,
  ChannelType,
  type Character,
  type Content,
  type Entity,
  type IAgentRuntime,
  type IDatabaseAdapter,
  type Memory,
  type MemoryMetadata,
  MemoryType,
  type Plugin,
  type Room,
  type State,
  type Task,
  type UUID,
  type World,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { vi } from "vitest";

type AdapterRecord = Record<PropertyKey, unknown>;

export function createUUID(): UUID {
  return uuidv4() as UUID;
}

export const DEFAULT_TEST_CHARACTER: Character = {
  name: "Test Agent",
  bio: ["A test agent for unit testing"],
  system: "You are a helpful assistant used for testing. Respond concisely.",
  templates: {},
  plugins: [],
  knowledge: [],
  secrets: {},
  settings: {},
  messageExamples: [],
  postExamples: [],
  topics: ["testing"],
  adjectives: ["helpful", "test"],
  style: { all: [], chat: [], post: [] },
};

export function createTestCharacter(
  overrides: Partial<Character> = {},
): Character {
  return {
    ...DEFAULT_TEST_CHARACTER,
    id: createUUID(),
    ...overrides,
  };
}

const resolved = <T>(value: T) => vi.fn().mockResolvedValue(value);

export function createTestDatabaseAdapter(
  agentId = createUUID(),
): IDatabaseAdapter {
  const memories = new Map<UUID, Memory>();
  const rooms = new Map<UUID, Room>();
  const worlds = new Map<UUID, World>();
  const entities = new Map<UUID, Entity>();
  const tasks = new Map<UUID, Task>();
  const cache = new Map<string, unknown>();
  const participants = new Map<UUID, Set<UUID>>();
  const participantStates = new Map<string, string | null>();

  const adapter: AdapterRecord = {
    db: {},
    init: resolved(undefined),
    initialize: resolved(undefined),
    close: resolved(undefined),
    getConnection: resolved({}),
    isReady: resolved(true),

    getAgent: resolved({ id: agentId, name: "TestAgent" }),
    getAgents: resolved([]),
    getAgentsByIds: vi.fn(async (ids: UUID[]) =>
      ids.map((id) => ({ id, name: "TestAgent" })),
    ),
    createAgent: resolved(true),
    createAgents: resolved(true),
    updateAgent: resolved(true),
    updateAgents: resolved(true),
    deleteAgent: resolved(true),
    deleteAgents: resolved(true),
    ensureEmbeddingDimension: resolved(undefined),

    getMemories: vi.fn(async (params: { roomId?: UUID; count?: number } = {}) =>
      Array.from(memories.values())
        .filter((memory) => !params.roomId || memory.roomId === params.roomId)
        .slice(0, params.count ?? 100),
    ),
    getMemoryById: vi.fn(async (id: UUID) => memories.get(id) ?? null),
    getMemoriesByIds: vi.fn(async (ids: UUID[]) =>
      ids.map((id) => memories.get(id)).filter(Boolean),
    ),
    getMemoriesByRoomIds: vi.fn(async (params: { roomIds: UUID[] }) =>
      Array.from(memories.values()).filter((memory) =>
        params.roomIds.includes(memory.roomId),
      ),
    ),
    getMemoriesByWorldId: resolved([]),
    getCachedEmbeddings: resolved([]),
    searchMemories: resolved([]),
    createMemory: vi.fn(async (memory: Memory) => {
      const id = memory.id ?? createUUID();
      memories.set(id, { ...memory, id });
      return id;
    }),
    updateMemory: resolved(true),
    deleteMemory: vi.fn(async (id: UUID) => {
      memories.delete(id);
    }),
    deleteManyMemories: vi.fn(async (ids: UUID[]) => {
      for (const id of ids) memories.delete(id);
    }),
    deleteAllMemories: resolved(undefined),
    countMemories: resolved(0),

    getEntitiesByIds: vi.fn(async (ids: UUID[]) =>
      ids.map((id) => entities.get(id)).filter(Boolean),
    ),
    getEntitiesForRoom: resolved([]),
    createEntities: vi.fn(async (newEntities: Entity[]) => {
      for (const entity of newEntities) {
        if (entity.id) entities.set(entity.id, entity);
      }
      return true;
    }),
    updateEntity: resolved(undefined),

    getRoomsByIds: vi.fn(async (ids: UUID[]) =>
      ids.map((id) => rooms.get(id)).filter(Boolean),
    ),
    createRooms: vi.fn(async (newRooms: Room[]) => {
      const ids: UUID[] = [];
      for (const room of newRooms) {
        const id = room.id ?? createUUID();
        rooms.set(id, { ...room, id });
        participants.set(id, new Set());
        ids.push(id);
      }
      return ids;
    }),
    deleteRoom: vi.fn(async (id: UUID) => {
      rooms.delete(id);
      participants.delete(id);
    }),
    deleteRoomsByWorldId: resolved(undefined),
    updateRoom: vi.fn(async (room: Room) => {
      if (room.id) rooms.set(room.id, room);
    }),
    getRoomsForParticipant: resolved([]),
    getRoomsForParticipants: resolved([]),
    getRoomsByWorld: vi.fn(async (worldId: UUID) =>
      Array.from(rooms.values()).filter((room) => room.worldId === worldId),
    ),

    addParticipantsRoom: vi.fn(async (entityIds: UUID[], roomId: UUID) => {
      const roomParticipants = participants.get(roomId) ?? new Set<UUID>();
      participants.set(roomId, roomParticipants);
      for (const id of entityIds) roomParticipants.add(id);
      return true;
    }),
    removeParticipant: resolved(true),
    getParticipantsForEntity: resolved([]),
    getParticipantsForRoom: vi.fn(async (roomId: UUID) =>
      Array.from(participants.get(roomId) ?? []),
    ),
    isRoomParticipant: resolved(false),
    getParticipantUserState: vi.fn(
      async (roomId: UUID, entityId: UUID) =>
        participantStates.get(`${roomId}-${entityId}`) ?? null,
    ),
    setParticipantUserState: vi.fn(
      async (roomId: UUID, entityId: UUID, state: string | null) => {
        participantStates.set(`${roomId}-${entityId}`, state);
      },
    ),

    createWorld: vi.fn(async (world: World) => {
      const id = world.id ?? createUUID();
      worlds.set(id, { ...world, id });
      return id;
    }),
    getWorld: vi.fn(async (id: UUID) => worlds.get(id) ?? null),
    removeWorld: vi.fn(async (id: UUID) => {
      worlds.delete(id);
    }),
    getAllWorlds: vi.fn(async () => Array.from(worlds.values())),
    updateWorld: vi.fn(async (world: World) => {
      if (world.id) worlds.set(world.id, world);
    }),

    createRelationship: resolved(true),
    updateRelationship: resolved(undefined),
    getRelationship: resolved(null),
    getRelationships: resolved([]),

    getCache: vi.fn(async <T>(key: string) => cache.get(key) as T | undefined),
    setCache: vi.fn(async <T>(key: string, value: T) => {
      cache.set(key, value);
      return true;
    }),
    deleteCache: vi.fn(async (key: string) => {
      cache.delete(key);
      return true;
    }),

    createTask: vi.fn(async (task: Task) => {
      const id = task.id ?? createUUID();
      tasks.set(id, { ...task, id });
      return id;
    }),
    getTasks: resolved([]),
    getTask: vi.fn(async (id: UUID) => tasks.get(id) ?? null),
    getTasksByName: resolved([]),
    updateTask: resolved(undefined),
    deleteTask: vi.fn(async (id: UUID) => {
      tasks.delete(id);
    }),

    log: resolved(undefined),
    getLogs: resolved([]),
    deleteLog: resolved(undefined),
  };

  return new Proxy(adapter, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== "string") return undefined;
      const fallback = resolved(undefined);
      target[prop] = fallback;
      return fallback;
    },
  }) as unknown as IDatabaseAdapter;
}

export async function createTestRuntime(
  options: {
    character?: Partial<Character>;
    adapter?: IDatabaseAdapter;
    plugins?: Plugin[];
    skipInitialize?: boolean;
  } = {},
): Promise<IAgentRuntime> {
  const character = createTestCharacter(options.character);
  const agentId = character.id ?? createUUID();
  const adapter = options.adapter ?? createTestDatabaseAdapter(agentId);
  const runtime = new AgentRuntime({
    agentId,
    character,
    adapter,
    plugins: options.plugins ?? [],
  });

  if (!options.skipInitialize) {
    await runtime.initialize();
  }

  return runtime;
}

export function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: createUUID(),
    roomId: overrides.roomId ?? ("test-room-id" as UUID),
    entityId: overrides.entityId ?? ("test-entity-id" as UUID),
    agentId: overrides.agentId ?? ("test-agent-id" as UUID),
    content: {
      text: "Test message",
      channelType: ChannelType.GROUP,
      ...overrides.content,
    } as Content,
    createdAt: Date.now(),
    metadata: { type: MemoryType.MESSAGE } as MemoryMetadata,
    ...overrides,
  };
}

export function createTestState(overrides: Partial<State> = {}): State {
  return {
    values: {
      agentName: "Test Agent",
      recentMessages: "User: Test message",
      ...overrides.values,
    },
    data: {
      room: {
        id: "test-room-id" as UUID,
        type: ChannelType.GROUP,
        worldId: "test-world-id" as UUID,
        messageServerId: "test-server-id" as UUID,
        source: "test",
      },
      ...overrides.data,
    },
    text: "",
    ...overrides,
  };
}

export async function setupActionTest(options?: {
  characterOverrides?: Partial<Character>;
  messageOverrides?: Partial<Memory>;
  stateOverrides?: Partial<State>;
  plugins?: Plugin[];
}): Promise<{
  runtime: IAgentRuntime;
  message: Memory;
  state: State;
  callback: ReturnType<typeof vi.fn>;
  agentId: UUID;
  roomId: UUID;
  entityId: UUID;
}> {
  const runtime = await createTestRuntime({
    character: options?.characterOverrides,
    plugins: options?.plugins,
  });
  const agentId = runtime.agentId;
  const roomId = createUUID();
  const entityId = createUUID();
  const message = createTestMemory({
    roomId,
    entityId,
    agentId,
    ...options?.messageOverrides,
  });
  const state = createTestState({
    data: {
      room: {
        id: roomId,
        type: ChannelType.GROUP,
        worldId: "test-world-id" as UUID,
        messageServerId: "test-server-id" as UUID,
        source: "test",
      },
    },
    ...options?.stateOverrides,
  });

  return {
    runtime,
    message,
    state,
    callback: vi.fn().mockResolvedValue([] as Memory[]),
    agentId,
    roomId,
    entityId,
  };
}

export async function cleanupTestRuntime(
  runtime: IAgentRuntime,
): Promise<void> {
  await runtime.stop();
}
