import { describe, expect, beforeEach, it, vi } from 'vitest';
import { AgentRuntime } from '../runtime';
import { DatabaseAdapter } from '../database';
import type { Character, World, UUID } from '../types';

// Mock database adapter with getWorlds implementation
class TestDatabaseAdapter extends DatabaseAdapter {
  private worlds: World[] = [
    {
      id: 'world-1' as UUID,
      name: 'Production World',
      agentId: 'agent-1' as UUID,
      serverId: 'server-prod',
      metadata: {
        description: 'Production environment',
        createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days ago
        lastActivityAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1 hour ago
        roomCount: 25,
      },
    },
    {
      id: 'world-2' as UUID,
      name: 'Test World',
      agentId: 'agent-1' as UUID,
      serverId: 'server-test',
      metadata: {
        description: 'Testing environment',
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
        lastActivityAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 minutes ago
        roomCount: 5,
      },
    },
    {
      id: 'world-3' as UUID,
      name: 'Archive World',
      agentId: 'agent-1' as UUID,
      serverId: 'server-archive',
      metadata: {
        description: 'Archived data',
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
        lastActivityAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days ago (inactive)
        roomCount: 0,
      },
    },
  ];

  // Required abstract method implementations
  async init(): Promise<void> {}
  async initialize(): Promise<void> {}
  async runMigrations(): Promise<void> {}
  async isReady(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
  async getConnection(): Promise<any> {
    return {};
  }

  // getWorlds implementation
  async getWorlds(params: {
    agentId: UUID;
    serverId?: string;
    name?: string;
    activeOnly?: boolean;
    limit?: number;
    offset?: number;
    orderBy?: 'name' | 'createdAt' | 'lastActivityAt';
    orderDirection?: 'asc' | 'desc';
  }): Promise<World[]> {
    let filteredWorlds = this.worlds.filter((world) => world.agentId === params.agentId);

    // Apply serverId filter
    if (params.serverId) {
      filteredWorlds = filteredWorlds.filter((world) => world.serverId === params.serverId);
    }

    // Apply name filter (partial matching)
    if (params.name) {
      filteredWorlds = filteredWorlds.filter((world) =>
        world.name?.toLowerCase().includes(params.name!.toLowerCase())
      );
    }

    // Apply activeOnly filter (worlds with activity in last 24 hours)
    if (params.activeOnly) {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      filteredWorlds = filteredWorlds.filter((world) => {
        const lastActivity = world.metadata?.lastActivityAt;
        return lastActivity && new Date(lastActivity) > oneDayAgo;
      });
    }

    // Apply sorting
    if (params.orderBy) {
      filteredWorlds.sort((a, b) => {
        let aValue: any, bValue: any;

        switch (params.orderBy) {
          case 'name':
            aValue = a.name || '';
            bValue = b.name || '';
            break;
          case 'createdAt':
            aValue = a.metadata?.createdAt || '1970-01-01T00:00:00Z';
            bValue = b.metadata?.createdAt || '1970-01-01T00:00:00Z';
            break;
          case 'lastActivityAt':
            aValue = a.metadata?.lastActivityAt || '1970-01-01T00:00:00Z';
            bValue = b.metadata?.lastActivityAt || '1970-01-01T00:00:00Z';
            break;
          default:
            return 0;
        }

        const comparison = aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
        return params.orderDirection === 'desc' ? -comparison : comparison;
      });
    }

    // Apply pagination
    const offset = params.offset || 0;
    const limit = params.limit || filteredWorlds.length;

    return filteredWorlds.slice(offset, offset + limit);
  }

  // Required stub implementations (not used in this test)
  getAllWorlds = vi.fn();
  getAgent = vi.fn();
  getAgents = vi.fn();
  createAgent = vi.fn();
  updateAgent = vi.fn();
  deleteAgent = vi.fn();
  ensureEmbeddingDimension = vi.fn();
  getEntityByIds = vi.fn();
  getEntitiesForRoom = vi.fn();
  createEntities = vi.fn();
  updateEntity = vi.fn();
  getComponent = vi.fn();
  getComponents = vi.fn();
  createComponent = vi.fn();
  updateComponent = vi.fn();
  deleteComponent = vi.fn();
  getMemories = vi.fn();
  getMemoryById = vi.fn();
  getMemoriesByIds = vi.fn();
  getMemoriesByRoomIds = vi.fn();
  getCachedEmbeddings = vi.fn();
  log = vi.fn();
  getLogs = vi.fn();
  deleteLog = vi.fn();
  searchMemories = vi.fn();
  createMemory = vi.fn();
  updateMemory = vi.fn();
  deleteMemory = vi.fn();
  deleteManyMemories = vi.fn();
  deleteAllMemories = vi.fn();
  countMemories = vi.fn();
  createWorld = vi.fn();
  getWorld = vi.fn();
  removeWorld = vi.fn();
  updateWorld = vi.fn();
  getRoomsByIds = vi.fn();
  createRooms = vi.fn();
  deleteRoom = vi.fn();
  deleteRoomsByWorldId = vi.fn();
  updateRoom = vi.fn();
  getRoomsForParticipant = vi.fn();
  getRoomsForParticipants = vi.fn();
  getRoomsByWorld = vi.fn();
  removeParticipant = vi.fn();
  getParticipantsForEntity = vi.fn();
  getParticipantsForRoom = vi.fn();
  addParticipantsRoom = vi.fn();
  getParticipantUserState = vi.fn();
  setParticipantUserState = vi.fn();
  createRelationship = vi.fn();
  updateRelationship = vi.fn();
  getRelationship = vi.fn();
  getRelationships = vi.fn();
  getCache = vi.fn();
  setCache = vi.fn();
  deleteCache = vi.fn();
  createTask = vi.fn();
  getTasks = vi.fn();
  getTask = vi.fn();
  getTasksByName = vi.fn();
  updateTask = vi.fn();
  deleteTask = vi.fn();
  getMemoriesByWorldId = vi.fn();
}

describe('End-to-End getWorlds API test', () => {
  let runtime: AgentRuntime;
  let adapter: TestDatabaseAdapter;

  beforeEach(() => {
    adapter = new TestDatabaseAdapter();

    const mockCharacter: Character = {
      id: 'agent-1' as UUID,
      name: 'Test Agent',
      clients: [],
      plugins: [],
      bio: [],
      lore: [],
      knowledge: [],
      messageExamples: [],
      postExamples: [],
      people: [],
      topics: [],
      adjectives: [],
      style: { all: [], chat: [], post: [] },
    };

    runtime = new AgentRuntime({
      character: mockCharacter,
      agentId: 'agent-1' as UUID,
    });

    runtime.registerDatabaseAdapter(adapter);
  });

  it('should demonstrate complete getWorlds workflow', async () => {
    // 1. Get all worlds for the agent
    const allWorlds = await runtime.getWorlds();
    expect(allWorlds).toHaveLength(3);
    expect(allWorlds.map((w) => w.name)).toContain('Production World');
    expect(allWorlds.map((w) => w.name)).toContain('Test World');
    expect(allWorlds.map((w) => w.name)).toContain('Archive World');

    // 2. Filter by server
    const prodWorlds = await runtime.getWorlds({ serverId: 'server-prod' });
    expect(prodWorlds).toHaveLength(1);
    expect(prodWorlds[0].name).toBe('Production World');

    // 3. Filter by name (partial matching)
    const testWorlds = await runtime.getWorlds({ name: 'Test' });
    expect(testWorlds).toHaveLength(1);
    expect(testWorlds[0].name).toBe('Test World');

    // 4. Get only active worlds (activity in last 24 hours)
    const activeWorlds = await runtime.getWorlds({ activeOnly: true });
    expect(activeWorlds).toHaveLength(2);
    expect(activeWorlds.map((w) => w.name)).not.toContain('Archive World');

    // 5. Test sorting by activity (most recent first)
    const sortedWorlds = await runtime.getWorlds({
      orderBy: 'lastActivityAt',
      orderDirection: 'desc',
    });
    expect(sortedWorlds[0].name).toBe('Test World'); // Most recent (30 min ago)
    expect(sortedWorlds[1].name).toBe('Production World'); // 1 hour ago
    expect(sortedWorlds[2].name).toBe('Archive World'); // 7 days ago

    // 6. Test pagination
    const firstPage = await runtime.getWorlds({ limit: 2, offset: 0 });
    expect(firstPage).toHaveLength(2);

    const secondPage = await runtime.getWorlds({ limit: 2, offset: 2 });
    expect(secondPage).toHaveLength(1);

    // 7. Combine multiple filters
    const combinedFilter = await runtime.getWorlds({
      activeOnly: true,
      orderBy: 'lastActivityAt',
      orderDirection: 'desc',
      limit: 1,
    });
    expect(combinedFilter).toHaveLength(1);
    expect(combinedFilter[0].name).toBe('Test World');
  });

  it('should pass agentId automatically', async () => {
    const getWorldsSpy = vi.spyOn(adapter, 'getWorlds');

    await runtime.getWorlds({ serverId: 'test-server' });

    expect(getWorldsSpy).toHaveBeenCalledWith({
      agentId: 'agent-1',
      serverId: 'test-server',
    });
  });

  it('should handle World metadata correctly', async () => {
    const worlds = await runtime.getWorlds();

    for (const world of worlds) {
      expect(world.id).toBeDefined();
      expect(world.agentId).toBe('agent-1' as UUID);
      expect(world.serverId).toBeDefined();
      expect(world.metadata).toBeDefined();
      expect(world.metadata?.description).toBeDefined();
      expect(world.metadata?.createdAt).toBeDefined();
      expect(world.metadata?.lastActivityAt).toBeDefined();
      expect(typeof world.metadata?.roomCount).toBe('number');
    }
  });

  it('should demonstrate real-world use cases', async () => {
    // Use case 1: Get worlds for a specific Discord server
    const discordWorlds = await runtime.getWorlds({
      serverId: 'server-prod',
      activeOnly: true,
    });
    expect(discordWorlds).toHaveLength(1);

    // Use case 2: Search for worlds by name
    const searchResults = await runtime.getWorlds({
      name: 'prod',
      limit: 5,
    });
    expect(searchResults.length).toBeGreaterThan(0);

    // Use case 3: Get recently active worlds for dashboard
    const dashboardWorlds = await runtime.getWorlds({
      activeOnly: true,
      orderBy: 'lastActivityAt',
      orderDirection: 'desc',
      limit: 10,
    });
    expect(dashboardWorlds.length).toBeGreaterThan(0);

    // Use case 4: Get world statistics
    const allWorlds = await runtime.getWorlds();
    const activeWorlds = await runtime.getWorlds({ activeOnly: true });

    const stats = {
      totalWorlds: allWorlds.length,
      activeWorlds: activeWorlds.length,
      totalRooms: allWorlds.reduce(
        (sum, world) =>
          sum + (typeof world.metadata?.roomCount === 'number' ? world.metadata.roomCount : 0),
        0
      ),
      averageRoomsPerWorld:
        allWorlds.length > 0
          ? allWorlds.reduce(
              (sum, world) =>
                sum +
                (typeof world.metadata?.roomCount === 'number' ? world.metadata.roomCount : 0),
              0
            ) / allWorlds.length
          : 0,
    };

    expect(stats.totalWorlds).toBe(3);
    expect(stats.activeWorlds).toBe(2);
    expect(stats.totalRooms).toBe(30); // 25 + 5 + 0
    expect(stats.averageRoomsPerWorld).toBe(10); // 30 / 3
  });
});
