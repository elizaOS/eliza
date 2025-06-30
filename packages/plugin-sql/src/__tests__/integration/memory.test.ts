import {
  ChannelType,
  Content,
  MemoryType,
  type Entity,
  type Memory,
  type MemoryMetadata,
  type Room,
  type UUID,
  type World,
} from '@elizaos/core';
import { v4 } from 'uuid';
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';
import { embeddingTable, memoryTable } from '../../schema';
import { createIsolatedTestDatabase } from '../test-helpers';
import {
  documentMemoryId,
  memoryTestAgentId,
  memoryTestDocument,
  memoryTestEntityId,
  memoryTestFragments,
  memoryTestMemories,
  memoryTestMemoriesWithEmbedding,
} from './seed';

describe('Memory Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testRoomId: UUID;
  let testEntityId: UUID;
  let testWorldId: UUID;

  beforeAll(async () => {
    try {
      const setup = await createIsolatedTestDatabase('memory_tests');
      adapter = setup.adapter;
      cleanup = setup.cleanup;
      testAgentId = setup.testAgentId;

      // Use random UUIDs to avoid conflicts
      testRoomId = v4() as UUID;
      testEntityId = v4() as UUID;
      testWorldId = v4() as UUID;

      await adapter.createWorld({
        id: testWorldId,
        agentId: testAgentId,
        name: 'Test World',
        serverId: 'test-server',
      } as World);
      await adapter.createRooms([
        {
          id: testRoomId,
          agentId: testAgentId,
          worldId: testWorldId,
          name: 'Test Room',
          source: 'test',
          type: ChannelType.GROUP,
        } as Room,
      ]);
      await adapter.createEntities([
        { id: testEntityId, agentId: testAgentId, names: ['Test Entity'] } as Entity,
      ]);
      await adapter.addParticipant(testEntityId, testRoomId);
    } catch (error) {
      console.error('Failed to create test database for memory tests:', error);
      throw error; // Fail the test instead of continuing
    }
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  beforeEach(async () => {
    // Clean up memories and embeddings before each test
    const db = adapter.getDatabase();
    // Delete embeddings first due to foreign key constraints
    await db.delete(embeddingTable);
    await db.delete(memoryTable);
  });

  const createTestMemory = (
    content: Record<string, any>,
    embedding?: number[]
  ): Memory & { metadata: MemoryMetadata } => ({
    id: v4() as UUID,
    agentId: testAgentId,
    roomId: testRoomId,
    entityId: testEntityId,
    content,
    embedding,
    createdAt: Date.now(),
    unique: false,
    metadata: {
      type: MemoryType.CUSTOM,
      source: 'test',
    },
  });

  it('should create and retrieve a memory with an embedding', async () => {
    const memory = createTestMemory(
      { text: 'test' },
      Array.from({ length: 384 }, () => Math.random())
    );
    const memoryId = await adapter.createMemory(memory, 'test');
    const retrieved = await adapter.getMemoryById(memoryId);
    expect(retrieved).toBeDefined();
    expect(retrieved?.embedding?.length).toEqual(384);
  });

  afterEach(async () => {
    // Clean up memories after each test to ensure isolation
    const db = adapter.getDatabase();
    // Delete in correct order to avoid foreign key constraint violations
    await db.delete(embeddingTable);
    await db.delete(memoryTable);
  });

  describe('Memory CRUD Operations', () => {
    it('should create a simple memory without embedding', async () => {
      const memory = createTestMemory({ text: 'simple memory' });
      const memoryId = await adapter.createMemory(memory, 'memories');
      const retrieved = await adapter.getMemoryById(memoryId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.content).toEqual({ text: 'simple memory' });
    });

    it('should update an existing memory', async () => {
      const memory = createTestMemory({ text: 'original' });
      const memoryId = await adapter.createMemory(memory, 'memories');
      await adapter.updateMemory({
        id: memoryId,
        content: { text: 'updated' },
      });
      const retrieved = await adapter.getMemoryById(memoryId);
      expect(retrieved?.content).toEqual({ text: 'updated' });
    });

    it('should delete a memory', async () => {
      const memory = createTestMemory({ text: 'to be deleted' });
      const memoryId = await adapter.createMemory(memory, 'memories');
      let retrieved = await adapter.getMemoryById(memoryId);
      expect(retrieved).toBeDefined();
      await adapter.deleteMemory(memoryId);
      retrieved = await adapter.getMemoryById(memoryId);
      expect(retrieved).toBeNull();
    });

    it('should create a memory with embedding', async () => {
      const memory: Memory = {
        id: v4() as UUID,
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
        content: { text: 'memory with embedding' },
        createdAt: new Date().getTime(),
        embedding: Array.from({ length: 384 }, () => Math.random()),
      };
      const memoryId = await adapter.createMemory(memory, 'memories');
      const createdMemory = await adapter.getMemoryById(memoryId);
      expect(createdMemory).not.toBeNull();
      expect(createdMemory?.embedding).toBeDefined();
      expect(createdMemory?.embedding?.length).toBe(384);
    });

    it('should perform partial updates without affecting other fields', async () => {
      // Create a complete memory first with content, metadata and embedding
      const memory = {
        ...memoryTestMemoriesWithEmbedding[0],
        // Override with correct test IDs
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
        metadata: {
          type: 'test-original',
          source: 'integration-test',
          tags: ['original', 'test'],
          timestamp: 1000,
        },
      };

      const memoryId = await adapter.createMemory(memory, 'memories');

      // Update only content
      const contentUpdate = {
        id: memoryId,
        content: {
          text: 'This is updated content only',
          type: 'text',
        },
      };

      await adapter.updateMemory(contentUpdate);

      // Verify only content changed, embedding and metadata preserved
      const afterContentUpdate = await adapter.getMemoryById(memoryId);
      expect(afterContentUpdate?.content.text).toBe('This is updated content only');
      expect(afterContentUpdate?.embedding).toEqual(memory.embedding as number[]);
      expect(afterContentUpdate?.metadata).toEqual(memory.metadata);

      // Update only one field in metadata
      const metadataUpdate = {
        id: memoryId,
        metadata: {
          type: 'test-original',
          source: 'updated-source', // Only updating the source field
          tags: ['original', 'test'],
          timestamp: 1000,
        },
      };

      await adapter.updateMemory(metadataUpdate);

      // Verify partial metadata update behaves as expected
      const afterMetadataUpdate = await adapter.getMemoryById(memoryId);
      expect(afterMetadataUpdate?.content.text).toBe('This is updated content only');
      expect(afterMetadataUpdate?.metadata?.type).toBe('test-original');
      expect(afterMetadataUpdate?.metadata?.source).toBe('updated-source');
      expect(afterMetadataUpdate?.metadata?.tags).toEqual(['original', 'test']);
      expect(afterMetadataUpdate?.metadata?.timestamp).toBe(1000);
    });

    it('should perform nested partial updates without overriding existing fields', async () => {
      // Create a memory with rich content and metadata
      const originalMemory = {
        ...memoryTestMemoriesWithEmbedding[0],
        // Override with correct test IDs
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
        content: {
          text: 'Original content text',
          type: 'text',
          additionalInfo: 'This should be preserved',
        },
        metadata: {
          type: 'test-original',
          source: 'integration-test',
          tags: ['original', 'test'],
          timestamp: 1000,
        },
      };

      const memoryId = await adapter.createMemory(originalMemory, 'memories');

      // When updating content, we must include the full content object
      // since partial updates fully replace the content object
      const contentTextUpdate = {
        id: memoryId,
        content: {
          text: 'Updated text only',
          type: 'text',
          additionalInfo: 'This should be preserved',
        },
      };

      await adapter.updateMemory(contentTextUpdate);

      // Verify content was updated but metadata preserved
      const afterContentTextUpdate = await adapter.getMemoryById(memoryId);
      expect(afterContentTextUpdate?.content.text).toBe('Updated text only');
      expect(afterContentTextUpdate?.content.type).toBe('text');
      expect(afterContentTextUpdate?.content.additionalInfo).toBe('This should be preserved');
      expect(afterContentTextUpdate?.metadata).toEqual(originalMemory.metadata);

      // Update only source field in metadata, but must include all metadata fields
      // since partial updates fully replace the metadata object
      const sourceUpdate = {
        id: memoryId,
        metadata: {
          type: 'test-original',
          source: 'updated-source',
          tags: ['original', 'test'],
          timestamp: 1000,
        },
      };

      await adapter.updateMemory(sourceUpdate);

      // Verify metadata was updated and content preserved
      const afterSourceUpdate = await adapter.getMemoryById(memoryId);
      expect(afterSourceUpdate?.content).toEqual(afterContentTextUpdate?.content as Content);
      expect(afterSourceUpdate?.metadata?.type).toBe('test-original');
      expect(afterSourceUpdate?.metadata?.source).toBe('updated-source');
      expect(afterSourceUpdate?.metadata?.tags).toEqual(['original', 'test']);
      expect(afterSourceUpdate?.metadata?.timestamp).toBe(1000);
    });
  });

  describe('Memory Retrieval Operations', () => {
    it('should retrieve memories by room ID', async () => {
      await adapter.createMemory(createTestMemory({ text: 'mem1' }), 'messages');
      await adapter.createMemory(createTestMemory({ text: 'mem2' }), 'messages');
      const memories = await adapter.getMemories({
        roomId: testRoomId,
        tableName: 'messages',
      });
      expect(memories.length).toBe(2);
    });

    it('should count memories in a room', async () => {
      await adapter.createMemory(createTestMemory({ text: 'mem1' }), 'memories');
      await adapter.createMemory(createTestMemory({ text: 'mem2' }), 'memories');
      const count = await adapter.countMemories(testRoomId, false, 'memories');
      expect(count).toBe(2);
    });

    it('should retrieve memories by ID list', async () => {
      // Create test memories and collect their IDs
      const memoryIds: UUID[] = [];

      for (const memory of memoryTestMemories.slice(0, 2)) {
        // Override with correct test IDs
        const testMemory = {
          ...memory,
          agentId: testAgentId,
          entityId: testEntityId,
          roomId: testRoomId,
        };
        const memoryId = await adapter.createMemory(testMemory, 'memories');
        memoryIds.push(memoryId);
      }

      // Retrieve memories by IDs
      const memories = await adapter.getMemoriesByIds(memoryIds, 'memories');

      expect(memories).toHaveLength(2);
      expect(memories.map((m) => m.id)).toEqual(expect.arrayContaining(memoryIds));
    });

    it('should retrieve memories with pagination', async () => {
      // Create test memories
      for (const memory of memoryTestMemories) {
        // Override with correct test IDs
        const testMemory = {
          ...memory,
          agentId: testAgentId,
          entityId: testEntityId,
          roomId: testRoomId,
        };
        await adapter.createMemory(testMemory, 'memories');
      }

      // Retrieve first page (limit to 2)
      const firstPage = await adapter.getMemories({
        roomId: testRoomId,
        tableName: 'memories',
        count: 2,
      });

      expect(firstPage).toHaveLength(2);

      // Test second page (remaining memories)
      const secondPage = await adapter.getMemories({
        roomId: testRoomId,
        tableName: 'memories',
      });

      // There should be at least 3 memories total
      expect(secondPage.length).toBeGreaterThanOrEqual(memoryTestMemories.length);
    });
  });

  describe('Memory Search Operations', () => {
    it('should search memories by embedding similarity', async () => {
      const baseEmbedding = Array.from({ length: 384 }, () => Math.random());
      const memory1: Partial<Memory> = {
        id: v4() as UUID,
        content: { text: 'memory 1' },
        createdAt: new Date().getTime(),
        embedding: baseEmbedding,
      };
      memory1.agentId = testAgentId;
      memory1.roomId = testRoomId;
      memory1.entityId = testEntityId;
      await adapter.createMemory(memory1 as Memory, 'search');

      const results = await adapter.searchMemoriesByEmbedding(baseEmbedding, {
        tableName: 'search',
        roomId: testRoomId,
        count: 1,
      });

      expect(results.length).toBe(1);
      expect(results[0].id).toBe(memory1.id as UUID);
      expect(results[0].similarity).toBeGreaterThan(0.99);
    });
  });

  describe('Document and Fragment Operations', () => {
    it('should create a document with fragments', async () => {
      // Create the document with correct test IDs
      const testDocument = {
        ...memoryTestDocument,
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
      };
      await adapter.createMemory(testDocument, 'documents');

      // Create fragments that reference the document with correct test IDs
      for (const fragment of memoryTestFragments) {
        const testFragment = {
          ...fragment,
          agentId: testAgentId,
          entityId: testEntityId,
          roomId: testRoomId,
        };
        await adapter.createMemory(testFragment, 'fragments');
      }

      // Retrieve fragments for the document
      const fragments = await adapter.getMemories({
        tableName: 'fragments',
        roomId: testRoomId,
      });

      expect(fragments.length).toEqual(memoryTestFragments.length);
    });

    it('should delete a document and its fragments', async () => {
      // Create the document with correct test IDs
      const testDocument = {
        ...memoryTestDocument,
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
      };
      await adapter.createMemory(testDocument, 'documents');

      // Create fragments that reference the document with correct test IDs
      for (const fragment of memoryTestFragments) {
        const testFragment = {
          ...fragment,
          agentId: testAgentId,
          entityId: testEntityId,
          roomId: testRoomId,
        };
        await adapter.createMemory(testFragment, 'fragments');
      }

      // Delete the document (should cascade to fragments)
      await adapter.deleteMemory(documentMemoryId);

      // Verify document is deleted
      const document = await adapter.getMemoryById(documentMemoryId);
      expect(document).toBeNull();

      // Verify fragments are also deleted
      const fragments = await adapter.getMemories({
        tableName: 'fragments',
        roomId: testRoomId,
      });

      expect(fragments.length).toBe(0);
    });
  });

  describe('Memory Model Mapping', () => {
    it('should correctly map between Memory and MemoryModel', async () => {
      const testMemory = {
        ...memoryTestMemories[0],
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
      };

      // Create the memory
      await adapter.createMemory(testMemory, 'memories');

      // Retrieve it from database
      const retrievedMemory = await adapter.getMemoryById(testMemory.id as UUID);
      expect(retrievedMemory).not.toBeNull();

      // Verify all fields were properly mapped
      expect(retrievedMemory!.id).toBe(testMemory.id as UUID);
      expect(retrievedMemory!.entityId).toBe(testMemory.entityId);
      expect(retrievedMemory!.roomId).toBe(testMemory.roomId);
      expect(retrievedMemory!.agentId).toBe(testMemory.agentId);
      expect(retrievedMemory!.content.text).toBe(testMemory.content.text as string);
      expect(retrievedMemory!.metadata?.type).toBe(testMemory.metadata?.type as string);
    });

    it('should handle partial Memory objects in mapToMemoryModel', async () => {
      // Create the required entity first to avoid foreign key constraint violations
      await adapter.createEntities([
        {
          id: memoryTestEntityId,
          agentId: testAgentId,
          names: ['Test Entity'],
        } as Entity,
      ]);

      // Create a partial memory object
      const partialMemory: Partial<any> = {
        id: memoryTestAgentId, // Using a known UUID
        entityId: memoryTestEntityId,
        roomId: testRoomId,
        agentId: testAgentId,
        content: {
          text: 'Partial memory object',
          type: 'text',
        },
      };

      // Create the memory
      await adapter.createMemory(partialMemory as any, 'memories');

      // Retrieve it from database
      const retrievedMemory = await adapter.getMemoryById(partialMemory.id as UUID);
      expect(retrievedMemory).not.toBeNull();

      // Verify fields were properly mapped with defaults where applicable
      expect(retrievedMemory!.id).toBe(partialMemory.id);
      expect(retrievedMemory!.entityId).toBe(partialMemory.entityId);
      expect(retrievedMemory!.roomId).toBe(partialMemory.roomId);
      expect(retrievedMemory!.content.text).toBe(partialMemory.content?.text);
      expect(retrievedMemory!.unique).toBe(true); // Default value
      expect(retrievedMemory!.metadata).toBeDefined(); // Default empty object
    });
  });

  describe('Memory Batch Operations', () => {
    it('should delete all memories in a room', async () => {
      // Create the required entity first to avoid foreign key constraint violations
      await adapter.createEntities([
        {
          id: memoryTestEntityId,
          agentId: testAgentId,
          names: ['Test Entity'],
        } as Entity,
      ]);

      // Create test memories with correct entity IDs
      for (const memory of memoryTestMemories) {
        const testMemory = {
          ...memory,
          agentId: testAgentId,
          entityId: memoryTestEntityId,
          roomId: testRoomId,
        };
        await adapter.createMemory(testMemory, 'memories');
      }

      // Verify memories exist
      const countBefore = await adapter.countMemories(testRoomId, true, 'memories');
      expect(countBefore).toBeGreaterThan(0);

      // Delete all memories
      await adapter.deleteAllMemories(testRoomId, 'memories');

      // Verify memories were deleted
      const countAfter = await adapter.countMemories(testRoomId, true, 'memories');
      expect(countAfter).toBe(0);
    });

    it('should retrieve memories by multiple room IDs', async () => {
      const secondRoomId = v4() as UUID;
      await adapter.createRooms([
        {
          id: secondRoomId,
          name: 'Memory Test Room 2',
          agentId: testAgentId,
          source: 'test',
          type: ChannelType.GROUP,
          worldId: testWorldId,
        },
      ]);

      // Create memories in the first room
      await adapter.createMemory(createTestMemory({ text: 'mem1-room1' }), 'memories');
      await adapter.createMemory(createTestMemory({ text: 'mem2-room1' }), 'memories');

      // Create memories in the second room
      await adapter.createMemory(
        { ...createTestMemory({ text: 'mem3-room2' }), roomId: secondRoomId },
        'memories'
      );

      // Retrieve memories from both rooms
      const memories = await adapter.getMemoriesByRoomIds({
        roomIds: [testRoomId, secondRoomId],
        tableName: 'memories',
      });

      expect(memories.length).toEqual(3);
    });
  });
});

// Import tables at the end to avoid circular dependencies if needed in this file
