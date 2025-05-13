import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { PgliteDatabaseAdapter } from '../../src/pglite/adapter';
import { PGliteClientManager } from '../../src/pglite/manager';
import { type UUID } from '@elizaos/core';
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
} from './seed';
import { setupMockedMigrations } from '../test-helpers';

// Setup mocked migrations before any tests run or instances are created
setupMockedMigrations();

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
      info: vi.fn(),
    },
  };
});

describe('Embedding Integration Tests', () => {
  // Database connection variables
  let connectionManager: PGliteClientManager;
  let adapter: PgliteDatabaseAdapter;
  let agentId: UUID = embeddingTestAgentId;

  beforeAll(async () => {
    // Initialize connection manager and adapter
    connectionManager = new PGliteClientManager({});
    await connectionManager.initialize();
    adapter = new PgliteDatabaseAdapter(agentId, connectionManager);
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
    const client = connectionManager.getConnection();
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
    }

    // Close all connections
    await adapter.close();
  }, 10000);

  beforeEach(async () => {
    // Clean up any existing test memories before each test
    const client = connectionManager.getConnection();
    try {
      await client.query('DELETE FROM embeddings WHERE TRUE');
      await client.query(`DELETE FROM memories WHERE "roomId" = '${embeddingTestRoomId}'`);
    } catch (error) {
      console.error('Error cleaning test data:', error);
    }
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  describe('createMemory with embedding', () => {
    it('should successfully create a memory with an embedding', async () => {
      // Use the first test memory with embedding
      const memory = embeddingTestMemoriesWithEmbedding[0];

      console.log('Memory:', memory);

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

  describe('ensureEmbeddingDimension', () => {
    it('should set the embedding dimension for the adapter', async () => {
      // Set dimension to 768
      await adapter.ensureEmbeddingDimension(768);

      // Create a memory with 768-dimensional embedding
      const testMemory = {
        ...embeddingTestMemories[0],
        embedding: generateRandomVector(768),
      };

      const memoryId = await adapter.createMemory(testMemory, 'memories');

      // Verify memory was created with the correct dimension
      const createdMemory = await adapter.getMemoryById(memoryId);
      expect(createdMemory).not.toBeNull();
      expect(createdMemory?.embedding).toBeDefined();
      expect(createdMemory?.embedding?.length).toBe(768);

      // Reset to default dimension
      await adapter.ensureEmbeddingDimension(384);
    });
  });
});
