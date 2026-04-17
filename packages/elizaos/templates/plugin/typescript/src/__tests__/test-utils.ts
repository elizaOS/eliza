/**
 * @fileoverview Test Utilities for Plugin Tests
 *
 * Creates REAL AgentRuntime instances for testing.
 * Uses actual AgentRuntime with mocked database adapter.
 */

import {
  type Agent,
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
  type Participant,
  type Plugin,
  type Room,
  type State,
  type Task,
  type UUID,
  type World,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { vi } from "vitest";

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

/**
 * Creates a test character with sensible defaults
 */
export function createTestCharacter(overrides: Partial<Character> = {}): Character {
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
  const trajectoryColumns = [
    "id",
    "trajectory_id",
    "agent_id",
    "source",
    "status",
    "start_time",
    "end_time",
    "duration_ms",
    "step_count",
    "llm_call_count",
    "provider_access_count",
    "total_prompt_tokens",
    "total_completion_tokens",
    "total_reward",
    "scenario_id",
    "episode_id",
    "batch_id",
    "group_index",
    "steps_json",
    "reward_components_json",
    "metrics_json",
    "metadata_json",
    "is_training_data",
    "is_evaluation",
    "used_in_training",
    "judged_at",
    "created_at",
    "updated_at",
  ];

  // In-memory storage
  const agents = new Map<UUID, Agent>();
  const memories = new Map<UUID, Memory>();
  const rooms = new Map<UUID, Room>();
  const worlds = new Map<UUID, World>();
  const entities = new Map<UUID, Entity>();
  const tasks = new Map<UUID, Task>();
  const cache = new Map<string, unknown>();
  const participants = new Map<UUID, Set<UUID>>();
  const participantStates = new Map<string, string | null>();

  agents.set(resolvedAgentId, {
    id: resolvedAgentId,
    name: "TestAgent",
  } as Agent);

  return {
    db: {
      execute: vi.fn(async (query: { queryChunks?: unknown[] }) => {
        const sqlText = JSON.stringify(query?.queryChunks ?? query);
        if (sqlText.includes("information_schema.columns")) {
          return {
            rows: trajectoryColumns.map((column_name) => ({ column_name })),
            fields: [{ name: "column_name" }],
          };
        }
        if (sqlText.includes("PRAGMA table_info(trajectories)")) {
          return {
            rows: trajectoryColumns.map((name) => ({ name })),
            fields: [{ name: "name" }],
          };
        }
        return {
          rows: [],
          fields: [],
        };
      }),
    },
    init: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockResolvedValue({}),
    isReady: vi.fn().mockResolvedValue(true),

    getAgent: vi.fn(async (id: UUID) => agents.get(id) || null),
    getAgents: vi.fn(async () => Array.from(agents.values())),
    createAgent: vi.fn(async (agent: Partial<Agent>) => {
      const id = agent.id || resolvedAgentId;
      agents.set(id, { id, ...agent } as Agent);
      return true;
    }),
    updateAgent: vi.fn(async (id: UUID, agent: Partial<Agent>) => {
      const existing = agents.get(id);
      agents.set(id, { ...(existing || { id }), ...agent, id } as Agent);
      return true;
    }),
    deleteAgent: vi.fn(async (id: UUID) => {
      agents.delete(id);
      return true;
    }),
    getAgentsByIds: vi.fn(
      async (ids: UUID[]) => ids.map((id) => agents.get(id)).filter(Boolean) as Agent[],
    ),
    createAgents: vi.fn(async (newAgents: Partial<Agent>[]) => {
      const ids: UUID[] = [];
      for (const agent of newAgents) {
        const id = agent.id || createUUID();
        agents.set(id, { id, ...agent } as Agent);
        ids.push(id);
      }
      return ids;
    }),
    upsertAgents: vi.fn(async (newAgents: Partial<Agent>[]) => {
      for (const agent of newAgents) {
        const id = agent.id || createUUID();
        const existing = agents.get(id);
        agents.set(id, { ...(existing || { id }), ...agent, id } as Agent);
      }
    }),
    updateAgents: vi.fn(
      async (updates: Array<{ agentId: UUID; agent: Partial<Agent> }>) => {
        for (const { agentId: id, agent } of updates) {
          const existing = agents.get(id);
          agents.set(id, { ...(existing || { id }), ...agent, id } as Agent);
        }
        return true;
      },
    ),
    deleteAgents: vi.fn(async (ids: UUID[]) => {
      for (const id of ids) {
        agents.delete(id);
      }
      return true;
    }),
    countAgents: vi.fn(async () => agents.size),
    cleanupAgents: vi.fn(async () => {
      agents.clear();
    }),
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
    getMemoryById: vi.fn(async (id: UUID) => memories.get(id) || null),
    getMemoriesByIds: vi.fn(
      async (ids: UUID[]) => ids.map((id) => memories.get(id)).filter(Boolean) as Memory[],
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
    createMemory: vi.fn(async (memory: Memory) => {
      const id = memory.id || createUUID();
      memories.set(id, { ...memory, id });
      return id;
    }),
    updateMemory: vi.fn().mockResolvedValue(true),
    deleteMemory: vi.fn(async (id: UUID) => {
      memories.delete(id);
    }),
    deleteManyMemories: vi.fn(async (ids: UUID[]) => {
      for (const id of ids) {
        memories.delete(id);
      }
    }),
    deleteAllMemories: vi.fn().mockResolvedValue(undefined),
    countMemories: vi.fn().mockResolvedValue(0),
    getMemoriesByWorldId: vi.fn().mockResolvedValue([]),

    getEntitiesByIds: vi.fn(
      async (ids: UUID[]) => ids.map((id) => entities.get(id)).filter(Boolean) as Entity[],
    ),
    getEntitiesForRoom: vi.fn().mockResolvedValue([]),
    createEntities: vi.fn(async (newEntities: Entity[]) => {
      for (const entity of newEntities) {
        if (entity.id) {
          entities.set(entity.id, entity);
        }
      }
      return true;
    }),
    updateEntity: vi.fn().mockResolvedValue(undefined),

    getComponent: vi.fn().mockResolvedValue(null),
    getComponents: vi.fn().mockResolvedValue([]),
    createComponent: vi.fn().mockResolvedValue(true),
    updateComponent: vi.fn().mockResolvedValue(undefined),
    deleteComponent: vi.fn().mockResolvedValue(undefined),

    getRoomsByIds: vi.fn(
      async (ids: UUID[]) => ids.map((id) => rooms.get(id)).filter(Boolean) as Room[],
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
    deleteRoom: vi.fn(async (id: UUID) => {
      rooms.delete(id);
      participants.delete(id);
    }),
    deleteRoomsByWorldId: vi.fn().mockResolvedValue(undefined),
    updateRoom: vi.fn(async (room: Room) => {
      if (room.id) {
        rooms.set(room.id, room);
      }
    }),
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
    getRoomsByWorlds: vi.fn(async (worldIds: UUID[]) => {
      const result: Room[] = [];
      for (const room of rooms.values()) {
        if (worldIds.includes(room.worldId)) {
          result.push(room);
        }
      }
      return result;
    }),
    updateRooms: vi.fn(async (updatedRooms: Room[]) => {
      for (const room of updatedRooms) {
        if (room.id) {
          rooms.set(room.id, room);
        }
      }
    }),
    deleteRooms: vi.fn(async (roomIds: UUID[]) => {
      for (const id of roomIds) {
        rooms.delete(id);
        participants.delete(id);
      }
    }),
    upsertRooms: vi.fn(async (upsertedRooms: Room[]) => {
      for (const room of upsertedRooms) {
        const id = room.id || createUUID();
        rooms.set(id, { ...room, id });
        participants.set(id, participants.get(id) || new Set());
      }
    }),

    addParticipantsRoom: vi.fn(async (entityIds: UUID[], roomId: UUID) => {
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
      const ids: UUID[] = [];
      for (const id of entityIds) {
        roomParticipants.add(id);
        ids.push(createUUID());
      }
      return ids;
    }),
    deleteParticipants: vi.fn(
      async (entries: Array<{ entityId: UUID; roomId: UUID }>) => {
        for (const { entityId, roomId } of entries) {
          participants.get(roomId)?.delete(entityId);
          participantStates.delete(`${roomId}-${entityId}`);
        }
        return true;
      },
    ),
    removeParticipant: vi.fn().mockResolvedValue(true),
    getParticipantsForEntity: vi.fn().mockResolvedValue([]),
    getParticipantsForEntities: vi.fn(async (entityIds: UUID[]) => {
      const result: Participant[] = [];
      for (const [roomId, roomParticipants] of participants.entries()) {
        for (const entityId of entityIds) {
          if (roomParticipants.has(entityId)) {
            result.push({ entityId, roomId } as Participant);
          }
        }
      }
      return result;
    }),
    getParticipantsForRoom: vi.fn(async (roomId: UUID) => {
      const roomParticipants = participants.get(roomId);
      return roomParticipants ? Array.from(roomParticipants) : [];
    }),
    getParticipantsForRooms: vi.fn(async (roomIds: UUID[]) => {
      return roomIds.map((roomId) => ({
        roomId,
        entityIds: Array.from(participants.get(roomId) || []),
      }));
    }),
    areRoomParticipants: vi.fn(
      async (pairs: Array<{ roomId: UUID; entityId: UUID }>) =>
        pairs.map(({ roomId, entityId }) =>
          (participants.get(roomId) || new Set()).has(entityId),
        ),
    ),
    isRoomParticipant: vi.fn().mockResolvedValue(false),
    getParticipantUserState: vi.fn(async (roomId: UUID, entityId: UUID) => {
      return participantStates.get(`${roomId}-${entityId}`) || null;
    }),
    setParticipantUserState: vi.fn(async (roomId: UUID, entityId: UUID, state: string | null) => {
      participantStates.set(`${roomId}-${entityId}`, state);
    }),
    getParticipantUserStates: vi.fn(
      async (pairs: Array<{ roomId: UUID; entityId: UUID }>) =>
        pairs.map(({ roomId, entityId }) => participantStates.get(`${roomId}-${entityId}`) || null),
    ),
    updateParticipantUserStates: vi.fn(
      async (updates: Array<{ roomId: UUID; entityId: UUID; state: string | null }>) => {
        for (const { roomId, entityId, state } of updates) {
          participantStates.set(`${roomId}-${entityId}`, state);
        }
      },
    ),

    createWorld: vi.fn(async (world: World) => {
      const id = world.id || createUUID();
      worlds.set(id, { ...world, id });
      return id;
    }),
    getWorld: vi.fn(async (id: UUID) => worlds.get(id) || null),
    removeWorld: vi.fn(async (id: UUID) => {
      worlds.delete(id);
    }),
    getAllWorlds: vi.fn(async () => Array.from(worlds.values())),
    updateWorld: vi.fn(async (world: World) => {
      if (world.id) {
        worlds.set(world.id, world);
      }
    }),

    createRelationship: vi.fn().mockResolvedValue(true),
    updateRelationship: vi.fn().mockResolvedValue(undefined),
    getRelationship: vi.fn().mockResolvedValue(null),
    getRelationships: vi.fn().mockResolvedValue([]),

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
      const id = task.id || createUUID();
      tasks.set(id, { ...task, id });
      return id;
    }),
    getTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(async (id: UUID) => tasks.get(id) || null),
    getTasksByName: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn(async (id: UUID) => {
      tasks.delete(id);
    }),

    log: vi.fn().mockResolvedValue(undefined),
    getLogs: vi.fn().mockResolvedValue([]),
    deleteLog: vi.fn().mockResolvedValue(undefined),
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
        messageServerId: "test-server-id" as UUID,
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
    messageServerId: createUUID(),
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
        messageServerId: "test-server-id" as UUID,
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
export async function cleanupTestRuntime(runtime: IAgentRuntime): Promise<void> {
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

/**
 * Sets up spies on the logger to suppress console output during tests.
 * Call this in beforeAll() to silence logger output.
 */
export function setupLoggerSpies(): void {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
}

/**
 * Test fixtures for common testing scenarios
 */
export const testFixtures = {
  agentId: "test-agent-id" as UUID,
  roomId: "test-room-id" as UUID,
  entityId: "test-entity-id" as UUID,
  worldId: "test-world-id" as UUID,
  serverId: "test-server-id" as UUID,
  userId: "test-user-id" as UUID,
  character: DEFAULT_TEST_CHARACTER,
  timestamp: Date.now(),
  messagePayload: (overrides?: { content?: Partial<Content>; runtime?: IAgentRuntime }) => ({
    runtime: overrides?.runtime || ({} as IAgentRuntime), // Will be set per-test
    message: createTestMemory(overrides?.content ? { content: overrides.content as Content } : {}),
    state: createTestState(),
    source: "test",
    channel: ChannelType.GROUP,
  }),
};
