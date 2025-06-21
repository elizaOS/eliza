import { describe, expect, beforeEach, it, vi } from 'vitest';
import { AgentRuntime } from '../runtime';
import type { Character, IDatabaseAdapter, World, UUID, GetWorldsOptions } from '../types';

// Mock database adapter that implements getWorlds method
class MockWorldsAdapter implements Partial<IDatabaseAdapter> {
  private worlds: World[] = [
    {
      id: 'world-1' as UUID,
      name: 'Test World 1',
      agentId: 'agent-1' as UUID,
      serverId: 'server-1',
      metadata: {
        description: 'Test world description',
        createdAt: '2024-01-01T00:00:00Z',
        lastActivityAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
        roomCount: 5,
      },
    },
    {
      id: 'world-2' as UUID,
      name: 'Test World 2',
      agentId: 'agent-1' as UUID,
      serverId: 'server-2',
      metadata: {
        description: 'Another test world',
        createdAt: '2024-01-01T12:00:00Z',
        lastActivityAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1 hour ago
        roomCount: 3,
      },
    },
    {
      id: 'world-3' as UUID,
      name: 'Inactive World',
      agentId: 'agent-1' as UUID,
      serverId: 'server-1',
      metadata: {
        description: 'Inactive world',
        createdAt: '2023-12-01T00:00:00Z',
        lastActivityAt: '2023-12-01T01:00:00Z',
        roomCount: 0,
      },
    },
    {
      id: 'world-4' as UUID,
      name: 'Different Agent World',
      agentId: 'agent-2' as UUID,
      serverId: 'server-1',
      metadata: {
        description: 'World for different agent',
        createdAt: '2024-01-01T00:00:00Z',
        lastActivityAt: '2024-01-02T00:00:00Z',
        roomCount: 2,
      },
    },
  ];

  async getWorlds(params: {
    agentId: UUID;
    serverId?: string;
    name?: string;
    activeOnly?: boolean;
    limit?: number;
    offset?: number;
    orderBy?: string;
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

  // Required methods for IDatabaseAdapter interface
  db: any = {};
  async initialize(): Promise<void> {}
  async init(): Promise<void> {}
  async runMigrations(): Promise<void> {}
  async isReady(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
  async getConnection(): Promise<any> {
    return {};
  }
}

describe('getWorlds functionality', () => {
  let runtime: AgentRuntime;
  let mockAdapter: MockWorldsAdapter;
  let mockCharacter: Character;

  beforeEach(() => {
    mockAdapter = new MockWorldsAdapter();
    mockCharacter = {
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

    // Register the database adapter
    runtime.registerDatabaseAdapter(mockAdapter as IDatabaseAdapter);
  });

  describe('AgentRuntime.getWorlds()', () => {
    it('should return all worlds for agent without filters', async () => {
      const worlds = await runtime.getWorlds();

      expect(worlds).toHaveLength(3); // Only worlds for agent-1
      expect(worlds.map((w) => w.id)).toContain('world-1' as UUID);
      expect(worlds.map((w) => w.id)).toContain('world-2' as UUID);
      expect(worlds.map((w) => w.id)).toContain('world-3' as UUID);
      expect(worlds.map((w) => w.id)).not.toContain('world-4' as UUID);
    });

    it('should filter worlds by serverId', async () => {
      const worlds = await runtime.getWorlds({ serverId: 'server-1' });

      expect(worlds).toHaveLength(2);
      expect(worlds.map((w) => w.serverId)).toEqual(['server-1', 'server-1']);
    });

    it('should filter worlds by name (partial matching)', async () => {
      const worlds = await runtime.getWorlds({ name: 'Test' });

      expect(worlds).toHaveLength(2);
      expect(worlds.map((w) => w.name)).toEqual(['Test World 1', 'Test World 2']);
    });

    it('should filter active worlds only', async () => {
      const worlds = await runtime.getWorlds({ activeOnly: true });

      expect(worlds).toHaveLength(2); // Only worlds with recent activity
      expect(worlds.map((w) => w.id)).toContain('world-1' as UUID);
      expect(worlds.map((w) => w.id)).toContain('world-2' as UUID);
      expect(worlds.map((w) => w.id)).not.toContain('world-3' as UUID);
    });

    it('should apply pagination with limit and offset', async () => {
      const firstPage = await runtime.getWorlds({ limit: 2, offset: 0 });
      expect(firstPage).toHaveLength(2);

      const secondPage = await runtime.getWorlds({ limit: 2, offset: 2 });
      expect(secondPage).toHaveLength(1);
    });

    it('should sort worlds by name ascending', async () => {
      const worlds = await runtime.getWorlds({
        orderBy: 'name',
        orderDirection: 'asc',
      });

      expect(worlds[0].name).toBe('Inactive World');
      expect(worlds[1].name).toBe('Test World 1');
      expect(worlds[2].name).toBe('Test World 2');
    });

    it('should sort worlds by name descending', async () => {
      const worlds = await runtime.getWorlds({
        orderBy: 'name',
        orderDirection: 'desc',
      });

      expect(worlds[0].name).toBe('Test World 2');
      expect(worlds[1].name).toBe('Test World 1');
      expect(worlds[2].name).toBe('Inactive World');
    });

    it('should sort worlds by lastActivityAt descending', async () => {
      const worlds = await runtime.getWorlds({
        orderBy: 'lastActivityAt',
        orderDirection: 'desc',
      });

      expect(worlds[0].id).toBe('world-2' as UUID); // Most recent activity (1 hour ago)
      expect(worlds[1].id).toBe('world-1' as UUID); // Second most recent (2 hours ago)
      expect(worlds[2].id).toBe('world-3' as UUID); // Oldest activity
    });

    it('should combine multiple filters', async () => {
      const worlds = await runtime.getWorlds({
        serverId: 'server-1',
        activeOnly: true,
        orderBy: 'lastActivityAt',
        orderDirection: 'desc',
        limit: 1,
      });

      expect(worlds).toHaveLength(1);
      expect(worlds[0].id).toBe('world-1' as UUID);
      expect(worlds[0].serverId).toBe('server-1');
    });

    it('should handle empty results gracefully', async () => {
      const worlds = await runtime.getWorlds({
        serverId: 'nonexistent-server',
      });

      expect(worlds).toHaveLength(0);
    });

    it('should handle undefined optional parameters', async () => {
      const worlds = await runtime.getWorlds({});

      expect(worlds).toHaveLength(3);
    });
  });

  describe('GetWorldsOptions interface', () => {
    it('should accept all optional parameters', () => {
      const options: GetWorldsOptions = {
        serverId: 'test-server',
        name: 'test-name',
        activeOnly: true,
        limit: 10,
        offset: 0,
        orderBy: 'name',
        orderDirection: 'asc',
      };

      expect(options.serverId).toBe('test-server');
      expect(options.name).toBe('test-name');
      expect(options.activeOnly).toBe(true);
      expect(options.limit).toBe(10);
      expect(options.offset).toBe(0);
      expect(options.orderBy).toBe('name');
      expect(options.orderDirection).toBe('asc');
    });

    it('should allow empty options object', () => {
      const options: GetWorldsOptions = {};

      expect(Object.keys(options)).toHaveLength(0);
    });
  });

  describe('World interface enhancements', () => {
    it('should support enhanced World metadata fields', async () => {
      const worlds = await runtime.getWorlds();
      const world = worlds[0];

      expect(world.metadata).toBeDefined();
      expect(world.metadata?.description).toBeDefined();
      expect(world.metadata?.createdAt).toBeDefined();
      expect(world.metadata?.lastActivityAt).toBeDefined();
      expect(world.metadata?.roomCount).toBeDefined();
    });
  });

  describe('Database adapter integration', () => {
    it('should call adapter.getWorlds with correct parameters', async () => {
      const getWorldsSpy = vi.spyOn(mockAdapter, 'getWorlds');

      const options: GetWorldsOptions = {
        serverId: 'test-server',
        limit: 5,
      };

      await runtime.getWorlds(options);

      expect(getWorldsSpy).toHaveBeenCalledWith({
        agentId: 'agent-1',
        serverId: 'test-server',
        limit: 5,
      });
    });

    it('should include agentId from runtime', async () => {
      const getWorldsSpy = vi.spyOn(mockAdapter, 'getWorlds');

      await runtime.getWorlds({});

      expect(getWorldsSpy).toHaveBeenCalledWith({
        agentId: 'agent-1',
      });
    });
  });
});
