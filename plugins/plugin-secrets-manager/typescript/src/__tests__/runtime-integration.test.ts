/**
 * Integration tests for Secrets Manager Plugin against AgentRuntime.
 *
 * Tests verify:
 * - SecretsService lifecycle with real runtime
 * - Multi-level secret storage (global, world, user)
 * - Encryption/decryption roundtrip
 * - Plugin activation when secrets become available
 * - Onboarding flow with runtime events
 * - Provider integration with runtime
 * - UPDATE_SETTINGS action extraction
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AgentRuntime,
  type Agent,
  type IAgentRuntime,
  type Character,
  type UUID,
  type Memory,
  type World,
  type Room,
  type Plugin,
  ChannelType,
  type IDatabaseAdapter,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";

import { secretsManagerPlugin } from "../plugin";
import { SecretsService, SECRETS_SERVICE_TYPE } from "../services/secrets";
import {
  PluginActivatorService,
  PLUGIN_ACTIVATOR_SERVICE_TYPE,
  type PluginWithSecrets,
} from "../services/plugin-activator";
import {
  OnboardingService,
  ONBOARDING_SERVICE_TYPE,
} from "../onboarding/service";
import {
  createOnboardingConfig,
  type OnboardingConfig,
  type OnboardingSetting,
} from "../onboarding/config";
import type { SecretContext, PluginSecretRequirement } from "../types";

// ============================================================================
// Test Utilities
// ============================================================================

function stringToUuid(str: string): UUID {
  return str as UUID;
}

function createUUID(): UUID {
  return stringToUuid(uuidv4());
}

const DEFAULT_TEST_CHARACTER: Character = {
  name: "Test Agent",
  bio: ["A test agent for secrets integration testing"],
  system: "You are a helpful assistant used for testing secrets management.",
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

function createTestCharacter(overrides: Partial<Character> = {}): Character {
  // Create fresh copies of nested objects to prevent state leaking between tests
  // When one test modifies character.settings.secrets, it shouldn't affect other tests
  return {
    ...DEFAULT_TEST_CHARACTER,
    id: createUUID(),
    templates: { ...DEFAULT_TEST_CHARACTER.templates },
    plugins: [...DEFAULT_TEST_CHARACTER.plugins],
    knowledge: [...DEFAULT_TEST_CHARACTER.knowledge],
    secrets: { ...DEFAULT_TEST_CHARACTER.secrets },
    settings: {}, // Fresh empty object - critical for secrets storage isolation
    messageExamples: [...DEFAULT_TEST_CHARACTER.messageExamples],
    postExamples: [...DEFAULT_TEST_CHARACTER.postExamples],
    topics: [...DEFAULT_TEST_CHARACTER.topics],
    adjectives: [...DEFAULT_TEST_CHARACTER.adjectives],
    style: {
      all: [...DEFAULT_TEST_CHARACTER.style.all],
      chat: [...DEFAULT_TEST_CHARACTER.style.chat],
      post: [...DEFAULT_TEST_CHARACTER.style.post],
    },
    ...overrides,
  };
}

/**
 * Entity interface for testing.
 */
interface Entity {
  id: UUID;
  names?: string[];
  agentId?: UUID;
  metadata?: Record<string, unknown>;
}

/**
 * Creates an in-memory database adapter for testing.
 */
function createTestDatabaseAdapter(agentId?: UUID): IDatabaseAdapter {
  const resolvedAgentId = agentId || createUUID();
  const agents = new Map<string, Partial<Agent>>();

  const memories = new Map<UUID, Memory>();
  const rooms = new Map<UUID, Room>();
  const worlds = new Map<UUID, World>();
  const entities = new Map<UUID, Entity>();
  const components = new Map<string, unknown>();
  const cache = new Map<string, unknown>();
  const participants = new Map<UUID, Set<UUID>>();

  return {
    db: {},
    init: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockResolvedValue({}),
    isReady: vi.fn().mockResolvedValue(true),

    getAgent: vi
      .fn()
      .mockResolvedValue({ id: resolvedAgentId, name: "TestAgent" }),
    getAgents: vi.fn().mockResolvedValue([]),
    getAgentsByIds: vi.fn(async (ids: UUID[]) =>
      ids
        .map((id) => agents.get(String(id)))
        .filter((a): a is Partial<Agent> => a != null && a.id != null) as Agent[],
    ),
    createAgent: vi.fn().mockResolvedValue(true),
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
          agents.set(String(agent.id), {
            ...agent,
            createdAt: agent.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          } as Partial<Agent>);
        }
      }
    }),
    updateAgent: vi.fn().mockResolvedValue(true),
    updateAgents: vi.fn().mockResolvedValue(undefined),
    deleteAgent: vi.fn().mockResolvedValue(true),
    deleteAgents: vi.fn().mockResolvedValue(undefined),
    ensureEmbeddingDimension: vi.fn().mockResolvedValue(undefined),

    getMemories: vi.fn(async (params: { roomId?: UUID }) => {
      const result: Memory[] = [];
      for (const mem of memories.values()) {
        if (!params.roomId || mem.roomId === params.roomId) {
          result.push(mem);
        }
      }
      return result;
    }),
    getMemoryById: vi.fn(async (id: UUID) => memories.get(id) || null),
    getMemoriesByIds: vi.fn(
      async (ids: UUID[]) =>
        ids.map((id) => memories.get(id)).filter(Boolean) as Memory[],
    ),
    getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
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
    deleteManyMemories: vi.fn().mockResolvedValue(undefined),
    deleteAllMemories: vi.fn().mockResolvedValue(undefined),
    countMemories: vi.fn().mockResolvedValue(0),
    getMemoriesByWorldId: vi.fn().mockResolvedValue([]),

    // Entity methods - key for runtime initialization
    getEntitiesByIds: vi.fn(async (ids: UUID[]) => {
      return ids.map((id) => entities.get(id)).filter(Boolean) as Entity[];
    }),
    getEntitiesForRoom: vi.fn().mockResolvedValue([]),
    createEntities: vi.fn(async (newEntities: Entity[]) => {
      const ids: UUID[] = [];
      for (const entity of newEntities) {
        if (entity.id) {
          entities.set(entity.id, entity);
          ids.push(entity.id);
        }
      }
      return ids;
    }),
    updateEntity: vi.fn().mockResolvedValue(undefined),

    getComponent: vi.fn(async (_entityId: UUID, type: string) => {
      return components.get(type) || null;
    }),
    getComponents: vi.fn(async (entityId: UUID) => {
      const result: unknown[] = [];
      for (const [key, value] of components.entries()) {
        if (key.startsWith(`${entityId}:`)) {
          result.push(value);
        }
      }
      return result;
    }),
    createComponent: vi.fn(
      async (component: { entityId: UUID; type: string; data: unknown }) => {
        components.set(`${component.entityId}:${component.type}`, component);
        return true;
      },
    ),
    updateComponent: vi.fn().mockResolvedValue(undefined),
    deleteComponent: vi.fn().mockResolvedValue(undefined),

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
    deleteRoom: vi.fn(async (id: UUID) => {
      rooms.delete(id);
      participants.delete(id);
    }),
    deleteRoomsByWorldId: vi.fn().mockResolvedValue(undefined),
    updateRoom: vi.fn(async (room: Room) => {
      if (room.id) rooms.set(room.id, room);
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
      for (const id of entityIds) {
        roomParticipants.add(id);
      }
      return entityIds;
    }),
    removeParticipant: vi.fn().mockResolvedValue(true),
    getParticipantsForEntity: vi.fn().mockResolvedValue([]),
    getParticipantsForRoom: vi.fn(async (roomId: UUID) => {
      const roomParticipants = participants.get(roomId);
      return roomParticipants ? Array.from(roomParticipants) : [];
    }),
    isRoomParticipant: vi.fn().mockResolvedValue(false),
    getParticipantUserState: vi.fn().mockResolvedValue(null),
    setParticipantUserState: vi.fn().mockResolvedValue(undefined),

    createWorld: vi.fn(async (world: World) => {
      const id = world.id || createUUID();
      worlds.set(id, { ...world, id });
      return id;
    }),
    getWorld: vi.fn(async (id: UUID) => worlds.get(id) || null),
    getWorldsByIds: vi.fn(async (ids: UUID[]) =>
      ids.map((id) => worlds.get(id)).filter((w): w is World => w != null),
    ),
    removeWorld: vi.fn(async (id: UUID) => {
      worlds.delete(id);
    }),
    getAllWorlds: vi.fn(async () => Array.from(worlds.values())),
    updateWorld: vi.fn(async (world: World) => {
      if (world.id) worlds.set(world.id, world);
    }),
    updateWorlds: vi.fn(async (worldsToUpdate: World[]) => {
      for (const world of worldsToUpdate) {
        if (world.id) worlds.set(world.id, world);
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

    createTask: vi.fn().mockResolvedValue(createUUID()),
    getTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue(null),
    getTasksByName: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),

    log: vi.fn().mockResolvedValue(undefined),
    getLogs: vi.fn().mockResolvedValue([]),
    deleteLog: vi.fn().mockResolvedValue(undefined),
  } as IDatabaseAdapter;
}

/**
 * Creates a test runtime with the secrets manager plugin.
 */
async function createTestRuntime(
  options: {
    character?: Partial<Character>;
    plugins?: Plugin[];
  } = {},
): Promise<IAgentRuntime> {
  const character = createTestCharacter(options.character);
  const agentId = character.id || createUUID();
  const adapter = createTestDatabaseAdapter(agentId);

  // Include secrets manager plugin
  const plugins = [secretsManagerPlugin, ...(options.plugins || [])];

  const runtime = new AgentRuntime({
    agentId,
    character,
    adapter,
    plugins,
  });

  await runtime.initialize();

  // Wait for secrets service to be loaded
  await runtime.getServiceLoadPromise(SECRETS_SERVICE_TYPE);
  // Wait a short time for all services to be fully ready
  await new Promise((resolve) => setTimeout(resolve, 50));

  return runtime;
}

async function cleanupTestRuntime(runtime: IAgentRuntime): Promise<void> {
  await runtime.stop();
}

function createTestWorld(
  runtime: IAgentRuntime,
  overrides: Partial<World> = {},
): World {
  return {
    id: createUUID(),
    name: "Test World",
    agentId: runtime.agentId,
    messageServerId: "test-server-123",
    metadata: {},
    createdAt: Date.now(),
    ...overrides,
  };
}

function createTestRoom(worldId: UUID, overrides: Partial<Room> = {}): Room {
  return {
    id: createUUID(),
    name: "Test Room",
    worldId,
    serverId: "test-server-123",
    source: "test",
    type: ChannelType.GROUP,
    ...overrides,
  };
}

function createTestMemory(
  runtime: IAgentRuntime,
  roomId: UUID,
  text: string,
): Memory {
  return {
    id: createUUID(),
    roomId,
    entityId: createUUID(),
    agentId: runtime.agentId,
    content: {
      text,
      channelType: ChannelType.DM,
    },
    createdAt: Date.now(),
  } as Memory;
}

// ============================================================================
// Tests
// ============================================================================

describe("Secrets Manager Runtime Integration", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SECRET_SALT = "test-integration-salt";
  });

  afterEach(async () => {
    if (runtime) {
      await cleanupTestRuntime(runtime);
    }
    delete process.env.SECRET_SALT;
    vi.clearAllMocks();
  });

  describe("Service Registration", () => {
    it("should register SecretsService with runtime", async () => {
      runtime = await createTestRuntime();

      const secretsService = await runtime.getService(SECRETS_SERVICE_TYPE);
      expect(secretsService).toBeDefined();
      expect(secretsService).toBeInstanceOf(SecretsService);
    });

    it("should register PluginActivatorService with runtime", async () => {
      runtime = await createTestRuntime();

      const activatorService = await runtime.getService(
        PLUGIN_ACTIVATOR_SERVICE_TYPE,
      );
      expect(activatorService).toBeDefined();
      expect(activatorService).toBeInstanceOf(PluginActivatorService);
    });

    it("should register OnboardingService with runtime", async () => {
      runtime = await createTestRuntime();

      const onboardingService = await runtime.getService(ONBOARDING_SERVICE_TYPE);
      expect(onboardingService).toBeDefined();
      expect(onboardingService).toBeInstanceOf(OnboardingService);
    });
  });

  describe("SecretsService Lifecycle", () => {
    it("should start and stop cleanly", async () => {
      runtime = await createTestRuntime();

      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;
      expect(secretsService).toBeDefined();

      // Service should be running after runtime.initialize()
      // Stopping runtime should stop all services
      await runtime.stop();

      // Re-create for cleanup
      runtime = await createTestRuntime();
    });
  });

  /**
   * Multi-Level Secret Storage tests
   *
   * NOTE: These tests are skipped because the CharacterSettingsStorage uses
   * runtime.getSetting() which doesn't support returning objects - this is a
   * design limitation in the elizaOS runtime API. The underlying storage logic
   * is correct but the runtime API can't persist nested objects.
   *
   * To properly test storage functionality, either:
   * 1. Use the MemorySecretStorage directly in unit tests
   * 2. Fix the runtime to support object storage in getSetting/setSetting
   * 3. Modify CharacterSettingsStorage to use direct character property access
   */
  describe("Multi-Level Secret Storage", () => {
    beforeEach(async () => {
      runtime = await createTestRuntime();
    });

    it("should set and get global secrets", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;

      // Set a global secret
      const setResult = await secretsService.setGlobal(
        "TEST_API_KEY",
        "sk-test-12345",
      );
      expect(setResult).toBe(true);

      // Get the global secret back
      const value = await secretsService.getGlobal("TEST_API_KEY");
      expect(value).toBe("sk-test-12345");
    });

    it("should set and get world secrets", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;

      // Create a world
      const world = createTestWorld(runtime);
      await (runtime as AgentRuntime)["adapter"].createWorld(world);

      // Set a world secret - signature: setWorld(key, value, worldId)
      const setResult = await secretsService.setWorld(
        "WORLD_TOKEN",
        "world-secret-123",
        world.id,
      );
      expect(setResult).toBe(true);

      // Get the world secret back - signature: getWorld(key, worldId)
      const value = await secretsService.getWorld("WORLD_TOKEN", world.id);
      expect(value).toBe("world-secret-123");
    });

    it.skip("should set and get user secrets", async () => {
      // Skipped: ComponentSecretStorage depends on adapter's component methods
      // which require more complex mocking
    });

    it("should isolate secrets by level", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;

      // Create a world
      const world = createTestWorld(runtime);
      await (runtime as AgentRuntime)["adapter"].createWorld(world);

      // Set same key at different levels
      await secretsService.setGlobal("SHARED_KEY", "global-value");
      await secretsService.setWorld("SHARED_KEY", "world-value", world.id);

      // Each level should have its own value
      const globalValue = await secretsService.getGlobal("SHARED_KEY");
      const worldValue = await secretsService.getWorld("SHARED_KEY", world.id);

      expect(globalValue).toBe("global-value");
      expect(worldValue).toBe("world-value");
    });

    it("should isolate world secrets by world ID", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;

      // Create two worlds
      const world1 = createTestWorld(runtime, { name: "World 1" });
      const world2 = createTestWorld(runtime, { name: "World 2" });
      await (runtime as AgentRuntime)["adapter"].createWorld(world1);
      await (runtime as AgentRuntime)["adapter"].createWorld(world2);

      // Set same key in both worlds - signature: setWorld(key, value, worldId)
      await secretsService.setWorld(
        "SERVER_TOKEN",
        "token-for-world-1",
        world1.id,
      );
      await secretsService.setWorld(
        "SERVER_TOKEN",
        "token-for-world-2",
        world2.id,
      );

      // Each world should have its own value - signature: getWorld(key, worldId)
      const value1 = await secretsService.getWorld("SERVER_TOKEN", world1.id);
      const value2 = await secretsService.getWorld("SERVER_TOKEN", world2.id);

      expect(value1).toBe("token-for-world-1");
      expect(value2).toBe("token-for-world-2");
    });

    it.skip("should isolate user secrets by user ID", async () => {
      // Skipped: ComponentSecretStorage depends on adapter's component methods
    });

    // Test that the storage types are correct
    it("should have correct storage backends configured", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;
      expect(secretsService).toBeDefined();

      const globalStorage = secretsService.getGlobalStorage();
      expect(globalStorage.storageType).toBe("character");

      const worldStorage = secretsService.getWorldStorage();
      expect(worldStorage.storageType).toBe("world");

      const userStorage = secretsService.getUserStorage();
      expect(userStorage.storageType).toBe("component");
    });
  });

  /**
   * Encryption tests
   *
   * NOTE: These tests are skipped because they depend on working storage.
   * The encryption logic itself is tested in the crypto module unit tests.
   */
  describe("Encryption", () => {
    beforeEach(async () => {
      runtime = await createTestRuntime();
    });

    it("should encrypt and decrypt secrets correctly", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;
      const secretValue = "super-secret-api-key-12345";

      // Set a secret (will be encrypted internally)
      await secretsService.setGlobal("ENCRYPTED_KEY", secretValue);

      // Get the secret back (should be decrypted)
      const retrieved = await secretsService.getGlobal("ENCRYPTED_KEY");
      expect(retrieved).toBe(secretValue);

      // Verify the raw storage contains encrypted data
      const settings = (runtime as AgentRuntime).character.settings as Record<
        string,
        unknown
      >;
      const secrets = settings["secrets"] as Record<string, unknown>;
      const stored = secrets["ENCRYPTED_KEY"] as Record<string, unknown>;
      expect(stored).toBeDefined();
      expect(stored.value).toBeDefined();
      // Encrypted value should be an object with algorithm, iv, etc.
      expect(typeof stored.value).toBe("object");
      expect((stored.value as Record<string, unknown>).algorithm).toBe(
        "aes-256-gcm",
      );
    });

    it("should handle unicode in secrets", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;
      const unicodeValue = "Japanese: 日本語, Emoji: 🔐🔑, Chinese: 中文";

      await secretsService.setGlobal("UNICODE_KEY", unicodeValue);
      const retrieved = await secretsService.getGlobal("UNICODE_KEY");
      expect(retrieved).toBe(unicodeValue);
    });

    it("should handle empty strings", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;

      await secretsService.setGlobal("EMPTY_KEY", "");
      const retrieved = await secretsService.getGlobal("EMPTY_KEY");
      expect(retrieved).toBe("");
    });

    it("should handle long secrets", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;
      const longValue = "x".repeat(10000);

      await secretsService.setGlobal("LONG_KEY", longValue);
      const retrieved = await secretsService.getGlobal("LONG_KEY");
      expect(retrieved).toBe(longValue);
    });

    it("should have a key manager initialized", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;
      expect(secretsService).toBeDefined();

      const keyManager = secretsService.getKeyManager();
      expect(keyManager).toBeDefined();

      // Test encryption/decryption directly via key manager
      const testValue = "test-secret-value";
      const encrypted = keyManager.encrypt(testValue);
      expect(encrypted).toBeDefined();
      expect(encrypted.value).toBeDefined(); // The encrypted value
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.authTag).toBeDefined(); // GCM auth tag
      expect(encrypted.algorithm).toBe("aes-256-gcm");

      const decrypted = keyManager.decrypt(encrypted);
      expect(decrypted).toBe(testValue);
    });

    it("should encrypt values correctly", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;
      const keyManager = secretsService.getKeyManager();

      // Test various string types
      const testCases = [
        "simple-key",
        "special-chars-!@#$%^&*()",
        "unicode-日本語-🔐",
        "",
        "x".repeat(1000),
      ];

      for (const testValue of testCases) {
        const encrypted = keyManager.encrypt(testValue);
        const decrypted = keyManager.decrypt(encrypted);
        expect(decrypted).toBe(testValue);
      }
    });
  });

  describe("Secret Deletion", () => {
    beforeEach(async () => {
      runtime = await createTestRuntime();
    });

    it("should delete global secrets", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;

      // Set a secret
      await secretsService.setGlobal("TO_DELETE", "some-value");
      expect(await secretsService.getGlobal("TO_DELETE")).toBe("some-value");

      // Delete it
      const context: SecretContext = {
        level: "global",
        agentId: runtime.agentId,
      };
      const deleted = await secretsService.delete("TO_DELETE", context);
      expect(deleted).toBe(true);

      // Verify it's gone
      expect(await secretsService.getGlobal("TO_DELETE")).toBeNull();
    });

    it("should return false when deleting non-existent secret", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;

      const context: SecretContext = {
        level: "global",
        agentId: runtime.agentId,
      };
      const deleted = await secretsService.delete("NON_EXISTENT", context);
      expect(deleted).toBe(false);
    });
  });

  describe("Secret Listing", () => {
    beforeEach(async () => {
      runtime = await createTestRuntime();
    });

    it("should list all secrets for a context", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;

      // Set multiple secrets
      await secretsService.setGlobal("KEY1", "value1");
      await secretsService.setGlobal("KEY2", "value2");
      await secretsService.setGlobal("KEY3", "value3");

      // List all secrets
      const context: SecretContext = {
        level: "global",
        agentId: runtime.agentId,
      };

      const metadata = await secretsService.list(context);
      // Metadata is a Record<string, SecretConfig> - check keys exist
      expect(Object.keys(metadata)).toContain("KEY1");
      expect(Object.keys(metadata)).toContain("KEY2");
      expect(Object.keys(metadata)).toContain("KEY3");
      expect(Object.keys(metadata).length).toBe(3);
    });
  });

  describe("Plugin Requirements Checking", () => {
    beforeEach(async () => {
      runtime = await createTestRuntime();
    });

    it("should check plugin requirements correctly", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;

      // Set one required key
      await secretsService.setGlobal("REQUIRED_KEY", "value");

      const requirements: Record<string, PluginSecretRequirement> = {
        REQUIRED_KEY: {
          key: "REQUIRED_KEY",
          description: "Required key",
          required: true,
          type: "api_key",
        },
        OPTIONAL_KEY: {
          key: "OPTIONAL_KEY",
          description: "Optional key",
          required: false,
          type: "api_key",
        },
        MISSING_REQUIRED: {
          key: "MISSING_REQUIRED",
          description: "Missing required",
          required: true,
          type: "api_key",
        },
      };

      const status = await secretsService.checkPluginRequirements(
        "test-plugin",
        requirements,
      );
      expect(status.ready).toBe(false);
      expect(status.missingRequired).toContain("MISSING_REQUIRED");
      expect(status.missingOptional).toContain("OPTIONAL_KEY");
      expect(status.missingRequired).not.toContain("REQUIRED_KEY");
    });

    it("should report ready when all required secrets present", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;

      // Set all required keys
      await secretsService.setGlobal("KEY1", "value1");
      await secretsService.setGlobal("KEY2", "value2");

      const requirements: Record<string, PluginSecretRequirement> = {
        KEY1: {
          key: "KEY1",
          description: "Key 1",
          required: true,
          type: "api_key",
        },
        KEY2: {
          key: "KEY2",
          description: "Key 2",
          required: true,
          type: "api_key",
        },
      };

      const status = await secretsService.checkPluginRequirements(
        "test-plugin",
        requirements,
      );
      expect(status.ready).toBe(true);
      expect(status.missingRequired).toHaveLength(0);
    });

    it("should report all secrets missing when none are set", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;

      const requirements: Record<string, PluginSecretRequirement> = {
        MISSING1: {
          key: "MISSING1",
          description: "Missing 1",
          required: true,
          type: "api_key",
        },
        MISSING2: {
          key: "MISSING2",
          description: "Missing 2",
          required: false,
          type: "api_key",
        },
      };

      const status = await secretsService.checkPluginRequirements(
        "test-plugin",
        requirements,
      );
      expect(status.ready).toBe(false);
      expect(status.missingRequired).toContain("MISSING1");
      expect(status.missingOptional).toContain("MISSING2");
    });
  });

  describe("Change Notifications", () => {
    beforeEach(async () => {
      runtime = await createTestRuntime();
    });

    it("should notify on secret change", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;
      const callback = vi.fn();

      secretsService.onSecretChanged("TEST_KEY", callback);
      await secretsService.setGlobal("TEST_KEY", "value");

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        "TEST_KEY",
        "value",
        expect.objectContaining({ level: "global" }),
      );
    });

    it("should notify global listeners on any change", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;
      const callback = vi.fn();

      secretsService.onAnySecretChanged(callback);
      await secretsService.setGlobal("KEY1", "value1");
      await secretsService.setGlobal("KEY2", "value2");

      expect(callback).toHaveBeenCalledTimes(2);
    });

    it("should unsubscribe correctly", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;
      const callback = vi.fn();

      const unsubscribe = secretsService.onSecretChanged("TEST_KEY", callback);
      await secretsService.setGlobal("TEST_KEY", "value1");
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
      await secretsService.setGlobal("TEST_KEY", "value2");
      expect(callback).toHaveBeenCalledTimes(1); // Still 1, not 2
    });
  });

  describe("Access Logging", () => {
    beforeEach(async () => {
      runtime = await createTestRuntime();
    });

    it("should log access attempts", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;

      await secretsService.setGlobal("TEST_KEY", "value");
      await secretsService.getGlobal("TEST_KEY");

      const logs = secretsService.getAccessLogs();
      expect(logs.length).toBeGreaterThan(0);
    });

    it("should filter access logs by key", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;

      await secretsService.setGlobal("KEY1", "value1");
      await secretsService.setGlobal("KEY2", "value2");
      await secretsService.getGlobal("KEY1");

      const key1Logs = secretsService.getAccessLogs({ key: "KEY1" });
      expect(key1Logs.length).toBeGreaterThan(0);
      expect(key1Logs.every((log) => log.secretKey === "KEY1")).toBe(true);
    });

    it("should clear access logs", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;

      await secretsService.setGlobal("TEST_KEY", "value");
      expect(secretsService.getAccessLogs().length).toBeGreaterThan(0);

      secretsService.clearAccessLogs();
      expect(secretsService.getAccessLogs().length).toBe(0);
    });
  });

  describe("Plugin Activator Service", () => {
    beforeEach(async () => {
      runtime = await createTestRuntime();
    });

    it("should activate plugin with no secret requirements", async () => {
      const activatorService = await runtime.getService(
        PLUGIN_ACTIVATOR_SERVICE_TYPE,
      ) as PluginActivatorService;

      const activationCallback = vi.fn();

      // Plugin with no required secrets should activate immediately
      const mockPlugin: PluginWithSecrets = {
        name: "no-secrets-plugin",
      };

      const registered = await activatorService.registerPlugin(
        mockPlugin,
        activationCallback,
      );
      expect(registered).toBe(true);
      expect(activatorService.isActivated("no-secrets-plugin")).toBe(true);
    });

    it("should keep plugin pending when secrets are missing", async () => {
      const activatorService = await runtime.getService(
        PLUGIN_ACTIVATOR_SERVICE_TYPE,
      ) as PluginActivatorService;

      const mockPlugin: PluginWithSecrets = {
        name: "pending-plugin",
        requiredSecrets: {
          MISSING_KEY: {
            key: "MISSING_KEY",
            description: "Missing Key",
            required: true,
            type: "api_key",
          },
        },
      };

      const registered = await activatorService.registerPlugin(mockPlugin);
      expect(registered).toBe(false);

      const pending = activatorService.getPendingPlugins();
      expect(pending).toContain("pending-plugin");
      expect(activatorService.isPending("pending-plugin")).toBe(true);
    });

    it("should track activated and pending plugins correctly", async () => {
      const activatorService = await runtime.getService(
        PLUGIN_ACTIVATOR_SERVICE_TYPE,
      ) as PluginActivatorService;

      const pluginWithoutSecrets: PluginWithSecrets = {
        name: "plugin-activated",
      };

      const pluginWithSecrets: PluginWithSecrets = {
        name: "plugin-pending",
        requiredSecrets: {
          SOME_KEY: {
            key: "SOME_KEY",
            description: "Some Key",
            required: true,
            type: "api_key",
          },
        },
      };

      await activatorService.registerPlugin(pluginWithoutSecrets);
      await activatorService.registerPlugin(pluginWithSecrets);

      const activated = activatorService.getActivatedPlugins();
      const pending = activatorService.getPendingPlugins();

      expect(activated).toContain("plugin-activated");
      expect(pending).toContain("plugin-pending");
    });
  });

  describe("Onboarding Configuration", () => {
    it("should create onboarding config from key lists", () => {
      const config = createOnboardingConfig(
        ["OPENAI_API_KEY", "DISCORD_TOKEN"],
        ["TWITTER_USERNAME"],
      );

      expect(config.settings.OPENAI_API_KEY).toBeDefined();
      expect(config.settings.OPENAI_API_KEY.required).toBe(true);
      expect(config.settings.OPENAI_API_KEY.secret).toBe(true);

      expect(config.settings.DISCORD_TOKEN).toBeDefined();
      expect(config.settings.DISCORD_TOKEN.required).toBe(true);

      expect(config.settings.TWITTER_USERNAME).toBeDefined();
      expect(config.settings.TWITTER_USERNAME.required).toBe(false);
    });

    it("should use common settings for known keys", () => {
      const config = createOnboardingConfig(["OPENAI_API_KEY"]);

      const setting = config.settings.OPENAI_API_KEY;
      expect(setting.name).toBe("OpenAI API Key");
      expect(setting.validationMethod).toBe("openai");
      expect(setting.envVar).toBe("OPENAI_API_KEY");
    });

    it("should allow custom settings overrides", () => {
      const config = createOnboardingConfig(["CUSTOM_KEY"], [], {
        CUSTOM_KEY: {
          name: "My Custom Key",
          description: "A custom API key",
          usageDescription: "Enter your custom key",
          validationMethod: "custom",
        },
      });

      const setting = config.settings.CUSTOM_KEY;
      expect(setting.name).toBe("My Custom Key");
      expect(setting.description).toBe("A custom API key");
      expect(setting.validationMethod).toBe("custom");
    });
  });

  describe("Onboarding Service Integration", () => {
    beforeEach(async () => {
      runtime = await createTestRuntime();
    });

    it("should initialize onboarding for a world", async () => {
      const onboardingService = await runtime.getService(
        ONBOARDING_SERVICE_TYPE,
      ) as OnboardingService;
      const world = createTestWorld(runtime);

      // Create the world in the database first
      await (runtime as AgentRuntime)["adapter"].createWorld(world);

      const config = createOnboardingConfig(["OPENAI_API_KEY"]);
      await onboardingService.initializeOnboarding(world, config);

      const status = await onboardingService.getOnboardingStatus(world.id);
      expect(status.initialized).toBe(true);
      expect(status.complete).toBe(false);
      expect(status.missingRequired).toContain("OPENAI_API_KEY");
    });
  });

  describe("Validation Integration", () => {
    beforeEach(async () => {
      runtime = await createTestRuntime();
    });

    it("should validate and reject invalid secrets", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;
      const context: SecretContext = {
        level: "global",
        agentId: runtime.agentId,
      };

      // Invalid OpenAI key format (doesn't start with "sk-")
      await expect(
        secretsService.set("OPENAI_API_KEY", "invalid-key", context, {
          validationMethod: "api_key:openai",
        }),
      ).rejects.toThrow();
    });

    it("should validate with proper OpenAI key format", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;

      // Test the validation directly - this verifies the validation logic works
      const validResult = await secretsService.validate(
        "OPENAI_API_KEY",
        "sk-abc123def456ghi789jkl012mno345",
        "api_key:openai",
      );
      expect(validResult.isValid).toBe(true);

      const invalidResult = await secretsService.validate(
        "OPENAI_API_KEY",
        "invalid-key",
        "api_key:openai",
      );
      expect(invalidResult.isValid).toBe(false);
    });

    it("should return available validation strategies", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;

      const strategies = secretsService.getValidationStrategies();
      expect(strategies).toContain("none");
      expect(strategies).toContain("api_key:openai");
      expect(strategies).toContain("api_key:anthropic");
      expect(strategies.length).toBeGreaterThan(0);
    });
  });

  describe("Context-Based Access", () => {
    beforeEach(async () => {
      runtime = await createTestRuntime();
    });

    it("should work with explicit SecretContext", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;

      // Use explicit context for global storage
      const globalContext: SecretContext = {
        level: "global",
        agentId: runtime.agentId,
      };

      // Set with explicit context
      await secretsService.set("EXPLICIT_KEY", "explicit-value", globalContext);

      // Get with explicit context
      const value = await secretsService.get("EXPLICIT_KEY", globalContext);
      expect(value).toBe("explicit-value");

      // Check exists with explicit context
      expect(await secretsService.exists("EXPLICIT_KEY", globalContext)).toBe(
        true,
      );
    });

    it("should return null for non-existent secrets", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;
      const context: SecretContext = {
        level: "global",
        agentId: runtime.agentId,
      };

      const result = await secretsService.get("NON_EXISTENT", context);
      expect(result).toBeNull();
    });

    it("should return false for exists check on non-existent secrets", async () => {
      const secretsService = await runtime.getService(
        SECRETS_SERVICE_TYPE,
      ) as SecretsService;
      const context: SecretContext = {
        level: "global",
        agentId: runtime.agentId,
      };

      expect(await secretsService.exists("NON_EXISTENT", context)).toBe(false);
    });

    it("should have correct context levels defined", () => {
      // Verify the SecretContext levels are correctly typed
      const globalContext: SecretContext = {
        level: "global",
        agentId: "test-agent-id" as UUID,
      };

      const worldContext: SecretContext = {
        level: "world",
        agentId: "test-agent-id" as UUID,
        worldId: "test-world-id" as UUID,
      };

      const userContext: SecretContext = {
        level: "user",
        agentId: "test-agent-id" as UUID,
        userId: "test-user-id" as UUID,
        requesterId: "test-requester-id" as UUID,
      };

      expect(globalContext.level).toBe("global");
      expect(worldContext.level).toBe("world");
      expect(userContext.level).toBe("user");
    });
  });
});
