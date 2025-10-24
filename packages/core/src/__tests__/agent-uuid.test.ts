import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { AgentRuntime } from '../runtime';
import type { Character, IDatabaseAdapter, UUID, Agent } from '../types';
import { v4 as uuidv4 } from 'uuid';

const stringToUuid = (id: string): UUID => id as UUID;

/**
 * Test suite to verify agent UUID identification behavior.
 * - Agents are uniquely identified by UUID
 * - Multiple agents with the same name are allowed when they have explicit different UUIDs
 * - For backward compatibility, agents without explicit IDs get deterministic UUIDs from their names
 */
describe('Agent UUID Identification', () => {
  let mockAdapter: IDatabaseAdapter;
  let adapterReady = false;
  const agentStore = new Map<UUID, Agent>();

  beforeEach(() => {
    mock.restore();
    adapterReady = false;
    agentStore.clear();

    // Create a mock adapter that stores agents by UUID
    mockAdapter = {
      db: {},
      init: mock().mockImplementation(async () => {
        adapterReady = true;
      }),
      initialize: mock().mockResolvedValue(undefined),
      runMigrations: mock().mockResolvedValue(undefined),
      isReady: mock().mockImplementation(async () => adapterReady),
      close: mock().mockImplementation(async () => {
        adapterReady = false;
      }),
      getConnection: mock().mockResolvedValue({}),
      getAgent: mock().mockImplementation(async (agentId: UUID) => {
        return agentStore.get(agentId) || null;
      }),
      getAgents: mock().mockImplementation(async () => {
        return Array.from(agentStore.values());
      }),
      createAgent: mock().mockImplementation(async (agent: Partial<Agent>) => {
        if (!agent.id) return false;
        const fullAgent: Agent = {
          id: agent.id,
          name: agent.name || 'Unknown',
          username: agent.username,
          bio: agent.bio || 'An AI agent',
          createdAt: agent.createdAt || Date.now(),
          updatedAt: agent.updatedAt || Date.now(),
        };
        agentStore.set(agent.id, fullAgent);
        return true;
      }),
      updateAgent: mock().mockImplementation(async (agentId: UUID, updates: Partial<Agent>) => {
        const existing = agentStore.get(agentId);
        if (!existing) return false;
        agentStore.set(agentId, { ...existing, ...updates, updatedAt: Date.now() });
        return true;
      }),
      deleteAgent: mock().mockImplementation(async (agentId: UUID) => {
        return agentStore.delete(agentId);
      }),
      ensureEmbeddingDimension: mock().mockResolvedValue(undefined),
      getEntitiesByIds: mock().mockImplementation(async (entityIds: UUID[]) => {
        // Return entities for the requested IDs
        return entityIds.map((id) => ({
          id,
          agentId: id,
          names: ['Test Entity'],
          metadata: {},
        }));
      }),
      createEntities: mock().mockResolvedValue(true),
      getMemories: mock().mockResolvedValue([]),
      getMemoryById: mock().mockResolvedValue(null),
      getMemoriesByRoomIds: mock().mockResolvedValue([]),
      getMemoriesByIds: mock().mockResolvedValue([]),
      getCachedEmbeddings: mock().mockResolvedValue([]),
      log: mock().mockResolvedValue(undefined),
      searchMemories: mock().mockResolvedValue([]),
      createMemory: mock().mockResolvedValue(stringToUuid(uuidv4())),
      deleteMemory: mock().mockResolvedValue(undefined),
      deleteManyMemories: mock().mockResolvedValue(undefined),
      deleteAllMemories: mock().mockResolvedValue(undefined),
      countMemories: mock().mockResolvedValue(0),
      getRoomsByIds: mock().mockResolvedValue([]),
      createRooms: mock().mockResolvedValue([stringToUuid(uuidv4())]),
      deleteRoom: mock().mockResolvedValue(undefined),
      getRoomsForParticipant: mock().mockResolvedValue([]),
      getRoomsForParticipants: mock().mockResolvedValue([]),
      addParticipantsRoom: mock().mockResolvedValue(true),
      removeParticipant: mock().mockResolvedValue(true),
      getParticipantsForEntity: mock().mockResolvedValue([]),
      getParticipantsForRoom: mock().mockResolvedValue([]),
      getParticipantUserState: mock().mockResolvedValue(null),
      setParticipantUserState: mock().mockResolvedValue(undefined),
      createRelationship: mock().mockResolvedValue(true),
      getRelationship: mock().mockResolvedValue(null),
      getRelationships: mock().mockResolvedValue([]),
      getEntitiesForRoom: mock().mockResolvedValue([]),
      updateEntity: mock().mockResolvedValue(undefined),
      getComponent: mock().mockResolvedValue(null),
      getComponents: mock().mockResolvedValue([]),
      createComponent: mock().mockResolvedValue(true),
      updateComponent: mock().mockResolvedValue(undefined),
      deleteComponent: mock().mockResolvedValue(undefined),
      createWorld: mock().mockResolvedValue(stringToUuid(uuidv4())),
      getWorld: mock().mockResolvedValue(null),
      getAllWorlds: mock().mockResolvedValue([]),
      updateWorld: mock().mockResolvedValue(undefined),
      updateRoom: mock().mockResolvedValue(undefined),
      getRoomsByWorld: mock().mockResolvedValue([]),
      updateRelationship: mock().mockResolvedValue(undefined),
      getCache: mock().mockResolvedValue(undefined),
      setCache: mock().mockResolvedValue(true),
      deleteCache: mock().mockResolvedValue(true),
      createTask: mock().mockResolvedValue(stringToUuid(uuidv4())),
      getTasks: mock().mockResolvedValue([]),
      getTask: mock().mockResolvedValue(null),
      getTasksByName: mock().mockResolvedValue([]),
      updateTask: mock().mockResolvedValue(undefined),
      deleteTask: mock().mockResolvedValue(undefined),
      updateMemory: mock().mockResolvedValue(true),
      getLogs: mock().mockResolvedValue([]),
      deleteLog: mock().mockResolvedValue(undefined),
      removeWorld: mock().mockResolvedValue(undefined),
      deleteRoomsByWorldId: mock().mockResolvedValue(undefined),
      getMemoriesByWorldId: mock().mockResolvedValue([]),
    } as IDatabaseAdapter;
  });

  it('should allow multiple agents with the same name but different UUIDs', async () => {
    const sharedName = 'TestAgent';
    const agentId1 = stringToUuid(uuidv4());
    const agentId2 = stringToUuid(uuidv4());

    // Create first agent
    const character1: Character = {
      id: agentId1,
      name: sharedName,
      bio: ['First agent with this name'],
    };

    const runtime1 = new AgentRuntime({
      character: character1,
      adapter: mockAdapter,
    });

    await runtime1.initialize();

    // Create second agent with same name but different ID
    const character2: Character = {
      id: agentId2,
      name: sharedName,
      bio: ['Second agent with this name'],
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

  it('should generate deterministic UUIDs from character names for backward compatibility', async () => {
    const sharedName = 'TestAgent';

    // Simulate what happens when a character without ID is processed
    const character1: Character = {
      name: sharedName,
      bio: ['First agent'],
    };

    const character2: Character = {
      name: sharedName,
      bio: ['Second agent'],
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

    // Verify same UUIDs were generated for same name (backward compatibility)
    expect(runtime1.agentId).toBe(runtime2.agentId);

    await runtime1.initialize();

    // Second runtime will update the existing agent since it has the same ID
    await runtime2.initialize();

    // Verify only one agent exists (same ID means same agent)
    const allAgents = await mockAdapter.getAgents();
    expect(allAgents).toHaveLength(1);
    expect(allAgents[0].name).toBe(sharedName);
  });

  it('should use character ID if provided, ignoring name-based generation', async () => {
    const explicitId = stringToUuid(uuidv4());
    const character: Character = {
      id: explicitId,
      name: 'TestAgent',
      bio: ['Agent with explicit ID'],
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

  it('should update agent by UUID, not by name', async () => {
    const agentId = stringToUuid(uuidv4());
    const initialName = 'OriginalName';
    const updatedName = 'UpdatedName';

    // Create agent with initial name
    const character: Character = {
      id: agentId,
      name: initialName,
      bio: ['Initial bio'],
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

  it('should allow creating multiple agents with same name via ensureAgentExists', async () => {
    const sharedName = 'SharedName';
    const agentId1 = stringToUuid(uuidv4());
    const agentId2 = stringToUuid(uuidv4());

    const runtime1 = new AgentRuntime({
      agentId: agentId1,
      character: { name: sharedName, bio: ['First'] } as Character,
      adapter: mockAdapter,
    });

    const runtime2 = new AgentRuntime({
      agentId: agentId2,
      character: { name: sharedName, bio: ['Second'] } as Character,
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
