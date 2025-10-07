import {
  type Entity,
  type Memory,
  type Room,
  type UUID,
  ChannelType,
  MemoryType,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';
import { embeddingTable, memoryTable } from '../../schema';
import { createIsolatedTestDatabase } from '../test-helpers';

describe('Embedding Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testEntityId: UUID;
  let testRoomId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase('embedding-tests');
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    // Generate random UUIDs for test data
    testEntityId = uuidv4() as UUID;
    testRoomId = uuidv4() as UUID;

    await adapter.createEntities([
      { id: testEntityId, agentId: testAgentId, names: ['Test Entity'] } as Entity,
    ]);
    await adapter.createRooms([
      {
        id: testRoomId,
        agentId: testAgentId,
        name: 'Test Room',
        source: 'test',
        type: ChannelType.GROUP,
      } as Room,
    ]);
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe('Embedding Tests', () => {
    beforeEach(async () => {
      await adapter.getDatabase().delete(embeddingTable);
      await adapter.getDatabase().delete(memoryTable);
    });

    it('should create a memory with an embedding and retrieve it', async () => {
      await adapter.ensureEmbeddingDimension(384);
      const memory: Memory = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
        content: { text: 'This memory has an embedding.' },
        embedding: Array.from({ length: 384 }, () => Math.random()),
        createdAt: Date.now(),
        unique: false,
        metadata: {
          type: MemoryType.CUSTOM,
          source: 'test',
        },
      };

      const memoryId = await adapter.createMemory(memory, 'embedding_test');
      expect(memoryId).toBe(memory.id as UUID);

      const retrieved = await adapter.getMemoryById(memoryId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.embedding).toBeDefined();
      expect(retrieved?.embedding?.length).toBe(384);
    });

    it('should handle different embedding dimensions', async () => {
      // Test with 768 dimensions
      await adapter.ensureEmbeddingDimension(768);

      const memory768: Memory = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
        content: { text: 'This memory has a 768-dimension embedding.' },
        embedding: Array.from({ length: 768 }, () => Math.random()),
        createdAt: Date.now(),
        unique: false,
        metadata: {
          type: MemoryType.CUSTOM,
          source: 'test',
        },
      };

      const memoryId = await adapter.createMemory(memory768, 'embedding_test_768');
      const retrieved = await adapter.getMemoryById(memoryId);
      expect(retrieved?.embedding?.length).toBe(768);
    });
  });
});
