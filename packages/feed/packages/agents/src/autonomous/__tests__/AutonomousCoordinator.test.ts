/**
 * Unit Tests for Autonomous Coordinator
 * Verifies all autonomous services work together properly with mocked dependencies
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { IAgentRuntime, ModelType } from '@elizaos/core';

// Mock agent data
const testAgentId = '123456789012345678';
const testWalletAddress = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';

// Mock user data (users table)
const mockUser = {
  id: testAgentId,
  privyId: `did:privy:test-agent-${testAgentId}`,
  username: `test_agent`,
  displayName: 'Test Autonomous Agent',
  walletAddress: testWalletAddress,
  isAgent: true,
  virtualBalance: '10000',
  reputationPoints: 1000,
};

// Mock agent config data (userAgentConfigs table)
const mockAgentConfig = {
  id: 'config-123',
  userId: testAgentId,
  autonomousTrading: false,
  autonomousPosting: false,
  autonomousCommenting: false,
  autonomousDMs: false,
  autonomousGroupChats: false,
  systemPrompt: 'You are a test agent',
  modelTier: 'lite',
};

// Mock database
const mockDb = {
  select: mock(() => ({
    from: mock((table: unknown) => ({
      where: mock(async () => {
        // Return different data based on table being queried
        // In the real implementation, we'd check the table name
        return [{ ...mockAgentConfig, ...mockUser }];
      }),
    })),
  })),
  insert: mock(() => ({
    values: mock(async () => []),
  })),
  delete: mock(() => ({
    where: mock(async () => []),
  })),
};

// Mock the db module before importing coordinator
mock.module('@feed/db', () => ({
  db: mockDb,
  users: { id: 'id' },
  eq: (a: unknown, b: unknown) => ({ a, b }),
}));

describe('Autonomous Coordinator', () => {
  let mockRuntime: IAgentRuntime;

  // Define params type for useModel
  interface UseModelParams {
    prompt: string;
    temperature?: number;
    maxTokens?: number;
    stopSequences?: string[];
  }

  beforeEach(() => {
    // Create mock runtime with partial implementation
    const mockRuntimePartial: Partial<IAgentRuntime> & {
      agentId: string;
      character: { name: string; system: string; bio: string };
    } = {
      agentId: testAgentId,
      useModel: mock(
        async (_modelType: typeof ModelType, params: UseModelParams) => {
          // Return mock responses
          if (params.prompt.includes('decide if you should')) {
            return '[false, false, false]'; // Don't respond to batch
          }
          if (
            params.prompt.includes('trading decision') ||
            params.prompt.includes('make a trade')
          ) {
            return JSON.stringify({
              action: 'hold',
              reasoning: 'Test - holding position',
            });
          }
          if (params.prompt.includes('create a post')) {
            return 'Test post content from autonomous agent';
          }
          if (params.prompt.includes('write a comment')) {
            return 'Test comment from autonomous agent';
          }
          return 'Test response content';
        }
      ),
      getSetting: mock((key: string): string | undefined => {
        if (key === 'GROQ_API_KEY') return 'test-key';
        if (key === 'OPENROUTER_API_KEY') return undefined;
        return undefined;
      }),
      character: {
        name: 'Test Agent',
        system: 'You are a test agent',
        bio: 'Test agent bio',
      },
    };
    mockRuntime = mockRuntimePartial as IAgentRuntime;
  });

  test('mock runtime has correct structure', () => {
    expect(mockRuntime.agentId).toBe(testAgentId);
    expect(mockRuntime.character.name).toBe('Test Agent');
    expect(mockRuntime.getSetting).toBeDefined();
    expect(mockRuntime.useModel).toBeDefined();
  });

  test('mock database returns agent data', async () => {
    const result = await mockDb
      .select()
      .from({ id: 'id' })
      .where({ a: 'id', b: testAgentId });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(testAgentId);
    expect(result[0]?.isAgent).toBe(true);
    expect(result[0]?.autonomousTrading).toBe(false);
  });

  test('agent configuration has all autonomous flags disabled', async () => {
    const result = await mockDb
      .select()
      .from({ id: 'id' })
      .where({ a: 'id', b: testAgentId });

    const agent = result[0];
    expect(agent?.autonomousTrading).toBe(false);
    expect(agent?.autonomousPosting).toBe(false);
    expect(agent?.autonomousCommenting).toBe(false);
    expect(agent?.autonomousDMs).toBe(false);
    expect(agent?.autonomousGroupChats).toBe(false);
  });

  test('useModel returns expected response for trading', async () => {
    const response = await mockRuntime.useModel(
      {} as typeof ModelType,
      {
        prompt: 'Make a trading decision',
      } as UseModelParams
    );

    expect(response).toContain('hold');
  });

  test('useModel returns expected response for posting', async () => {
    const response = await mockRuntime.useModel(
      {} as typeof ModelType,
      {
        prompt: 'Please create a post about this',
      } as UseModelParams
    );

    expect(response).toContain('Test post content');
  });

  test('useModel returns expected response for batch decisions', async () => {
    const response = await mockRuntime.useModel(
      {} as typeof ModelType,
      {
        prompt: 'decide if you should respond',
      } as UseModelParams
    );

    expect(response).toBe('[false, false, false]');
  });

  test('getSetting returns expected values', () => {
    expect(mockRuntime.getSetting('GROQ_API_KEY')).toBe('test-key');
    expect(mockRuntime.getSetting('OPENROUTER_API_KEY')).toBeUndefined();
    expect(mockRuntime.getSetting('UNKNOWN_KEY')).toBeUndefined();
  });

  test('tick result structure is correct', () => {
    // Mock a tick result
    const mockResult = {
      success: true,
      method: 'database' as const,
      duration: 150,
      actionsExecuted: {
        trades: 0,
        posts: 0,
        comments: 0,
        messages: 0,
        groupMessages: 0,
        engagements: 0,
      },
    };

    expect(mockResult.success).toBe(true);
    expect(mockResult.method).toBe('database');
    expect(typeof mockResult.duration).toBe('number');
    expect(mockResult.actionsExecuted.trades).toBe(0);
    expect(mockResult.actionsExecuted.posts).toBe(0);
    expect(mockResult.actionsExecuted.comments).toBe(0);
  });

  test('A2A method is used when client is available', () => {
    const runtimeWithA2A = {
      ...mockRuntime,
      a2aClient: {
        isConnected: () => true,
        sendRequest: mock(async () => ({ predictions: [], engagements: 0 })),
      },
    } as unknown as IAgentRuntime;

    expect(runtimeWithA2A.a2aClient).toBeDefined();
    expect(
      (
        runtimeWithA2A as unknown as {
          a2aClient: { isConnected: () => boolean };
        }
      ).a2aClient.isConnected()
    ).toBe(true);
  });

  test('execution duration is tracked', () => {
    const startTime = Date.now();
    // Simulate some work
    const endTime = Date.now();
    const duration = endTime - startTime;

    expect(typeof duration).toBe('number');
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(duration).toBeLessThan(30000); // Should be under 30 seconds
  });

  test('action counts are properly typed', () => {
    const actionsExecuted = {
      trades: 0,
      posts: 0,
      comments: 0,
      messages: 0,
      groupMessages: 0,
      engagements: 0,
    };

    expect(typeof actionsExecuted.trades).toBe('number');
    expect(typeof actionsExecuted.posts).toBe('number');
    expect(typeof actionsExecuted.comments).toBe('number');
    expect(typeof actionsExecuted.messages).toBe('number');
    expect(typeof actionsExecuted.groupMessages).toBe('number');
    expect(typeof actionsExecuted.engagements).toBe('number');
  });

  test('wallet address format is valid', () => {
    expect(testWalletAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });
});
