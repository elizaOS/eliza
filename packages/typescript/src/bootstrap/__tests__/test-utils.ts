/**
 * @fileoverview Test Utilities for Bootstrap Plugin Tests
 *
 * Creates REAL AgentRuntime instances for testing.
 * Uses actual AgentRuntime with mocked database adapter.
 */

import { v4 as uuidv4 } from "uuid";
import { vi } from "vitest";
import { AgentRuntime } from "../../runtime";
import type {
  Agent,
  Character,
  Content,
  Entity,
  IAgentRuntime,
  IDatabaseAdapter,
  Memory,
  MemoryMetadata,
  PairingAllowlistEntry,
  PairingRequest,
  Plugin,
  Room,
  State,
  Task,
  UUID,
  World,
} from "../../types";
import { ChannelType, MemoryType } from "../../types";

/**
 * Converts a string to a UUID type
 */
export function stringToUuid(str: string): UUID {
  return str as UUID;
}

/**
 * Creates a UUID for testing
 */
export function createUUID(): UUID {
  return stringToUuid(uuidv4());
}

/**
 * Default test character configuration
 */
export const DEFAULT_TEST_CHARACTER: Character = {
  name: "Test Agent",
  bio: ["A test agent for unit testing"],
  system: "You are a helpful assistant used for testing. Respond concisely.",
  plugins: [],
  settings: {},
  messageExamples: [],
  postExamples: [],
  topics: ["testing"],
  adjectives: ["helpful", "test"],
  style: { all: [], chat: [], post: [] },
};

/**
 * Creates a test character with sensible defaults
 */
export function createTestCharacter(
  overrides: Partial<Character> = {},
): Character {
  return {
    ...DEFAULT_TEST_CHARACTER,
    id: createUUID(),
    ...overrides,
  };
}

/**
 * Creates a database adapter for testing.
 * Uses in-memory maps to simulate database operations.
 */
export function createTestDatabaseAdapter(agentId?: UUID): IDatabaseAdapter {
  const resolvedAgentId = agentId || createUUID();

  // In-memory storage
  const agents = new Map<string, Partial<Agent>>();
  const memories = new Map<UUID, Memory>();
  const rooms = new Map<UUID, Room>();
  const worlds = new Map<UUID, World>();
  const entities = new Map<UUID, Entity>();
  const tasks = new Map<UUID, Task>();
  const cache = new Map<string, unknown>();
  const participants = new Map<UUID, Set<UUID>>();
  const participantStates = new Map<string, string | null>();

  return {
    db: {},
    init: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockResolvedValue({}),
    isReady: vi.fn().mockResolvedValue(true),

    getAgentsByIds: vi.fn(async (agentIds: UUID[]) => {
      return agentIds
        .map((id) => agents.get(String(id)))
        .filter((a): a is Partial<Agent> => a != null && a.id != null) as Agent[];
    }),
    getAgents: vi.fn(async () => Array.from(agents.values())),
    createAgents: vi.fn(async (agentsToCreate: Partial<Agent>[]) => {
      const ids: UUID[] = [];
      for (const agent of agentsToCreate) {
        if (agent.id) {
          agents.set(String(agent.id), agent);
          ids.push(agent.id);
        }
      }
      return ids;
    }),
    upsertAgents: vi.fn(async (agentsToUpsert: Partial<Agent>[]) => {
      for (const agent of agentsToUpsert) {
        if (agent.id) {
          agents.set(String(agent.id), agent);
        }
      }
    }),
    updateAgents: vi.fn().mockResolvedValue(true),
    deleteAgents: vi.fn().mockResolvedValue(true),
    ensureEmbeddingDimension: vi.fn().mockResolvedValue(undefined),

    getMemories: vi.fn(async (params: { roomId?: UUID; count?: number }) => {
      const result: Memory[] = [];
      for (const mem of memories.values()) {
        if (!params.roomId || mem.roomId === params.roomId) {
          result.push(mem);
        }
      }
      return result.slice(0, params.count || 100);
    }),
    getMemoriesByIds: vi.fn(
      async (ids: UUID[]) =>
        ids.map((id) => memories.get(id)).filter(Boolean) as Memory[],
    ),
    getMemoriesByRoomIds: vi.fn(async (params: { roomIds: UUID[] }) => {
      const result: Memory[] = [];
      for (const mem of memories.values()) {
        if (params.roomIds.includes(mem.roomId)) {
          result.push(mem);
        }
      }
      return result;
    }),
    getCachedEmbeddings: vi.fn().mockResolvedValue([]),
    searchMemories: vi.fn().mockResolvedValue([]),
    createMemories: vi.fn(async (memoryBatch: Array<{ memory: Memory; tableName: string; unique?: boolean }>) => {
      const ids: UUID[] = [];
      for (const { memory } of memoryBatch) {
        const id = memory.id || createUUID();
        memories.set(id, { ...memory, id });
        ids.push(id);
      }
      return ids;
    }),
    updateMemories: vi.fn(async (memoryBatch: Array<Partial<Memory> & { id: UUID }>) => {
      return memoryBatch.map((mem) => {
        const existing = memories.get(mem.id);
        if (existing) {
          memories.set(mem.id, { ...existing, ...mem });
          return true;
        }
        return false;
      });
    }),
    deleteMemories: vi.fn(async (ids: UUID[]) => {
      for (const id of ids) {
        memories.delete(id);
      }
    }),
    deleteAllMemories: vi.fn().mockResolvedValue(undefined),
    countMemories: vi.fn().mockResolvedValue(0),
    getMemoriesByWorldId: vi.fn().mockResolvedValue([]),

    getEntitiesByIds: vi.fn(
      async (ids: UUID[]) =>
        ids.map((id) => entities.get(id)).filter(Boolean) as Entity[],
    ),
    getEntitiesForRoom: vi.fn().mockResolvedValue([]),
    createEntities: vi.fn(async (newEntities: Entity[]) => {
      const ids: UUID[] = [];
      for (const entity of newEntities) {
        const id = entity.id || createUUID();
        entities.set(id, { ...entity, id });
        ids.push(id);
      }
      return ids;
    }),
    updateEntities: vi.fn(async (entitiesToUpdate: Entity[]) => {
      for (const entity of entitiesToUpdate) {
        if (entity.id && entities.has(entity.id)) {
          entities.set(entity.id, { ...entities.get(entity.id), ...entity });
        }
      }
    }),
    deleteEntities: vi.fn(async (ids: UUID[]) => {
      for (const id of ids) {
        entities.delete(id);
      }
    }),

    getComponent: vi.fn().mockResolvedValue(null),
    getComponents: vi.fn().mockResolvedValue([]),
    createComponents: vi.fn().mockResolvedValue(true),
    getComponentsByIds: vi.fn().mockResolvedValue([]),
    updateComponents: vi.fn().mockResolvedValue(undefined),
    deleteComponents: vi.fn().mockResolvedValue(undefined),

    getRoomsByIds: vi.fn(
      async (ids: UUID[]) =>
        ids.map((id) => rooms.get(id)).filter(Boolean) as Room[],
    ),
    createRooms: vi.fn(async (newRooms: Room[]) => {
      const ids: UUID[] = [];
      for (const room of newRooms) {
        const id = room.id || createUUID();
        rooms.set(id, { ...room, id });
        participants.set(id, new Set());
        ids.push(id);
      }
      return ids;
    }),
    updateRooms: vi.fn(async (roomsToUpdate: Room[]) => {
      for (const room of roomsToUpdate) {
        if (room.id) {
          rooms.set(room.id, room);
        }
      }
    }),
    deleteRooms: vi.fn(async (ids: UUID[]) => {
      for (const id of ids) {
        rooms.delete(id);
        participants.delete(id);
      }
    }),
    deleteRoomsByWorldId: vi.fn().mockResolvedValue(undefined),
    getRoomsForParticipant: vi.fn().mockResolvedValue([]),
    getRoomsForParticipants: vi.fn().mockResolvedValue([]),
    getRoomsByWorld: vi.fn(async (worldId: UUID) => {
      const result: Room[] = [];
      for (const room of rooms.values()) {
        if (room.worldId === worldId) {
          result.push(room);
        }
      }
      return result;
    }),

    addRoomParticipants: vi.fn(async (entityIds: UUID[], roomId: UUID) => {
      let roomParticipants = participants.get(roomId);
      if (!roomParticipants) {
        roomParticipants = new Set();
        participants.set(roomId, roomParticipants);
      }
      for (const id of entityIds) {
        roomParticipants.add(id);
      }
      return true;
    }),
    createRoomParticipants: vi.fn(async (entityIds: UUID[], roomId: UUID) => {
      let roomParticipants = participants.get(roomId);
      if (!roomParticipants) {
        roomParticipants = new Set();
        participants.set(roomId, roomParticipants);
      }
      for (const id of entityIds) {
        roomParticipants.add(id);
      }
      return entityIds;
    }),
    deleteParticipants: vi.fn().mockResolvedValue(true),
    getParticipantsForEntity: vi.fn().mockResolvedValue([]),
    getParticipantsForRoom: vi.fn(async (roomId: UUID) => {
      const roomParticipants = participants.get(roomId);
      return roomParticipants ? Array.from(roomParticipants) : [];
    }),
    isRoomParticipant: vi.fn().mockResolvedValue(false),
    getParticipantUserState: vi.fn(async (roomId: UUID, entityId: UUID) => {
      return participantStates.get(`${roomId}-${entityId}`) || null;
    }),
    setParticipantUserState: vi.fn(
      async (roomId: UUID, entityId: UUID, state: string | null) => {
        participantStates.set(`${roomId}-${entityId}`, state);
      },
    ),

    createWorlds: vi.fn(async (worldsToCreate: World[]) => {
      const ids: UUID[] = [];
      for (const world of worldsToCreate) {
        const id = world.id || createUUID();
        worlds.set(id, { ...world, id });
        ids.push(id);
      }
      return ids;
    }),
    getWorldsByIds: vi.fn(async (ids: UUID[]) =>
      ids.map((id) => worlds.get(id)).filter(Boolean) as World[],
    ),
    deleteWorlds: vi.fn(async (ids: UUID[]) => {
      for (const id of ids) {
        worlds.delete(id);
      }
    }),
    getAllWorlds: vi.fn(async () => Array.from(worlds.values())),
    updateWorlds: vi.fn(async (worldsToUpdate: World[]) => {
      for (const world of worldsToUpdate) {
        if (world.id) {
          worlds.set(world.id, world);
        }
      }
    }),

    getRelationship: vi.fn().mockResolvedValue(null),
    getRelationships: vi.fn().mockResolvedValue([]),
    createRelationships: vi.fn().mockResolvedValue(true),
    getRelationshipsByIds: vi.fn().mockResolvedValue([]),
    updateRelationships: vi.fn().mockResolvedValue(undefined),
    deleteRelationships: vi.fn().mockResolvedValue(undefined),

    getCaches: vi.fn(async <T>(keys: string[]) => {
      const result = new Map<string, T>();
      for (const key of keys) {
        const value = cache.get(key) as T | undefined;
        if (value !== undefined) {
          result.set(key, value);
        }
      }
      return result;
    }),
    setCaches: vi.fn(async <T>(entries: Array<{ key: string; value: T }>) => {
      for (const { key, value } of entries) {
        cache.set(key, value);
      }
      return true;
    }),
    deleteCaches: vi.fn(async (keys: string[]) => {
      for (const key of keys) {
        cache.delete(key);
      }
      return true;
    }),

    getTasks: vi.fn().mockResolvedValue([]),
    getTasksByName: vi.fn().mockResolvedValue([]),
    createTasks: vi.fn(async (tasksToCreate: Task[]) => {
      const ids: UUID[] = [];
      for (const task of tasksToCreate) {
        const id = task.id || createUUID();
        tasks.set(id, { ...task, id });
        ids.push(id);
      }
      return ids;
    }),
    getTasksByIds: vi.fn(async (ids: UUID[]) =>
      ids.map((id) => tasks.get(id)).filter(Boolean) as Task[],
    ),
    updateTasks: vi.fn(async (updates: Array<{ id: UUID; task: Partial<Task> }>) => {
      for (const { id, task } of updates) {
        const existing = tasks.get(id);
        if (existing) {
          tasks.set(id, { ...existing, ...task });
        }
      }
    }),
    deleteTasks: vi.fn(async (ids: UUID[]) => {
      for (const id of ids) {
        tasks.delete(id);
      }
    }),

    getLogs: vi.fn().mockResolvedValue([]),
    createLogs: vi.fn().mockResolvedValue(undefined),
    deleteLogs: vi.fn().mockResolvedValue(undefined),
    getAgentRunSummaries: vi.fn().mockResolvedValue({ runs: [], totalCount: 0 }),

    getPairingRequests: vi.fn().mockResolvedValue([]),
    getPairingAllowlist: vi.fn().mockResolvedValue([]),
    createPairingRequests: vi.fn(async (requests: PairingRequest[]) => requests.map(() => createUUID())),
    updatePairingRequests: vi.fn().mockResolvedValue(undefined),
    deletePairingRequests: vi.fn().mockResolvedValue(undefined),
    createPairingAllowlistEntries: vi.fn(async (entries: PairingAllowlistEntry[]) => entries.map(() => createUUID())),
    deletePairingAllowlistEntries: vi.fn().mockResolvedValue(undefined),
  } as IDatabaseAdapter;
}

/**
 * Creates a REAL AgentRuntime for testing.
 * This is the primary way to create test runtimes.
 */
export async function createTestRuntime(
  options: {
    character?: Partial<Character>;
    adapter?: IDatabaseAdapter;
    plugins?: Plugin[];
    skipInitialize?: boolean;
  } = {},
): Promise<IAgentRuntime> {
  const character = createTestCharacter(options.character);
  const agentId = character.id || createUUID();
  const adapter = options.adapter || createTestDatabaseAdapter(agentId);

  const runtime = new AgentRuntime({
    agentId,
    character,
    adapter,
    plugins: options.plugins,
  });

  if (!options.skipInitialize) {
    await runtime.initialize();
  }

  return runtime;
}

/**
 * Creates a test Memory object
 */
export function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  const id = createUUID();
  return {
    id,
    roomId: overrides.roomId || ("test-room-id" as UUID),
    entityId: overrides.entityId || ("test-entity-id" as UUID),
    agentId: overrides.agentId || ("test-agent-id" as UUID),
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

/**
 * Creates a test State object
 */
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
        serverId: "test-server-id" as UUID,
        source: "test",
      },
      ...overrides.data,
    },
    text: "",
    ...overrides,
  };
}

/**
 * Creates a test Room object
 */
export function createTestRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: createUUID(),
    name: "Test Room",
    worldId: createUUID(),
    serverId: createUUID(),
    source: "test",
    type: ChannelType.GROUP,
    ...overrides,
  };
}

/**
 * Creates a standardized setup for action tests with REAL runtime.
 */
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
        serverId: "test-server-id" as UUID,
        source: "test",
      },
    },
    ...options?.stateOverrides,
  });

  const callback = vi.fn().mockResolvedValue([] as Memory[]);

  return {
    runtime,
    message,
    state,
    callback,
    agentId,
    roomId,
    entityId,
  };
}

/**
 * Cleans up a test runtime
 */
export async function cleanupTestRuntime(
  runtime: IAgentRuntime | undefined,
): Promise<void> {
  if (!runtime) return;
  await runtime.stop();
}

/**
 * Helper to wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 5000,
  interval = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Condition not met within ${timeout}ms`);
}
