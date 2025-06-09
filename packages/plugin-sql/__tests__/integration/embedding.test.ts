import { beforeAll, describe, it, expect, afterAll, beforeEach } from 'vitest';
import {
  type Memory,
  type UUID,
  AgentRuntime,
  stringToUuid,
  ChannelType,
  type Entity,
  type Room,
  MemoryType,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { PgliteDatabaseAdapter } from '../../src/pglite/adapter';
import { createTestDatabase } from '../test-helpers';
import { embeddingTable, memoryTable } from '../../src/schema';

describe('Embedding Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter;
  let runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  const testAgentId = stringToUuid('test-agent-for-embedding-tests');
  let testEntityId: UUID;
  let testRoomId: UUID;

  beforeAll(async () => {
    ({ adapter, runtime, cleanup } = await createTestDatabase(testAgentId));
    testEntityId = stringToUuid('test-entity-for-embedding-tests');
    testRoomId = stringToUuid('test-room-for-embedding-tests');
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
    await cleanup();
  });

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
    expect(memoryId).toBe(memory.id);

    const retrieved = await adapter.getMemoryById(memoryId);
    expect(retrieved).toBeDefined();
    expect(retrieved?.embedding).toBeDefined();
    expect(retrieved?.embedding?.length).toBe(384);
  });

  it('should ensure embedding dimension is set correctly', async () => {
    await adapter.ensureEmbeddingDimension(768);
    // @ts-expect-error - Accessing protected property for test
    expect(adapter.embeddingDimension).toBe('dim768');
  });
});
