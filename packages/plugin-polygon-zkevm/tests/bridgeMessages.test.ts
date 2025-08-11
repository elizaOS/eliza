import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { bridgeMessagesAction } from '../src/actions/bridgeMessages';
import type { IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import * as llmHelpers from '../src/utils/llmHelpers';

// Mock ethers
vi.mock('ethers', () => ({
  JsonRpcProvider: vi.fn().mockImplementation(() => ({
    getNetwork: vi.fn().mockResolvedValue({ chainId: 1 }),
  })),
  Wallet: vi.fn().mockImplementation(() => ({
    getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
    connect: vi.fn().mockReturnThis(),
  })),
  Contract: vi.fn().mockImplementation(() => ({
    bridgeAsset: Object.assign(
      vi.fn().mockResolvedValue({
        hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        wait: vi.fn().mockResolvedValue({
          blockNumber: 12345,
          gasUsed: BigInt(250000),
          logs: [
            {
              topics: ['0x123'],
              data: '0x456',
            },
          ],
        }),
      }),
      {
        estimateGas: vi.fn().mockResolvedValue(BigInt(300000)),
      }
    ),
    interface: {
      parseLog: vi.fn().mockReturnValue({
        name: 'BridgeEvent',
        args: {
          depositCount: 123,
        },
      }),
    },
  })),
  parseEther: vi.fn().mockImplementation((value) => {
    // Handle string inputs properly
    const numValue = typeof value === 'string' ? parseFloat(value) : value;
    return BigInt(Math.floor(numValue * 10 ** 18));
  }),
  parseUnits: vi.fn().mockImplementation((value, unit) => {
    const numValue = typeof value === 'string' ? parseFloat(value) : value;
    if (unit === 'gwei') return BigInt(Math.floor(numValue * 10 ** 9));
    return BigInt(numValue);
  }),
}));

// Mock the LLM helper
vi.mock('../src/utils/llmHelpers', () => ({
  callLLMWithTimeout: vi.fn(),
}));

// Mock logger
vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual('@elizaos/core');
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  };
});

describe('bridgeMessagesAction', () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;
  let mockCallback: HandlerCallback;
  let callLLMWithTimeoutMock: Mock;

  beforeEach(() => {
    vi.clearAllMocks();

    // Clear environment variables
    delete process.env.PRIVATE_KEY;
    delete process.env.ALCHEMY_API_KEY;
    delete process.env.ZKEVM_RPC_URL;

    mockRuntime = {
      getSetting: vi.fn(),
    } as unknown as IAgentRuntime;

    mockMessage = {
      content: { text: 'Bridge message to ethereum with data 0x1234' },
    } as Memory;

    mockState = {} as State;
    mockCallback = vi.fn();

    // Get the mocked function using vi.mocked
    callLLMWithTimeoutMock = vi.mocked(llmHelpers.callLLMWithTimeout);
  });

  describe('validate', () => {
    it('should return false when PRIVATE_KEY is missing', async () => {
      (mockRuntime.getSetting as Mock).mockReturnValue(undefined);

      const result = await bridgeMessagesAction.validate(mockRuntime, mockMessage, mockState);

      expect(result).toBe(false);
    });

    it('should return false when both ALCHEMY_API_KEY and ZKEVM_RPC_URL are missing', async () => {
      (mockRuntime.getSetting as Mock).mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return 'test-private-key';
        return undefined;
      });

      const result = await bridgeMessagesAction.validate(mockRuntime, mockMessage, mockState);

      expect(result).toBe(false);
    });

    it('should return true when PRIVATE_KEY and ALCHEMY_API_KEY are provided', async () => {
      (mockRuntime.getSetting as Mock).mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return 'test-private-key';
        if (key === 'ALCHEMY_API_KEY') return 'test-api-key';
        return undefined;
      });

      const result = await bridgeMessagesAction.validate(mockRuntime, mockMessage, mockState);

      expect(result).toBe(true);
    });

    it('should return true when PRIVATE_KEY and ZKEVM_RPC_URL are provided', async () => {
      (mockRuntime.getSetting as Mock).mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return 'test-private-key';
        if (key === 'ZKEVM_RPC_URL') return 'https://test-rpc.com';
        return undefined;
      });

      const result = await bridgeMessagesAction.validate(mockRuntime, mockMessage, mockState);

      expect(result).toBe(true);
    });

    it('should use environment variables as fallback', async () => {
      process.env.PRIVATE_KEY = 'env-private-key';
      process.env.ALCHEMY_API_KEY = 'env-api-key';

      (mockRuntime.getSetting as Mock).mockReturnValue(undefined);

      const result = await bridgeMessagesAction.validate(mockRuntime, mockMessage, mockState);

      expect(result).toBe(true);
    });
  });

  describe('handler', () => {
    beforeEach(() => {
      (mockRuntime.getSetting as Mock).mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return 'test-private-key';
        if (key === 'ALCHEMY_API_KEY') return 'test-api-key';
        return undefined;
      });
    });

    it('should throw error when PRIVATE_KEY is missing', async () => {
      (mockRuntime.getSetting as Mock).mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return undefined;
        if (key === 'ALCHEMY_API_KEY') return 'test-api-key';
        return undefined;
      });

      await expect(
        bridgeMessagesAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('PRIVATE_KEY is required for bridging messages.');
    });

    it('should throw error when both API endpoints are missing', async () => {
      (mockRuntime.getSetting as Mock).mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return 'test-private-key';
        return undefined;
      });

      await expect(
        bridgeMessagesAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.');
    });

    it('should throw error when LLM returns error', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        error: 'Bridge message parameters not found.',
      });

      await expect(
        bridgeMessagesAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Bridge message parameters not found.');
    });

    it('should throw error when required parameters are missing', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        destinationChain: 'ethereum',
        // missing messageData
      });

      await expect(
        bridgeMessagesAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow(
        'Missing required message parameters: destinationChain and messageData are required.'
      );
    });

    it('should throw error when destination chain is invalid', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        destinationChain: 'invalid-chain',
        messageData: '0x1234',
      });

      await expect(
        bridgeMessagesAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Invalid destination chain. Must be "ethereum" or "zkevm".');
    });

    it('should throw error when message data is invalid format', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        destinationChain: 'ethereum',
        messageData: 'invalid-hex',
      });

      await expect(
        bridgeMessagesAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Message data must be valid hex string starting with 0x.');
    });

    it('should successfully bridge message from zkEVM to Ethereum', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        destinationChain: 'ethereum',
        messageData: '0x1234567890abcdef',
      });

      const result = await bridgeMessagesAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect((result as any).data.success).toBe(true);
      expect((result as any).data.transactionHash).toBe(
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
      );
      expect((result as any).data.sourceNetwork).toBe('zkEVM');
      expect((result as any).data.destinationChain).toBe('ethereum');
      expect((result as any).data.messageData).toBe('0x1234567890abcdef');
      expect((result as any).data.messageId).toBe('zkEVM-0-123');
      expect(mockCallback).toHaveBeenCalledWith(result);
    });

    it('should successfully bridge message from Ethereum to zkEVM', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        destinationChain: 'zkevm',
        messageData: '0xabcdef1234567890',
      });

      const result = await bridgeMessagesAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect((result as any).data.success).toBe(true);
      expect((result as any).data.sourceNetwork).toBe('Ethereum');
      expect((result as any).data.destinationChain).toBe('zkevm');
      expect((result as any).data.messageData).toBe('0xabcdef1234567890');
    });

    it('should handle message bridging with ETH value', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        destinationChain: 'ethereum',
        messageData: '0x1234',
        value: '0.1',
      });

      const result = await bridgeMessagesAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect((result as any).data.success).toBe(true);
      expect((result as any).data.messageData).toBe('0x1234');
    });

    it('should handle message bridging with custom gas parameters', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        destinationChain: 'ethereum',
        messageData: '0x1234',
        gasLimit: '500000',
        maxFeePerGas: '20',
        maxPriorityFeePerGas: '2',
      });

      const result = await bridgeMessagesAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect((result as any).data.success).toBe(true);
    });

    it('should handle message bridging with legacy gas pricing', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        destinationChain: 'ethereum',
        messageData: '0x1234',
        gasPrice: '20',
      });

      const result = await bridgeMessagesAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect((result as any).data.success).toBe(true);
    });

    it('should handle bridge transaction failure', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        destinationChain: 'ethereum',
        messageData: '0x1234',
      });

      // Mock the Contract constructor to return a contract with failing bridgeAsset
      const { Contract } = await import('ethers');
      const mockContractInstance = {
        bridgeAsset: Object.assign(vi.fn().mockRejectedValue(new Error('Transaction failed')), {
          estimateGas: vi.fn().mockResolvedValue(BigInt(300000)),
        }),
        interface: {
          parseLog: vi.fn().mockReturnValue({
            name: 'BridgeEvent',
            args: { depositCount: 123 },
          }),
        },
      };

      vi.mocked(Contract).mockImplementationOnce(() => mockContractInstance as any);

      await expect(
        bridgeMessagesAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Failed to bridge message: Transaction failed');
    });

    it('should handle gas estimation failure gracefully', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        destinationChain: 'ethereum',
        messageData: '0x1234',
      });

      // Mock the Contract constructor to return a contract with failing gas estimation
      const { Contract } = await import('ethers');
      const mockContractInstance = {
        bridgeAsset: Object.assign(
          vi.fn().mockResolvedValue({
            hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
            wait: vi.fn().mockResolvedValue({
              blockNumber: 12345,
              gasUsed: BigInt(250000),
              logs: [{ topics: ['0x123'], data: '0x456' }],
            }),
          }),
          {
            estimateGas: vi.fn().mockRejectedValue(new Error('Gas estimation failed')),
          }
        ),
        interface: {
          parseLog: vi.fn().mockReturnValue({
            name: 'BridgeEvent',
            args: { depositCount: 123 },
          }),
        },
      };

      vi.mocked(Contract).mockImplementationOnce(() => mockContractInstance as any);

      const result = await bridgeMessagesAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect((result as any).data.success).toBe(true);
    });

    it('should handle missing message ID in transaction logs', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        destinationChain: 'ethereum',
        messageData: '0x1234',
      });

      // Mock the Contract constructor to return a contract with null parseLog result
      const { Contract } = await import('ethers');
      const mockContractInstance = {
        bridgeAsset: Object.assign(
          vi.fn().mockResolvedValue({
            hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
            wait: vi.fn().mockResolvedValue({
              blockNumber: 12345,
              gasUsed: BigInt(250000),
              logs: [{ topics: ['0x123'], data: '0x456' }],
            }),
          }),
          {
            estimateGas: vi.fn().mockResolvedValue(BigInt(300000)),
          }
        ),
        interface: {
          parseLog: vi.fn().mockReturnValue(null),
        },
      };

      vi.mocked(Contract).mockImplementationOnce(() => mockContractInstance as any);

      const result = await bridgeMessagesAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect((result as any).data.success).toBe(true);
      expect((result as any).data.messageId).toBeNull();
    });
  });

  describe('action properties', () => {
    it('should have correct action name', () => {
      expect(bridgeMessagesAction.name).toBe('BRIDGE_MESSAGES');
    });

    it('should have correct similes', () => {
      expect(bridgeMessagesAction.similes).toEqual([
        'SEND_MESSAGE',
        'CROSS_CHAIN_MESSAGE',
        'BRIDGE_CALLDATA',
        'SEND_CROSS_CHAIN_MESSAGE',
        'MESSAGE_BRIDGE',
      ]);
    });

    it('should have correct description', () => {
      expect(bridgeMessagesAction.description).toBe(
        'Sends arbitrary calldata messages between Ethereum and Polygon zkEVM using the bridge contract.'
      );
    });
  });
});
