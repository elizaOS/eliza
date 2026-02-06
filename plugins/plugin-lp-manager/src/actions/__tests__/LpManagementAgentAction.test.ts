import { describe, it, expect } from 'vitest';
import { LpManagementAgentAction } from '../LpManagementAgentAction.ts';
import type { Memory, IAgentRuntime, State, UUID, Content } from '@elizaos/core';
import { ChannelType } from '@elizaos/core';

/**
 * Creates a test Memory object with LP-related content
 */
function createTestMemory(text: string, overrides: Partial<Content> = {}): Memory {
  return {
    id: "test-memory-id" as UUID,
    roomId: "test-room-id" as UUID,
    entityId: "test-entity-id" as UUID,
    agentId: "test-agent-id" as UUID,
    content: {
      text,
      channelType: ChannelType.DM,
      ...overrides,
    },
    createdAt: Date.now(),
  };
}

/**
 * Creates a minimal test runtime for action validation
 */
function createTestRuntime(): IAgentRuntime {
  return {
    agentId: "test-agent-id" as UUID,
    getService: () => null,
    getSetting: () => null,
  } as unknown as IAgentRuntime;
}

/**
 * Creates a test State object
 */
function createTestState(): State {
  return {
    values: {},
    data: {},
    text: "",
  };
}

describe('LpManagementAgentAction', () => {
  it('should have a name and description', () => {
    expect(LpManagementAgentAction.name).toBe('lp_management');
    expect(LpManagementAgentAction.description).toContain('Manages Liquidity Pool (LP) operations');
  });

  it('should validate an intent', async () => {
    const testRuntime = createTestRuntime();
    const testMessage = createTestMemory('I want to add liquidity to a pool', {
      intent: 'deposit_lp',
      userId: 'test-user',
    });
    const testState = createTestState();
    
    const result = await LpManagementAgentAction.validate?.(testRuntime, testMessage, testState);
    expect(result).toBe(true);
  });
});
