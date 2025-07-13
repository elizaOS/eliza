import type { IDatabaseAdapter, UUID } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

/**
 * Test Database Manager - Creates isolated database instances for testing
 * Each test gets its own database to prevent interference and ensure isolation
 */
export class TestDatabaseManager {
  private testDatabases: Map<string, IDatabaseAdapter> = new Map();
  private tempPaths: Set<string> = new Set();

  /**
   * Creates an isolated database for testing
   * Uses PostgreSQL for testing when available, falls back to mock database
   */
  async createIsolatedDatabase(testId: string): Promise<IDatabaseAdapter> {
    try {
      logger.debug(`Creating isolated test database for ${testId}`);

      // Use dynamic import to avoid breaking if PostgreSQL not available
      let adapter: IDatabaseAdapter;

      try {
        // Try to use PostgreSQL for testing
        logger.debug(`Attempting to load PostgreSQL adapter for ${testId}`);

        // Try to use real database for proper testing, but fallback to mock if unavailable
        if (process.env.FORCE_MOCK_DB === 'true') {
          logger.warn('FORCE_MOCK_DB is set - using mock database');
          adapter = this.createMockDatabase(testId);
        } else {
          // Check if SQL plugin is available in the build
          try {
            // Don't import plugin-sql directly to avoid circular dependency
            // Instead, use global registration if available
            const sqlPlugin = (globalThis as any).__elizaOS_sqlPlugin;

            if (!sqlPlugin?.createDatabaseAdapter) {
              throw new Error('SQL plugin not available - falling back to mock database');
            }

            // Use PostgreSQL test database if available
            const postgresUrl = process.env.TEST_POSTGRES_URL || process.env.POSTGRES_URL;
            if (!postgresUrl) {
              throw new Error('PostgreSQL URL not available - falling back to mock database');
            }

            adapter = await sqlPlugin.createDatabaseAdapter(
              {
                postgresUrl,
              },
              '11111111-2222-3333-4444-555555555555' as UUID
            );

            logger.debug(`Successfully created PostgreSQL adapter for ${testId}`);
          } catch (importError) {
            logger.warn(
              `SQL plugin not available: ${importError instanceof Error ? importError.message : String(importError)} - falling back to mock database`
            );
            adapter = this.createMockDatabase(testId);
          }
        }
      } catch (postgresError) {
        logger.warn(
          `Failed to create PostgreSQL database: ${postgresError instanceof Error ? postgresError.message : String(postgresError)} - falling back to mock database`
        );

        // Fall back to mock database for basic testing
        adapter = this.createMockDatabase(testId);
      }

      // Initialize the database
      await adapter.init();

      // Store for cleanup
      this.testDatabases.set(testId, adapter);

      logger.debug(`Successfully created isolated database for ${testId}`);
      return adapter;
    } catch (error) {
      logger.error(
        `Failed to create test database for ${testId}: ${error instanceof Error ? error.message : String(error)}`
      );
      throw new Error(
        `Test database creation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Creates a minimal mock database adapter for testing when real database unavailable
   * This is a FUNCTIONAL mock that actually stores data in memory
   */
  private createMockDatabase(testId: string): IDatabaseAdapter {
    // In-memory storage for this test instance
    const storage = {
      agents: new Map(),
      entities: new Map(),
      memories: new Map(),
      relationships: new Map(),
      rooms: new Map(),
      participants: new Map(),
      cache: new Map(),
      worlds: new Map(),
      tasks: new Map(),
      logs: new Map(),
    };

    const adapter = {
      db: null, // Mock database instance

      async initialize() {
        logger.debug(`Initialized mock database for ${testId}`);
      },

      async init() {
        logger.debug(`Initialized mock database for ${testId}`);
      },

      async runMigrations() {
        // No-op for mock
      },

      async isReady() {
        return true;
      },

      async close() {
        storage.agents.clear();
        storage.entities.clear();
        storage.memories.clear();
        storage.relationships.clear();
        storage.rooms.clear();
        storage.participants.clear();
        storage.cache.clear();
        storage.worlds.clear();
        storage.tasks.clear();
      },

      async getConnection() {
        return null;
      },

      async ensureEmbeddingDimension() {
        // No-op for mock
      },

      async getAgent(agentId: any) {
        return storage.agents.get(agentId) || null;
      },

      async getAgents() {
        return Array.from(storage.agents.values());
      },

      async createAgent(agent: any) {
        const id = agent.id || uuidv4();
        const fullAgent = { ...agent, id };
        storage.agents.set(id, fullAgent);
        return true;
      },

      async updateAgent(agentId: any, agent: any) {
        if (storage.agents.has(agentId)) {
          storage.agents.set(agentId, { ...agent, id: agentId });
          return true;
        }
        return false;
      },

      async deleteAgent(agentId: any) {
        return storage.agents.delete(agentId);
      },

      // Entity operations
      async createEntity(entity: any) {
        const id = entity.id || uuidv4();
        const fullEntity = { ...entity, id };
        storage.entities.set(id, fullEntity);
        return fullEntity;
      },

      async createEntities(entities: any[]) {
        for (const entity of entities) {
          const id = entity.id || uuidv4();
          const fullEntity = { ...entity, id };
          storage.entities.set(id, fullEntity);
        }
        return true;
      },

      async getEntityById(id: any) {
        return storage.entities.get(id) || null;
      },

      async updateEntity(entity: any) {
        if (!entity.id || !storage.entities.has(entity.id)) {
          throw new Error('Entity not found');
        }
        storage.entities.set(entity.id, entity);
      },

      async getEntitiesForRoom(roomId: any) {
        const participants = Array.from(storage.participants.values()).filter(
          (p: any) => p.roomId === roomId
        );

        const entities = [];
        for (const participant of participants) {
          const entity = storage.entities.get(participant.entityId);
          if (entity) {
            entities.push(entity);
          }
        }
        return entities;
      },

      // Memory operations
      async createMemory(memory: any, tableName = 'messages', _unique = false) {
        const id = memory.id || uuidv4();
        const fullMemory = {
          ...memory,
          id,
          createdAt: memory.createdAt || Date.now(),
        };

        if (!storage.memories.has(tableName)) {
          storage.memories.set(tableName, new Map());
        }

        storage.memories.get(tableName).set(id, fullMemory);
        return id as `${string}-${string}-${string}-${string}-${string}`;
      },

      async getMemories(params: any) {
        const tableName = params.tableName || 'messages';
        const tableData = storage.memories.get(tableName);

        if (!tableData) {
          return [];
        }

        let memories = Array.from(tableData.values()) as any[];

        // Apply filters
        if (params.roomId) {
          memories = memories.filter((m: any) => m.roomId === params.roomId);
        }

        if (params.entityId) {
          memories = memories.filter((m: any) => m.entityId === params.entityId);
        }

        // Sort by creation time (newest first)
        memories.sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0));

        // Apply limit
        if (params.count) {
          memories = memories.slice(0, params.count);
        }

        return memories;
      },

      async searchMemories(params: any) {
        // Simple text search for testing
        const tableName = params.tableName || 'messages';
        const tableData = storage.memories.get(tableName);

        if (!tableData) {
          return [];
        }

        let memories = Array.from(tableData.values()) as any[];

        if (params.roomId) {
          memories = memories.filter((m: any) => m.roomId === params.roomId);
        }

        // Simple text matching instead of vector search
        if (params.query) {
          memories = memories.filter((m: any) =>
            m.content?.text?.toLowerCase().includes(params.query.toLowerCase())
          );
        }

        return memories.slice(0, params.count || 10);
      },

      async getMemoryById(id: any) {
        for (const [_tableName, tableData] of storage.memories) {
          const memory = tableData.get(id);
          if (memory) {
            return memory;
          }
        }
        return null;
      },

      async getMemoriesByIds(ids: any, tableName = 'messages') {
        const tableData = storage.memories.get(tableName);
        if (!tableData) {
          return [];
        }

        const memories = [];
        for (const id of ids) {
          const memory = tableData.get(id);
          if (memory) {
            memories.push(memory);
          }
        }
        return memories;
      },

      async getMemoriesByRoomIds(params: any): Promise<any[]> {
        const tableData = storage.memories.get(params.tableName);
        if (!tableData) {
          return [];
        }

        let memories = Array.from(tableData.values()).filter((m: any) =>
          params.roomIds.includes(m.roomId)
        );

        if (params.limit) {
          memories = memories.slice(0, params.limit);
        }

        return memories as any[];
      },

      async getCachedEmbeddings() {
        return []; // Not implemented for basic mock
      },

      async log(params: any) {
        // Simple log storage
        if (!storage.logs) {
          storage.logs = new Map();
        }
        const logId = uuidv4();
        storage.logs.set(logId, {
          id: logId,
          ...params,
          createdAt: new Date(),
        });
      },

      async getLogs() {
        if (!storage.logs) {
          return [];
        }
        return Array.from(storage.logs.values());
      },

      async deleteMemory(memoryId: any, tableName = 'messages') {
        const tableData = storage.memories.get(tableName);
        if (tableData) {
          return tableData.delete(memoryId);
        }
        return false;
      },

      // Room operations
      async createRoom(room: any) {
        const id = room.id || uuidv4();
        const fullRoom = { ...room, id };
        storage.rooms.set(id, fullRoom);
      },

      async getRoom(roomId: any) {
        return storage.rooms.get(roomId) || null;
      },

      async getRooms(worldId: any) {
        return Array.from(storage.rooms.values()).filter(
          (room) => !worldId || room.worldId === worldId
        );
      },

      // Participant operations
      async addParticipant(entityId: any, roomId: any) {
        const participantId = `${entityId}-${roomId}`;
        storage.participants.set(participantId, { entityId, roomId });
        return true;
      },

      async removeParticipant(entityId: any, roomId: any) {
        const participantId = `${entityId}-${roomId}`;
        return storage.participants.delete(participantId);
      },

      async getParticipantsForRoom(roomId: any) {
        return Array.from(storage.participants.values())
          .filter((p: any) => p.roomId === roomId)
          .map((p: any) => p.entityId);
      },

      // Cache operations
      async setCache(key: any, value: any) {
        storage.cache.set(key, {
          value,
          createdAt: Date.now(),
        });
        return true;
      },

      async getCache(key: any) {
        const cached = storage.cache.get(key);
        return cached ? cached.value : null;
      },

      async deleteCache(key: any) {
        return storage.cache.delete(key);
      },

      // World operations
      async createWorld(world: any) {
        const id = world.id || uuidv4();
        const fullWorld = { ...world, id };
        storage.worlds.set(id, fullWorld);
        return id as `${string}-${string}-${string}-${string}-${string}`;
      },

      async getWorld(worldId: any) {
        return storage.worlds.get(worldId) || null;
      },

      async getAllWorlds() {
        return Array.from(storage.worlds.values());
      },

      // Task operations
      async createTask(task: any) {
        const id = task.id || uuidv4();
        const fullTask = {
          ...task,
          id,
          updatedAt: task.updatedAt || Date.now(),
        };
        storage.tasks.set(id, fullTask);
        return id as `${string}-${string}-${string}-${string}-${string}`;
      },

      async getTasks(params: any) {
        let tasks = Array.from(storage.tasks.values());

        if (params.roomId) {
          tasks = tasks.filter((task) => task.roomId === params.roomId);
        }

        if (params.tags) {
          tasks = tasks.filter((task: any) =>
            params.tags.some((tag: any) => task.tags.includes(tag))
          );
        }

        return tasks;
      },

      async deleteTask(taskId: any) {
        storage.tasks.delete(taskId);
      },

      // Relationship operations
      async createRelationship(relationship: any) {
        const id = uuidv4();
        const fullRelationship = { ...relationship, id };
        storage.relationships.set(id, fullRelationship);
        return true;
      },

      async getRelationships(params: any) {
        let relationships = Array.from(storage.relationships.values());

        if (params.entityId) {
          relationships = relationships.filter(
            (rel) =>
              rel.sourceEntityId === params.entityId || rel.targetEntityId === params.entityId
          );
        }

        return relationships;
      },

      async getEntitiesByIds(ids: any) {
        const entities = [];
        for (const id of ids) {
          const entity = storage.entities.get(id);
          if (entity) {
            entities.push(entity);
          }
        }
        return entities;
      },

      async updateMemory(memory: any) {
        const tableName = 'messages'; // Default table
        const tableData = storage.memories.get(tableName);
        if (tableData && tableData.has(memory.id)) {
          const existing = tableData.get(memory.id);
          const updated = { ...existing, ...memory };
          tableData.set(memory.id, updated);
          return updated;
        }
        return null;
      },

      async countMemories(roomId: any, tableName = 'messages') {
        const tableData = storage.memories.get(tableName);
        if (!tableData) {
          return 0;
        }

        if (!roomId) {
          return tableData.size;
        }

        return Array.from(tableData.values()).filter((m: any) => m.roomId === roomId).length;
      },

      async getMemoriesByEntityIds(entityIds: any, tableName = 'messages') {
        const tableData = storage.memories.get(tableName);
        if (!tableData) {
          return [];
        }

        return Array.from(tableData.values()).filter((m: any) => entityIds.includes(m.entityId));
      },

      async removeAllMemories(roomId: any, tableName = 'messages') {
        const tableData = storage.memories.get(tableName);
        if (!tableData) {
          return;
        }

        const toDelete = [];
        for (const [id, memory] of tableData) {
          if (memory.roomId === roomId) {
            toDelete.push(id);
          }
        }

        for (const id of toDelete) {
          tableData.delete(id);
        }
      },

      async updateRoom(room: any) {
        if (!room.id || !storage.rooms.has(room.id)) {
          throw new Error('Room not found');
        }
        storage.rooms.set(room.id, room);
      },

      async deleteRoom(roomId: any) {
        storage.rooms.delete(roomId);
      },

      async getRoomsByIds(roomIds: any) {
        const rooms = [];
        for (const id of roomIds) {
          const room = storage.rooms.get(id);
          if (room) {
            rooms.push(room);
          }
        }
        return rooms;
      },

      async createRooms(rooms: any[]) {
        const ids = [];
        for (const room of rooms) {
          const id = room.id || uuidv4();
          const fullRoom = { ...room, id };
          storage.rooms.set(id, fullRoom);
          ids.push(id);
        }
        return ids;
      },

      async getRoomsByWorld(worldId: any) {
        return Array.from(storage.rooms.values()).filter((room) => room.worldId === worldId);
      },

      async deleteRoomsByWorldId(worldId: any) {
        const toDelete = [];
        for (const [id, room] of storage.rooms) {
          if (room.worldId === worldId) {
            toDelete.push(id);
          }
        }
        for (const id of toDelete) {
          storage.rooms.delete(id);
        }
      },

      async getWorlds(params: any) {
        let worlds = Array.from(storage.worlds.values());
        if (params?.agentId) {
          worlds = worlds.filter((w: any) => w.agentId === params.agentId);
        }
        return worlds;
      },

      async removeWorld(worldId: any) {
        storage.worlds.delete(worldId);
      },

      async updateWorld(world: any) {
        if (!world.id || !storage.worlds.has(world.id)) {
          throw new Error('World not found');
        }
        storage.worlds.set(world.id, world);
      },

      async createComponent(component: any) {
        // Store in a components map within the entity
        const entityComponents = storage.entities.get(component.entityId)?.components || [];
        entityComponents.push(component);

        const entity = storage.entities.get(component.entityId);
        if (entity) {
          entity.components = entityComponents;
          storage.entities.set(component.entityId, entity);
        }

        return true;
      },

      async getComponents(entityId: any) {
        const entity = storage.entities.get(entityId);
        return entity?.components || [];
      },

      async updateComponent(component: any) {
        const entity = storage.entities.get(component.entityId);
        if (entity && entity.components) {
          const index = entity.components.findIndex((c: any) => c.id === component.id);
          if (index >= 0) {
            entity.components[index] = component;
            storage.entities.set(component.entityId, entity);
            return;
          }
        }
        throw new Error('Component not found');
      },

      async deleteComponent(componentId: any) {
        for (const entity of storage.entities.values()) {
          if (entity.components) {
            const index = entity.components.findIndex((c: any) => c.id === componentId);
            if (index >= 0) {
              entity.components.splice(index, 1);
              storage.entities.set(entity.id, entity);
              return;
            }
          }
        }
      },

      async getComponent(entityId: any, type: any, worldId?: any, sourceEntityId?: any) {
        const entity = storage.entities.get(entityId);
        if (!entity?.components) {
          return null;
        }

        return (
          entity.components.find(
            (c: any) =>
              c.type === type &&
              (!worldId || c.worldId === worldId) &&
              (!sourceEntityId || c.sourceEntityId === sourceEntityId)
          ) || null
        );
      },

      async getParticipantsForEntity(entityId: any) {
        return Array.from(storage.participants.values()).filter(
          (p: any) => p.entityId === entityId
        );
      },

      async getRoomsForParticipant(entityId: any) {
        return Array.from(storage.participants.values())
          .filter((p: any) => p.entityId === entityId)
          .map((p: any) => p.roomId);
      },

      async getRoomsForParticipants(userIds: any[]) {
        const roomIds = new Set();
        for (const participant of storage.participants.values()) {
          if (userIds.includes(participant.entityId)) {
            roomIds.add(participant.roomId);
          }
        }
        return Array.from(roomIds);
      },

      async getParticipantUserState(_roomId: any, _entityId: any) {
        // Simple implementation - always return null (no special state)
        return null;
      },

      async setParticipantUserState(_roomId: any, _entityId: any, _state: any) {
        // No-op for mock
      },

      async getRelationship(params: any) {
        const relationships = Array.from(storage.relationships.values());
        return (
          relationships.find(
            (r: any) =>
              r.sourceEntityId === params.sourceEntityId &&
              r.targetEntityId === params.targetEntityId
          ) || null
        );
      },

      async updateRelationship(relationship: any) {
        if (!relationship.id || !storage.relationships.has(relationship.id)) {
          throw new Error('Relationship not found');
        }
        storage.relationships.set(relationship.id, relationship);
      },

      async getTask(id: any) {
        return storage.tasks.get(id) || null;
      },

      async getTasksByName(name: any) {
        return Array.from(storage.tasks.values()).filter((task: any) => task.name === name);
      },

      async updateTask(id: any, updates: any) {
        const task = storage.tasks.get(id);
        if (!task) {
          throw new Error('Task not found');
        }
        const updated = { ...task, ...updates, updatedAt: Date.now() };
        storage.tasks.set(id, updated);
      },

      async deleteLog(logId: any) {
        if (storage.logs) {
          storage.logs.delete(logId);
        }
      },

      async getMemoriesByWorldId(params: any) {
        const tableName = params.tableName || 'messages';
        const tableData = storage.memories.get(tableName);
        if (!tableData) {
          return [];
        }

        let memories = Array.from(tableData.values()).filter(
          (m: any) => m.worldId === params.worldId
        );

        if (params.count) {
          memories = memories.slice(0, params.count);
        }

        return memories;
      },

      async deleteManyMemories(memoryIds: any[]) {
        for (const [_tableName, tableData] of storage.memories) {
          for (const id of memoryIds) {
            tableData.delete(id);
          }
        }
      },

      async deleteAllMemories(roomId: any, _tableName: string) {
        const tableData = storage.memories.get(_tableName);
        if (!tableData) {
          return;
        }

        const toDelete = [];
        for (const [id, memory] of tableData) {
          if (memory.roomId === roomId) {
            toDelete.push(id);
          }
        }

        for (const id of toDelete) {
          tableData.delete(id);
        }
      },

      async addParticipantsRoom(entityIds: any[], roomId: any) {
        for (const entityId of entityIds) {
          const participantId = `${entityId}-${roomId}`;
          storage.participants.set(participantId, { entityId, roomId });
        }
        return true;
      },
    };

    return adapter as unknown as IDatabaseAdapter;
  }

  /**
   * Cleanup a specific test database
   */
  async cleanupDatabase(testId: string): Promise<void> {
    try {
      const adapter = this.testDatabases.get(testId);
      if (adapter) {
        await adapter.close();
        this.testDatabases.delete(testId);
        logger.debug(`Cleaned up database for ${testId}`);
      }
    } catch (error) {
      logger.warn(
        `Error cleaning up database ${testId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Cleanup all test databases
   */
  async cleanup(): Promise<void> {
    logger.debug('Cleaning up all test databases');

    const cleanupPromises = Array.from(this.testDatabases.keys()).map((testId) =>
      this.cleanupDatabase(testId)
    );

    await Promise.all(cleanupPromises);

    // Clear tracking sets
    this.tempPaths.clear();
    this.testDatabases.clear();

    logger.debug('Successfully cleaned up all test databases');
  }

  /**
   * Get statistics about test databases
   */
  getStats(): {
    activeDatabases: number;
    tempPaths: string[];
    memoryUsage: string;
  } {
    return {
      activeDatabases: this.testDatabases.size,
      tempPaths: Array.from(this.tempPaths),
      memoryUsage: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
    };
  }
}

/**
 * Convenience function to create an isolated test database
 */
export async function createTestDatabase(testId?: string): Promise<{
  adapter: IDatabaseAdapter;
  manager: TestDatabaseManager;
  testId: string;
}> {
  const actualTestId = testId || `test-${uuidv4().slice(0, 8)}`;
  const manager = new TestDatabaseManager();
  const adapter = await manager.createIsolatedDatabase(actualTestId);

  return { adapter, manager, testId: actualTestId };
}
