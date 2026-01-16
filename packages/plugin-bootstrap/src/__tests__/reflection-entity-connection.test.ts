import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { v4 as uuidv4 } from 'uuid';
import type { UUID } from '@elizaos/core';
import { reflectionEvaluator } from '../evaluators/reflection';
import { createMockRuntime } from './test-utils';

// Import the actual module first
const coreModule = await import('@elizaos/core');

// Mock the getEntityDetails function while preserving other exports
mock.module('@elizaos/core', () => ({
  ...coreModule, // Spread all the actual exports
  getEntityDetails: mock().mockImplementation(() => {
    return Promise.resolve([
      { id: 'test-entity-id', names: ['Test Entity'], metadata: {} },
      { id: 'test-agent-id', names: ['Test Agent'], metadata: {} },
    ]);
  }),
}));

describe('Reflection Evaluator - Entity Connection', () => {
  let mockRuntime: ReturnType<typeof createMockRuntime>;
  let mockMessage: {
    entityId: UUID;
    agentId: UUID;
    roomId: UUID;
    content: { text: string };
  };

  beforeEach(() => {
    mock.restore();
    // Setup mock runtime
    mockRuntime = createMockRuntime({
      character: {
        name: 'TestAgent',
        id: 'test-agent-id' as UUID,
      },
    });

    // Setup mock message - use IDs that match the getEntityDetails mock
    const testRoomId = uuidv4() as UUID;
    const testAgentId = 'test-agent-id' as UUID;
    const testEntityId = 'test-entity-id' as UUID;

    mockMessage = {
      entityId: testEntityId,
      agentId: testAgentId,
      roomId: testRoomId,
      content: { text: 'Test message' },
    };

    // Mock getRoom to return a room with worldId
    mockRuntime.getRoom.mockResolvedValue({
      id: testRoomId,
      worldId: uuidv4() as UUID,
    } as any);

    // Mock ensureConnection
    mockRuntime.ensureConnection.mockResolvedValue(undefined);

    // Mock useModel to return valid reflection XML
    mockRuntime.useModel.mockResolvedValue(`
      <response>
        <thought>Test thought</thought>
        <facts>
          <fact>
            <claim>Test fact about the conversation</claim>
            <type>fact</type>
            <in_bio>false</in_bio>
            <already_known>false</already_known>
          </fact>
        </facts>
        <relationships>
          <relationship>
            <sourceEntityId>${testEntityId}</sourceEntityId>
            <targetEntityId>${testAgentId}</targetEntityId>
            <tags>test_interaction</tags>
          </relationship>
        </relationships>
      </response>
    `);

    // Mock createMemory
    mockRuntime.createMemory.mockResolvedValue(uuidv4() as UUID);

    // Mock queueEmbeddingGeneration
    mockRuntime.queueEmbeddingGeneration.mockResolvedValue(undefined);

    // Mock getRelationships to return empty array
    mockRuntime.getRelationships.mockResolvedValue([]);

    // Mock getMemories to return empty facts
    mockRuntime.getMemories.mockResolvedValue([]);
  });

  afterEach(() => {
    mock.restore();
  });

  it('should log error if room is not found', async () => {
    // Arrange - override the getRoom mock to return null
    mockRuntime.getRoom.mockResolvedValue(null as any);

    // Act
    await reflectionEvaluator.handler(mockRuntime, mockMessage as any, {});

    // Assert - ensureConnection should not be called
    expect(mockRuntime.ensureConnection).not.toHaveBeenCalled();
    // createMemory should not be called
    expect(mockRuntime.createMemory).not.toHaveBeenCalled();
  });
});
