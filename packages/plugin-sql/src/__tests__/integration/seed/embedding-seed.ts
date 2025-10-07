import { Agent, AgentStatus, ChannelType, Entity, Memory, Room, UUID } from '@elizaos/core';

// Generate fixed UUIDs for testing to avoid type issues
const fixedUuid = (n: number): UUID =>
  `${'0'.repeat(8)}-${'0'.repeat(4)}-${'0'.repeat(4)}-${'0'.repeat(4)}-${n.toString().padStart(12, '0')}`;

// Test IDs
export const embeddingTestAgentId = fixedUuid(1);
export const embeddingTestRoomId = fixedUuid(2);
export const embeddingTestEntityId = fixedUuid(3);
export const embeddingTestWorldId = fixedUuid(4);

// Random vector generator for testing
export const generateRandomVector = (size: number): number[] => {
  return Array.from({ length: size }, () => (Math.random() * 2 - 1) * 0.1);
};

export const embeddingTestAgent = {
  id: embeddingTestAgentId,
  name: 'Embedding Test Agent',
  username: 'embedding_test_agent',
  system: 'Test agent system prompt',
  bio: 'An agent for testing embedding functionality',
  enabled: true,
  status: AgentStatus.ACTIVE,
  createdAt: new Date().getTime(),
  updatedAt: new Date().getTime(),
  messageExamples: [],
  postExamples: [],
  topics: [],
  adjectives: [],
  knowledge: [],
  plugins: [],
  settings: {
    dummySetting: 'dummy value',
  },
  style: {
    all: [],
    chat: [],
    post: [],
  },
} as Agent;

// Test Entity
export const embeddingTestEntity: Entity = {
  id: embeddingTestEntityId,
  names: ['Test Entity'],
  agentId: embeddingTestAgentId,
  metadata: {
    description: 'A test entity for embedding tests',
  },
};

// Test Room
export const embeddingTestRoom: Room = {
  id: embeddingTestRoomId,
  name: 'Embedding Test Room',
  agentId: embeddingTestAgentId,
  source: 'test',
  type: ChannelType.DM,
  worldId: embeddingTestWorldId,
};

// Interface that extends Memory to include the type field for the database
export interface TestMemory extends Memory {
  type: string;
}

// Sample test memories
export const embeddingTestMemories: TestMemory[] = [
  {
    id: fixedUuid(10),
    entityId: embeddingTestEntityId,
    agentId: embeddingTestAgentId,
    roomId: embeddingTestRoomId,
    createdAt: new Date().getTime(),
    content: {
      text: 'This is test memory 1',
      type: 'text',
    },
    unique: true,
    type: 'test',
    metadata: { type: 'test' },
  },
  {
    id: fixedUuid(11),
    entityId: embeddingTestEntityId,
    agentId: embeddingTestAgentId,
    roomId: embeddingTestRoomId,
    createdAt: new Date().getTime(),
    content: {
      text: 'This is test memory 2',
      type: 'text',
    },
    unique: true,
    type: 'test',
    metadata: { type: 'test' },
  },
  {
    id: fixedUuid(12),
    entityId: embeddingTestEntityId,
    agentId: embeddingTestAgentId,
    roomId: embeddingTestRoomId,
    createdAt: new Date().getTime(),
    content: {
      text: 'This is test memory 3',
      type: 'text',
    },
    unique: true,
    type: 'test',
    metadata: { type: 'test' },
  },
];

// Sample embeddings of different dimensions
export const embeddingTestData: any[] = [
  {
    id: fixedUuid(30),
    memoryId: embeddingTestMemories[0].id as UUID,
    createdAt: new Date().getTime(),
    dim384: generateRandomVector(384),
  },
  {
    id: fixedUuid(31),
    memoryId: embeddingTestMemories[1].id as UUID,
    createdAt: new Date().getTime(),
    dim512: generateRandomVector(512),
  },
  {
    id: fixedUuid(32),
    memoryId: embeddingTestMemories[2].id as UUID,
    createdAt: new Date().getTime(),
    dim768: generateRandomVector(768),
  },
];

// Memory with embedding
export const embeddingTestMemoriesWithEmbedding: (TestMemory & { embedding: number[] })[] = [
  {
    ...embeddingTestMemories[0],
    embedding: embeddingTestData[0].dim384!,
    metadata: embeddingTestMemories[0].metadata,
  },
  {
    ...embeddingTestMemories[1],
    embedding: embeddingTestData[1].dim512!,
    metadata: embeddingTestMemories[1].metadata,
  },
  {
    ...embeddingTestMemories[2],
    embedding: embeddingTestData[2].dim768!,
    metadata: embeddingTestMemories[2].metadata,
  },
];
