import { AgentRuntime, Character, stringToUuid, RuntimeSettings } from '@elizaos/core';
import { loadEnvironmentVariables } from './env-loader';
import { IDatabaseAdapter, Agent, Entity, Room, UUID } from '@elizaos/core';

// --- Start of Pre-emptive Environment Loading ---
// This block MUST execute before any plugin imports to ensure
// environment variables are available system-wide.

console.log('[ENV] Loading environment configuration...');
loadEnvironmentVariables();

// Get the loaded environment settings
const envSettings = process.env as RuntimeSettings;
console.log(`[ENV] Environment loaded with ${Object.keys(envSettings).length} variables`);
// --- End of Pre-emptive Environment Loading ---

import { plugin as sqlPlugin } from '@elizaos/plugin-sql';
import { e2bPlugin } from '@elizaos/plugin-e2b';
import { openaiPlugin } from '@elizaos/plugin-openai';

/**
 * Simple mock database adapter for testing scenarios without database dependencies
 */
class MockDatabaseAdapter implements IDatabaseAdapter {
  async init(): Promise<void> {
    // No-op for testing
  }

  async initialize(): Promise<void> {
    // No-op for testing
  }



  async isReady(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    // No-op for testing
  }

  async getAgent(agentId: UUID): Promise<Agent | null> {
    return {
      id: agentId,
      name: 'test-agent',
      bio: 'Test agent for scenarios',
      plugins: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  async getAgents(): Promise<Agent[]> {
    return [];
  }

  async createAgent(agent: Partial<Agent>): Promise<boolean> {
    return true;
  }

  async updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
    return true;
  }

  async deleteAgent(agentId: UUID): Promise<boolean> {
    return true;
  }

  async ensureAgentExists(agent: Partial<Agent>): Promise<Agent> {
    return {
      id: agent.id || 'test-agent-id' as UUID,
      name: agent.name || 'test-agent',
      bio: agent.bio || 'Test agent',
      plugins: agent.plugins || [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  async getEntityById(entityId: UUID): Promise<Entity | null> {
    // Return a mock entity for the agent
    return {
      id: entityId,
      names: ['test-entity'],
      metadata: {},
      agentId: entityId
    };
  }

  async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[]> {
    // Return mock entities for the requested IDs
    return entityIds.map(id => ({
      id,
      names: ['test-entity'],
      metadata: {},
      agentId: id
    }));
  }

  async createEntity(entity: Entity): Promise<boolean> {
    return true;
  }

  async createEntities(entities: Entity[]): Promise<boolean> {
    return true;
  }

  async updateEntity(entity: Entity): Promise<void> {
    // No-op
  }

  async getRoom(roomId: UUID): Promise<Room | null> {
    return null;
  }

  async getRoomsByIds(roomIds: UUID[]): Promise<Room[]> {
    return [];
  }

  async createRoom(params: any): Promise<UUID> {
    return params.id || 'test-room-id' as UUID;
  }

  async createRooms(rooms: Room[]): Promise<UUID[]> {
    return rooms.map(r => r.id);
  }

  async deleteRoom(roomId: UUID): Promise<void> {
    // No-op
  }

  async deleteRoomsByWorldId(worldId: UUID): Promise<void> {
    // No-op
  }

  async updateRoom(room: Room): Promise<void> {
    // No-op
  }

  async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
    return [];
  }

  async addParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    return true;
  }

  async addParticipantsRoom(entityIds: UUID[], roomId: UUID): Promise<boolean> {
    return true;
  }

  async removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    return true;
  }

  async getParticipantsForEntity(entityId: UUID): Promise<any[]> {
    return [];
  }

  async getRoomsForParticipant(entityId: UUID): Promise<UUID[]> {
    return [];
  }

  async getRoomsForParticipants(entityIds: UUID[]): Promise<UUID[]> {
    return [];
  }

  async getRooms(worldId: UUID): Promise<Room[]> {
    return [];
  }

  async getRoomsByWorld(worldId: UUID): Promise<Room[]> {
    return [];
  }

  async getParticipantUserState(roomId: UUID, entityId: UUID): Promise<'FOLLOWED' | 'MUTED' | null> {
    return null;
  }

  async setParticipantUserState(roomId: UUID, entityId: UUID, state: 'FOLLOWED' | 'MUTED' | null): Promise<void> {
    // No-op
  }

  async createRelationship(params: any): Promise<boolean> {
    return true;
  }

  async updateRelationship(relationship: any): Promise<void> {
    // No-op
  }

  async getRelationship(params: any): Promise<any> {
    return null;
  }

  async getRelationships(params: any): Promise<any[]> {
    return [];
  }

  async getCache<T>(key: string): Promise<T | undefined> {
    return undefined;
  }

  async setCache<T>(key: string, value: T): Promise<boolean> {
    return true;
  }

  async deleteCache(key: string): Promise<boolean> {
    return true;
  }

  async createTask(task: any): Promise<UUID> {
    return 'test-task-id' as UUID;
  }

  async getTasks(params: any): Promise<any[]> {
    return [];
  }

  async getTask(id: UUID): Promise<any | null> {
    return null;
  }

  async getTasksByName(name: string): Promise<any[]> {
    return [];
  }

  async updateTask(id: UUID, task: any): Promise<void> {
    // No-op
  }

  async deleteTask(id: UUID): Promise<void> {
    // No-op
  }

  async getMemoryById(id: UUID): Promise<any | null> {
    return null;
  }

  async getMemoriesByIds(memoryIds: UUID[], tableName?: string): Promise<any[]> {
    return [];
  }

  async log(params: any): Promise<void> {
    // No-op
  }

  async createMemory(memory: any, tableName: string, unique?: boolean): Promise<UUID> {
    return 'test-memory-id' as UUID;
  }

  async updateMemory(memory: any): Promise<boolean> {
    return true;
  }

  async deleteMemory(memoryId: UUID): Promise<void> {
    // No-op
  }

  async deleteManyMemories(memoryIds: UUID[]): Promise<void> {
    // No-op
  }

  async clearAllAgentMemories(): Promise<void> {
    // No-op
  }

  async deleteAllMemories(roomId: UUID, tableName: string): Promise<void> {
    // No-op
  }

  async countMemories(roomId: UUID, unique?: boolean, tableName?: string): Promise<number> {
    return 0;
  }

  async getLogs(params: any): Promise<any[]> {
    return [];
  }

  async deleteLog(logId: UUID): Promise<void> {
    // No-op
  }

  async createWorld(world: any): Promise<UUID> {
    return 'test-world-id' as UUID;
  }

  async getWorld(id: UUID): Promise<any | null> {
    return null;
  }

  async removeWorld(worldId: UUID): Promise<void> {
    // No-op
  }

  async getAllWorlds(): Promise<any[]> {
    return [];
  }

  async updateWorld(world: any): Promise<void> {
    // No-op
  }

  async getEntitiesForRoom(roomId: UUID, includeComponents?: boolean): Promise<any[]> {
    return [];
  }

  async getComponent(entityId: UUID, type: string, worldId?: UUID, sourceEntityId?: UUID): Promise<any | null> {
    return null;
  }

  async getComponents(entityId: UUID, worldId?: UUID, sourceEntityId?: UUID): Promise<any[]> {
    return [];
  }

  async createComponent(component: any): Promise<boolean> {
    return true;
  }

  async updateComponent(component: any): Promise<void> {
    // No-op
  }

  async deleteComponent(componentId: UUID): Promise<void> {
    // No-op
  }

  async addEmbeddingToMemory(memory: any): Promise<any> {
    return memory;
  }

  async getMemories(params: any): Promise<any[]> {
    return [];
  }

  async getAllMemories(): Promise<any[]> {
    return [];
  }

  async searchMemories(params: any): Promise<any[]> {
    return [];
  }

  async rerankMemories(query: string, memories: any[]): Promise<any[]> {
    return memories;
  }

  async getCachedEmbeddings(params: any): Promise<any[]> {
    return [];
  }

  async getMemoriesByWorldId(params: any): Promise<any[]> {
    return [];
  }

  async getMemoriesByRoomIds(params: any): Promise<any[]> {
    return [];
  }

  async getMemoriesByEntities(params: any): Promise<any[]> {
    return [];
  }

  async searchMemoriesByEmbedding(embedding: number[], params?: any): Promise<any[]> {
    return [];
  }

  async deleteEntity(entityId: UUID): Promise<void> {
    // No-op
  }

  async getEntityDetails(params: any): Promise<any[]> {
    return [];
  }

  async getEntities(params: any): Promise<any[]> {
    return [];
  }

  async getParticipantsForAccount(entityId: any): Promise<any[]> {
    return [];
  }

  async ensureEmbeddingDimension(dimension: number): Promise<void> {
    // No-op
  }

  async runMigrations(migrationsPaths?: string[]): Promise<void> {
    // No-op
  }

  async getConnection(): Promise<any> {
    return null;
  }

  get db(): any {
    return {};
  }
}

/**
 * Creates a minimal runtime with E2B, SQL, and OpenAI plugins loaded for scenario execution
 */
export async function createE2BRuntime(): Promise<AgentRuntime> {
  // Create minimal character for E2B operations
  const character: Character = {
    name: 'scenario-runner',
    id: stringToUuid('scenario-runner'),
    bio: 'A minimal character for running E2B scenarios',
    plugins: [
      '@elizaos/plugin-sql',
      '@elizaos/plugin-e2b',
      '@elizaos/plugin-openai'
    ]
  };

  // Use the loaded environment settings
  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, e2bPlugin, openaiPlugin],
    settings: envSettings
  });

  // Initialize the runtime to set up services
  await runtime.initialize();

  return runtime;
}

/**
 * Creates a minimal runtime with only E2B and OpenAI plugins for testing LLM functionality
 */
export async function createTestRuntime(): Promise<AgentRuntime> {
  // Create minimal character for testing
  const character: Character = {
    name: 'test-runner',
    id: stringToUuid('test-runner'),
    bio: 'A minimal character for testing scenarios',
    plugins: [
      '@elizaos/plugin-e2b',
      '@elizaos/plugin-openai'
    ]
  };

  // Create a mock database adapter for testing
  const mockAdapter = new MockDatabaseAdapter();

  // Use the loaded environment settings
  const runtime = new AgentRuntime({
    character,
    plugins: [e2bPlugin, openaiPlugin],
    settings: envSettings,
    adapter: mockAdapter
  });

  // Initialize the runtime to set up services
  await runtime.initialize();

  return runtime;
}