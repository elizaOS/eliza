import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { MySql2DatabaseAdapter } from '../../src/mysql2/adapter';
import { MySql2ConnectionManager } from '../../src/mysql2/manager';
import { type UUID } from '@elizaos/core';
import { config } from './seed/config';
import {
  embeddingTestAgentId,
  embeddingTestRoomId,
  embeddingTestMemories,
  embeddingTestMemoriesWithEmbedding,
  generateRandomVector,
  embeddingTestAgent,
  embeddingTestEntity,
  embeddingTestRoom,
  embeddingTestEntityId,
  embeddingTestWorldId,
} from './seed/embedding-seed';

// Mock only the logger
vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual('@elizaos/core');
  return {
    ...actual,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      success: vi.fn(),
    },
  };
});

describe('Embedding Integration Tests', () => {
  // Database connection variables
  let connectionManager: MySql2ConnectionManager;
  let adapter: MySql2DatabaseAdapter;
  let agentId: UUID = embeddingTestAgentId;

  beforeAll(async () => {
    // Initialize connection manager and adapter
    connectionManager = new MySql2ConnectionManager(config.DATABASE_URL);
    await connectionManager.initialize();
    adapter = new MySql2DatabaseAdapter(agentId, connectionManager);
    await adapter.init();

    try {
      // Step 1: Create test agent
      await adapter.createAgent(embeddingTestAgent);

      // Step 2: Create test world
      await adapter.createWorld({
        id: embeddingTestWorldId,
        name: 'Embedding Test World',
        agentId: embeddingTestAgentId,
        serverId: 'test-server',
      });

      // Step 3: Create test entity
      await adapter.createEntity(embeddingTestEntity);

      // Step 4: Create test room
      await adapter.createRoom(embeddingTestRoom);

      // Step 5: Add entity as participant in the room
      await adapter.addParticipant(embeddingTestEntityId, embeddingTestRoomId);
    } catch (error) {
      console.error('Error in setup:', error);
      throw error;
    }
  }, 10000);

  afterAll(async () => {
    // Clean up test data
    const client = await connectionManager.getClient();
    try {
      // Order matters for foreign key constraints
      await client.query('DELETE FROM embeddings WHERE TRUE');
      await client.query('DELETE FROM participants WHERE TRUE');
      await client.query(`DELETE FROM memories WHERE "roomId" = '${embeddingTestRoomId}'`);
      await client.query(`DELETE FROM rooms WHERE id = '${embeddingTestRoomId}'`);
      await client.query(`DELETE FROM entities WHERE id = '${embeddingTestEntityId}'`);
      await client.query(`DELETE FROM worlds WHERE id = '${embeddingTestWorldId}'`);
      await client.query(`DELETE FROM agents WHERE id = '${embeddingTestAgentId}'`);
    } catch (error) {
      console.error('Error cleaning test data:', error);
    } finally {
      client.release();
    }

    // Close all connections
    await adapter.close();
  }, 10000);

  beforeEach(async () => {
    // Clean up any existing test memories before each test
    const client = await connectionManager.getClient();
    try {
      await client.query('DELETE FROM embeddings WHERE TRUE');
      await client.query(`DELETE FROM memories WHERE "roomId" = '${embeddingTestRoomId}'`);
    } finally {
      client.release();
    }
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  describe('createMemory with embedding', () => {
    it('should successfully create a memory with an embedding', async () => {
      // Use the first test memory with embedding
      const memory = embeddingTestMemoriesWithEmbedding[0];

      // Create memory with embedding
      const memoryId = await adapter.createMemory(memory, 'memories');

      expect(memoryId).toBeDefined();
      expect(memoryId).toEqual(memory.id);

      // Retrieve memory to verify embedding was stored
      const createdMemory = await adapter.getMemoryById(memoryId);

      expect(createdMemory).not.toBeNull();
      expect(createdMemory?.id).toEqual(memory.id);
      expect(createdMemory?.embedding).toBeDefined();
      expect(Array.isArray(createdMemory?.embedding)).toBe(true);
      expect(createdMemory?.embedding?.length).toEqual(memory.embedding.length);
    });
  });
});
