import { v4 as uuidv4 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import type { Agent, Character, IDatabaseAdapter, UUID } from "../types";

const stringToUuid = (id: string): UUID => id as UUID;

const baseCharacterDefaults = {
  templates: {},
  messageExamples: [],
  postExamples: [],
  topics: [],
  adjectives: [],
  knowledge: [],
  plugins: [],
  secrets: {},
} as const;

/**
 * Test suite to verify agent UUID identification behavior.
 * - Agents are uniquely identified by UUID
 * - Multiple agents with the same name are allowed when they have explicit different UUIDs
 * - Agents without explicit IDs get deterministic UUIDs from their names
 */
describe("Agent UUID Identification", () => {
  let mockAdapter: IDatabaseAdapter;
  let adapterReady = false;
  const agentStore = new Map<UUID, Agent>();

  beforeEach(() => {
    vi.clearAllMocks();
    adapterReady = false;
    agentStore.clear();

    // Create a mock adapter that stores agents by UUID
    mockAdapter = {
      db: {},
      init: vi.fn().mockImplementation(async () => {
        adapterReady = true;
      }),
      initialize: vi.fn().mockResolvedValue(undefined),
      runMigrations: vi.fn().mockResolvedValue(undefined),
      isReady: vi.fn().mockImplementation(async () => adapterReady),
      close: vi.fn().mockImplementation(async () => {
        adapterReady = false;
      }),
      getConnection: vi.fn().mockResolvedValue({}),
      getAgent: vi.fn().mockImplementation(async (agentId: UUID) => {
        return agentStore.get(agentId) || null;
      }),
      getAgents: vi.fn().mockImplementation(async () => {
        return Array.from(agentStore.values());
      }),
      createAgent: vi.fn().mockImplementation(async (agent: Partial<Agent>) => {
        if (!agent.id) return false;
        const rawBio = agent.bio;
        const normalizedBio = Array.isArray(rawBio)
          ? rawBio
          : [rawBio ?? "An AI agent"];
        const fullAgent: Agent = {
          ...baseCharacterDefaults,
          id: agent.id,
          name: agent.name || "Unknown",
          username: agent.username,
          bio: normalizedBio,
          createdAt: agent.createdAt || Date.now(),
          updatedAt: agent.updatedAt || Date.now(),
        };
        agentStore.set(agent.id, fullAgent);
        return true;
      }),
      updateAgent: vi
        .fn()
        .mockImplementation(async (agentId: UUID, updates: Partial<Agent>) => {
          const existing = agentStore.get(agentId);
          if (!existing) return false;
          agentStore.set(agentId, {
            ...existing,
            ...updates,
            updatedAt: Date.now(),
          });
          return true;
        }),
      deleteAgent: vi.fn().mockImplementation(async (agentId: UUID) => {
        return agentStore.delete(agentId);
      }),
      ensureEmbeddingDimension: vi.fn().mockResolvedValue(undefined),
      getEntitiesByIds: vi
        .fn()
        .mockImplementation(async (entityIds: UUID[]) => {
          // Return entities for the requested IDs
          return entityIds.map((id) => ({
            id,
            agentId: id,
            names: ["Test Entity"],
            metadata: {},
          }));
        }),
      createEntities: vi.fn().mockResolvedValue(true),
      getMemories: vi.fn().mockResolvedValue([]),
      getMemoryById: vi.fn().mockResolvedValue(null),
      getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
      getMemoriesByIds: vi.fn().mockResolvedValue([]),
      getCachedEmbeddings: vi.fn().mockResolvedValue([]),
      log: vi.fn().mockResolvedValue(undefined),
      searchMemories: vi.fn().mockResolvedValue([]),
      createMemory: vi.fn().mockResolvedValue(stringToUuid(uuidv4())),
      deleteMemory: vi.fn().mockResolvedValue(undefined),
      deleteManyMemories: vi.fn().mockResolvedValue(undefined),
      deleteAllMemories: vi.fn().mockResolvedValue(undefined),
      countMemories: vi.fn().mockResolvedValue(0),
      getRoomsByIds: vi.fn().mockResolvedValue([]),
      createRooms: vi.fn().mockResolvedValue([stringToUuid(uuidv4())]),
      deleteRoom: vi.fn().mockResolvedValue(undefined),
      getRoomsForParticipant: vi.fn().mockResolvedValue([]),
      getRoomsForParticipants: vi.fn().mockResolvedValue([]),
      addParticipantsRoom: vi.fn().mockResolvedValue(true),
      removeParticipant: vi.fn().mockResolvedValue(true),
      getParticipantsForEntity: vi.fn().mockResolvedValue([]),
      getParticipantsForRoom: vi.fn().mockResolvedValue([]),
      getParticipantUserState: vi.fn().mockResolvedValue(null),
      setParticipantUserState: vi.fn().mockResolvedValue(undefined),
      createRelationship: vi.fn().mockResolvedValue(true),
      getRelationship: vi.fn().mockResolvedValue(null),
      getRelationships: vi.fn().mockResolvedValue([]),
      getEntitiesForRoom: vi.fn().mockResolvedValue([]),
      updateEntity: vi.fn().mockResolvedValue(undefined),
      getComponent: vi.fn().mockResolvedValue(null),
      getComponents: vi.fn().mockResolvedValue([]),
      createComponent: vi.fn().mockResolvedValue(true),
      updateComponent: vi.fn().mockResolvedValue(undefined),
      deleteComponent: vi.fn().mockResolvedValue(undefined),
      createWorld: vi.fn().mockResolvedValue(stringToUuid(uuidv4())),
      getWorld: vi.fn().mockResolvedValue(null),
      getAllWorlds: vi.fn().mockResolvedValue([]),
      updateWorld: vi.fn().mockResolvedValue(undefined),
      updateRoom: vi.fn().mockResolvedValue(undefined),
      getRoomsByWorld: vi.fn().mockResolvedValue([]),
      updateRelationship: vi.fn().mockResolvedValue(undefined),
      getCache: vi.fn().mockResolvedValue(undefined),
      setCache: vi.fn().mockResolvedValue(true),
      deleteCache: vi.fn().mockResolvedValue(true),
      createTask: vi.fn().mockResolvedValue(stringToUuid(uuidv4())),
      getTasks: vi.fn().mockResolvedValue([]),
      getTask: vi.fn().mockResolvedValue(null),
      getTasksByName: vi.fn().mockResolvedValue([]),
      updateTask: vi.fn().mockResolvedValue(undefined),
      deleteTask: vi.fn().mockResolvedValue(undefined),
      updateMemory: vi.fn().mockResolvedValue(true),
      getLogs: vi.fn().mockResolvedValue([]),
      deleteLog: vi.fn().mockResolvedValue(undefined),
      removeWorld: vi.fn().mockResolvedValue(undefined),
      deleteRoomsByWorldId: vi.fn().mockResolvedValue(undefined),
      getMemoriesByWorldId: vi.fn().mockResolvedValue([]),
    } as IDatabaseAdapter;
  });

  it("should allow multiple agents with the same name but different UUIDs", async () => {
    const sharedName = "TestAgent";
    const agentId1 = stringToUuid(uuidv4());
    const agentId2 = stringToUuid(uuidv4());

    // Create first agent
    const character1: Character = {
      ...baseCharacterDefaults,
      id: agentId1,
      name: sharedName,
      bio: ["First agent with this name"],
    };

    const runtime1 = new AgentRuntime({
      character: character1,
      adapter: mockAdapter,
    });

    await runtime1.initialize();

    // Create second agent with same name but different ID
    const character2: Character = {
      ...baseCharacterDefaults,
      id: agentId2,
      name: sharedName,
      bio: ["Second agent with this name"],
    };

    const runtime2 = new AgentRuntime({
      character: character2,
      adapter: mockAdapter,
    });

    await runtime2.initialize();

    // Verify both agents exist in the store
    const allAgents = await mockAdapter.getAgents();
    expect(allAgents).toHaveLength(2);

    // Verify they have different IDs
    const ids = allAgents.map((a) => a.id);
    expect(ids).toContain(agentId1);
    expect(ids).toContain(agentId2);
    expect(ids[0]).not.toBe(ids[1]);

    // Verify they have the same name
    const names = allAgents.map((a) => a.name);
    expect(names[0]).toBe(sharedName);
    expect(names[1]).toBe(sharedName);

    // Verify we can retrieve each agent by their unique ID
    const agent1 = await mockAdapter.getAgent(agentId1);
    const agent2 = await mockAdapter.getAgent(agentId2);

    expect(agent1).toBeTruthy();
    expect(agent2).toBeTruthy();
    expect(agent1?.id).toBe(agentId1);
    expect(agent2?.id).toBe(agentId2);
    expect(agent1?.name).toBe(sharedName);
    expect(agent2?.name).toBe(sharedName);
  });

  it("should generate deterministic UUIDs from character names", async () => {
    const sharedName = "TestAgent";

    // Simulate what happens when a character without ID is processed
    const character1: Character = {
      ...baseCharacterDefaults,
      name: sharedName,
      bio: ["First agent"],
    };

    const character2: Character = {
      ...baseCharacterDefaults,
      name: sharedName,
      bio: ["Second agent"],
    };

    // Create runtimes - constructor should generate deterministic UUIDs from name
    const runtime1 = new AgentRuntime({
      character: character1,
      adapter: mockAdapter,
    });

    const runtime2 = new AgentRuntime({
      character: character2,
      adapter: mockAdapter,
    });

    // Verify same UUIDs were generated for same name
    expect(runtime1.agentId).toBe(runtime2.agentId);

    await runtime1.initialize();

    // Second runtime will update the existing agent since it has the same ID
    await runtime2.initialize();

    // Verify only one agent exists (same ID means same agent)
    const allAgents = await mockAdapter.getAgents();
    expect(allAgents).toHaveLength(1);
    expect(allAgents[0].name).toBe(sharedName);
  });

  it("should use character ID if provided, ignoring name-based generation", async () => {
    const explicitId = stringToUuid(uuidv4());
    const character: Character = {
      ...baseCharacterDefaults,
      id: explicitId,
      name: "TestAgent",
      bio: ["Agent with explicit ID"],
    };

    const runtime = new AgentRuntime({
      character,
      adapter: mockAdapter,
    });

    // Verify runtime uses the explicit ID
    expect(runtime.agentId).toBe(explicitId);

    await runtime.initialize();

    // Verify agent created with the explicit ID
    const agent = await mockAdapter.getAgent(explicitId);
    expect(agent).toBeTruthy();
    expect(agent?.id).toBe(explicitId);
  });

  it("should update agent by UUID, not by name", async () => {
    const agentId = stringToUuid(uuidv4());
    const initialName = "OriginalName";
    const updatedName = "UpdatedName";

    // Create agent with initial name
    const character: Character = {
      ...baseCharacterDefaults,
      id: agentId,
      name: initialName,
      bio: ["Initial bio"],
    };

    const runtime = new AgentRuntime({
      character,
      adapter: mockAdapter,
    });

    await runtime.initialize();

    // Update agent name
    await mockAdapter.updateAgent(agentId, { name: updatedName });

    // Verify agent still has same ID but updated name
    const agent = await mockAdapter.getAgent(agentId);
    expect(agent?.id).toBe(agentId);
    expect(agent?.name).toBe(updatedName);

    // Verify no duplicate was created
    const allAgents = await mockAdapter.getAgents();
    expect(allAgents).toHaveLength(1);
  });

  it("should allow creating multiple agents with same name via ensureAgentExists", async () => {
    const sharedName = "SharedName";
    const agentId1 = stringToUuid(uuidv4());
    const agentId2 = stringToUuid(uuidv4());

    const runtime1 = new AgentRuntime({
      agentId: agentId1,
      character: {
        ...baseCharacterDefaults,
        name: sharedName,
        bio: ["First"],
      },
      adapter: mockAdapter,
    });

    const runtime2 = new AgentRuntime({
      agentId: agentId2,
      character: {
        ...baseCharacterDefaults,
        name: sharedName,
        bio: ["Second"],
      },
      adapter: mockAdapter,
    });

    await runtime1.initialize();
    await runtime2.initialize();

    // Both should exist
    const agent1 = await mockAdapter.getAgent(agentId1);
    const agent2 = await mockAdapter.getAgent(agentId2);

    expect(agent1).toBeTruthy();
    expect(agent2).toBeTruthy();
    expect(agent1?.name).toBe(sharedName);
    expect(agent2?.name).toBe(sharedName);
    expect(agent1?.id).not.toBe(agent2?.id);

    const allAgents = await mockAdapter.getAgents();
    expect(allAgents).toHaveLength(2);
  });
});
