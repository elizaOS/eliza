import { v4 as uuidv4 } from 'uuid';
import { Memory, Entity, Room, Agent, World, UUID, ChannelType } from '@elizaos/core';

// Test IDs
export const memoryTestAgentId = uuidv4() as UUID;
export const memoryTestEntityId = uuidv4() as UUID;
export const memoryTestRoomId = uuidv4() as UUID;
export const memoryTestWorldId = uuidv4() as UUID;

// Test data for memory integration tests
export const memoryTestAgent: Agent = {
  id: memoryTestAgentId,
  name: 'Memory Test Agent',
  bio: 'Test agent for memory integration tests',
  settings: {
    profile: {
      short_description: 'Test agent for memory integration tests',
    },
  },
  createdAt: new Date().getTime(),
  updatedAt: new Date().getTime(),
};

export const memoryTestEntity: Entity = {
  id: memoryTestEntityId,
  names: ['Memory Test Entity'],
  agentId: memoryTestAgentId,
  components: [],
  metadata: {
    type: 'user',
    worldId: memoryTestWorldId,
  },
};

export const memoryTestWorld: World = {
  id: memoryTestWorldId,
  agentId: memoryTestAgentId,
  name: 'Memory Test World',
  serverId: 'test-server',
  metadata: {},
};

export const memoryTestRoom: Room = {
  id: memoryTestRoomId,
  name: 'Memory Test Room',
  agentId: memoryTestAgentId,
  source: 'test',
  type: ChannelType.GROUP,
  worldId: memoryTestWorldId,
  metadata: {},
};

// Helper function to generate random embedding vectors
export const generateEmbedding = (dimension: number = 384): number[] => {
  const vector = Array(dimension)
    .fill(0)
    .map(() => Math.random() * 2 - 1);
  // Normalize
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  return vector.map((val) => Number((val / magnitude).toFixed(6)));
};

// Basic memory test objects
export const memoryTestMemories: Memory[] = [
  {
    id: uuidv4() as UUID,
    entityId: memoryTestEntityId,
    roomId: memoryTestRoomId,
    agentId: memoryTestAgentId,
    createdAt: new Date().getTime() - 3600000, // 1 hour ago
    unique: true,
    content: {
      text: 'This is a test memory for integration testing #1',
      type: 'text',
    },
    metadata: {
      type: 'chat',
      source: 'integration-test',
    },
  },
  {
    id: uuidv4() as UUID,
    entityId: memoryTestEntityId,
    roomId: memoryTestRoomId,
    agentId: memoryTestAgentId,
    createdAt: new Date().getTime() - 7200000, // 2 hours ago
    unique: true,
    content: {
      text: 'This is a test memory for integration testing #2',
      type: 'text',
    },
    metadata: {
      type: 'chat',
      source: 'integration-test',
    },
  },
  {
    id: uuidv4() as UUID,
    entityId: memoryTestEntityId,
    roomId: memoryTestRoomId,
    agentId: memoryTestAgentId,
    createdAt: new Date().getTime() - 10800000, // 3 hours ago
    unique: true,
    content: {
      text: 'This is a test memory for integration testing #3',
      type: 'text',
    },
    metadata: {
      type: 'chat',
      source: 'integration-test',
    },
  },
];

// Memory test objects with embeddings
export const memoryTestMemoriesWithEmbedding: Memory[] = [
  {
    ...memoryTestMemories[0],
    id: uuidv4() as UUID,
    embedding: generateEmbedding(384),
    content: {
      text: 'This is a test memory with embedding dimension 384',
      type: 'text',
    },
  },
  {
    ...memoryTestMemories[1],
    id: uuidv4() as UUID,
    embedding: generateEmbedding(384),
    content: {
      text: 'This is a test memory with embedding dimension 384',
      type: 'text',
    },
  },
  {
    ...memoryTestMemories[2],
    id: uuidv4() as UUID,
    embedding: generateEmbedding(384),
    content: {
      text: 'This is a test memory with embedding dimension 384',
      type: 'text',
    },
  },
];

// Document and fragments for testing document operations
export const documentMemoryId = uuidv4() as UUID;
export const memoryTestDocument: Memory = {
  id: documentMemoryId,
  entityId: memoryTestEntityId,
  roomId: memoryTestRoomId,
  agentId: memoryTestAgentId,
  createdAt: new Date().getTime(),
  unique: true,
  content: {
    text: 'This is a test document memory',
    type: 'text',
  },
  metadata: {
    type: 'document',
    documentId: documentMemoryId,
    timestamp: Date.now(),
    title: 'Test Document',
    source: 'integration-test',
  },
};

// Fragment memories that belong to the document
export const memoryTestFragments: Memory[] = Array(3)
  .fill(0)
  .map((_, index) => ({
    id: uuidv4() as UUID,
    entityId: memoryTestEntityId,
    roomId: memoryTestRoomId,
    agentId: memoryTestAgentId,
    createdAt: new Date().getTime(),
    unique: true,
    content: {
      text: `This is fragment ${index + 1} of the test document`,
      type: 'text',
    },
    embedding: generateEmbedding(384),
    metadata: {
      type: 'fragment',
      documentId: documentMemoryId,
      position: index,
      source: 'integration-test',
    },
  }));

// Helper function to create similar memory for vector similarity testing
export const createSimilarMemoryVector = (baseMemory: Memory, similarity: number): Memory => {
  // Only works if baseMemory has an embedding
  if (!baseMemory.embedding || !Array.isArray(baseMemory.embedding)) {
    throw new Error('Base memory must have an embedding');
  }

  // Create a somewhat similar vector (higher similarity means more similar)
  const dimension = baseMemory.embedding.length;
  const noise = generateEmbedding(dimension);

  // Blend the original vector with noise based on similarity
  const blendedVector = baseMemory.embedding.map((value, idx) => {
    return value * similarity + noise[idx] * (1 - similarity);
  });

  // Normalize the resulting vector
  const magnitude = Math.sqrt(blendedVector.reduce((sum, val) => sum + val * val, 0));
  const normalizedVector = blendedVector.map((val) => Number((val / magnitude).toFixed(6)));

  return {
    ...baseMemory,
    id: uuidv4() as UUID,
    embedding: normalizedVector,
    content: {
      ...baseMemory.content,
      text: `Similar to: ${baseMemory.content.text}`,
    },
  };
};
