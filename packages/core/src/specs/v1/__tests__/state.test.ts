import { describe, expect, it } from 'bun:test';
import { State } from '../state';
import { UUID } from '../types';

// Define StateV2 interface for testing
interface StateV2 {
  values: { [key: string]: any };
  data: { [key: string]: any };
  text: string;
  [key: string]: any;
}

// Import the conversion functions
import { fromV2State, toV2State } from '../state';

// Helper function to create valid UUIDs for testing
const createTestUUID = (num: number): UUID => {
  return `00000000-0000-0000-0000-${num.toString().padStart(12, '0')}`;
};

// Create memory data for testing that matches expected structure
const emptyMemoryData = [
  {
    id: createTestUUID(1),
    roomId: createTestUUID(3),
    userId: createTestUUID(4),
    agentId: createTestUUID(5),
    content: {
      text: 'Test message',
    },
  },
];

describe('State adapter', () => {
  it('should convert from v2 state to v1 state correctly', () => {
    // Arrange
    const stateV2: StateV2 = {
      values: {
        userId: createTestUUID(123),
        agentName: 'TestAgent',
      },
      data: {
        walletBalance: 100,
        tokenPrices: { ETH: 2000 },
      },
      text: 'Current state information',
    };

    // Act
    const stateV1 = fromV2State(stateV2);

    // Assert
    expect(stateV1.userId).toBe(createTestUUID(123));
    expect(stateV1.agentName).toBe('TestAgent');
    expect(stateV1.walletBalance).toBe(100);
    expect(stateV1.tokenPrices).toEqual({ ETH: 2000 });
    expect(stateV1.text).toBe('Current state information');
    // Check that default properties are set
    expect(stateV1.bio).toBe('');
    expect(stateV1.lore).toBe('');
    expect(stateV1.messageDirections).toBe('');
    expect(stateV1.postDirections).toBe('');
    expect(stateV1.recentMessagesData).toEqual([]);
    expect(stateV1.actors).toBe('');
  });

  it('should convert from v1 state to v2 state correctly', () => {
    // Arrange
    const stateV1: State = {
      userId: createTestUUID(123),
      agentName: 'TestAgent',
      walletBalance: 100,
      tokenPrices: { ETH: 2000 },
      text: 'Current state information',
      recentMessages: 'Some recent messages',
      recentMessagesData: emptyMemoryData,
      bio: 'Agent bio',
      lore: 'Agent lore',
      messageDirections: 'Handle messages this way',
      postDirections: 'Handle posts this way',
      roomId: createTestUUID(456),
      actors: 'User, Agent',
    };

    // Act
    const stateV2 = toV2State(stateV1);

    // Assert
    expect(stateV2.values).toBeDefined();
    expect(stateV2.data).toBeDefined();
    expect(stateV2.text).toBe('Current state information');

    // The original properties should be preserved
    expect(stateV2.userId).toBe(createTestUUID(123));
    expect(stateV2.agentName).toBe('TestAgent');
    expect(stateV2.bio).toBe('Agent bio');
    expect(stateV2.lore).toBe('Agent lore');
    expect(stateV2.recentMessagesData).toEqual(emptyMemoryData);
  });

  it('should handle empty or undefined values', () => {
    // Arrange
    const emptyV2: StateV2 = {
      values: {},
      data: {},
      text: '',
    };

    // Act
    const emptyV1 = fromV2State(emptyV2);
    const backToV2 = toV2State(emptyV1);

    // Assert
    expect(emptyV1).toEqual({
      bio: '',
      lore: '',
      messageDirections: '',
      postDirections: '',
      actors: '',
      recentMessages: '',
      recentMessagesData: [],
      text: '',
    });

    expect(backToV2).toEqual({
      values: {},
      data: {},
      text: '',
      bio: '',
      lore: '',
      messageDirections: '',
      postDirections: '',
      actors: '',
      recentMessages: '',
      recentMessagesData: [],
    });
  });

  it('should handle additional properties from real-world plugins', () => {
    // Example from plugin-ton (row 102 in CSV)
    const tonStateV1: State = {
      userId: createTestUUID(123),
      agentName: 'TonBot',
      walletAddress: '0x123abc',
      walletBalance: 10.5,
      stakedAmount: 5.25,
      lastTransaction: '2023-04-01',
      roomId: createTestUUID(456),
      recentMessages: 'Recent messages here',
      recentMessagesData: emptyMemoryData,
      bio: 'TON blockchain assistant',
      lore: 'Helps with TON transactions',
      messageDirections: 'Handle DMs from users',
      postDirections: 'Post updates about TON',
      actors: 'User, TonBot',
      text: 'Current state',
    };

    // Convert to v2 and back
    const tonStateV2 = toV2State(tonStateV1);
    const tonStateV1Again = fromV2State(tonStateV2);

    // Original properties should be preserved through the round trip
    expect(tonStateV1Again.walletAddress).toBe('0x123abc');
    expect(tonStateV1Again.walletBalance).toBe(10.5);
    expect(tonStateV1Again.stakedAmount).toBe(5.25);
    expect(tonStateV1Again.lastTransaction).toBe('2023-04-01');
    expect(tonStateV1Again.recentMessagesData).toEqual(emptyMemoryData);
  });
});
