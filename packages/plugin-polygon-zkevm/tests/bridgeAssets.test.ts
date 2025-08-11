import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { bridgeAssetsAction } from '../src/actions/bridgeAssets';
import type { IAgentRuntime, Memory, State, Content } from '@elizaos/core';

// Mock ethers
vi.mock('ethers', () => ({
  JsonRpcProvider: vi.fn().mockImplementation(() => ({
    waitForTransaction: vi.fn().mockResolvedValue({
      status: 1,
      gasUsed: { toString: () => '150000' },
      blockNumber: 18500000,
      logs: [],
    }),
  })),
  Wallet: vi.fn().mockImplementation(() => ({
    address: '0x1234567890123456789012345678901234567890',
    sendTransaction: vi.fn().mockResolvedValue({
      hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      wait: vi.fn().mockResolvedValue({
        status: 1,
        gasUsed: { toString: () => '150000' },
        blockNumber: 18500000,
        logs: [],
      }),
    }),
  })),
  Contract: vi.fn().mockImplementation(() => ({
    bridgeAsset: vi.fn().mockResolvedValue({
      hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      wait: vi.fn().mockResolvedValue({
        status: 1,
        gasUsed: { toString: () => '150000' },
        blockNumber: 18500000,
        logs: [],
      }),
    }),
    approve: vi.fn().mockResolvedValue({
      hash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      wait: vi.fn().mockResolvedValue({}),
    }),
    allowance: vi.fn().mockResolvedValue(0n),
    decimals: vi.fn().mockResolvedValue(18),
    interface: {
      parseLog: vi.fn().mockReturnValue({
        name: 'BridgeEvent',
        args: {
          depositCount: 12345,
        },
      }),
    },
  })),
  parseEther: vi
    .fn()
    .mockImplementation((value) => BigInt(Math.floor(parseFloat(value) * 10 ** 18))),
  parseUnits: vi.fn().mockImplementation((value, decimals) => {
    if (decimals === 'gwei') return BigInt(Math.floor(parseFloat(value) * 10 ** 9));
    return BigInt(Math.floor(parseFloat(value) * 10 ** Number(decimals)));
  }),
  formatEther: vi.fn().mockImplementation((value) => (Number(value) / 10 ** 18).toString()),
}));

// Mock the LLM helper
vi.mock('../src/utils/llmHelpers', () => ({
  callLLMWithTimeout: vi.fn(),
}));

describe('bridgeAssetsAction', () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;
  let mockCallback: Mock;

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
      content: { text: 'bridge 0.1 ETH from ethereum to polygon zkevm' },
    } as Memory;

    mockState = {} as State;
    mockCallback = vi.fn();
  });

  describe('validate', () => {
    it('should return false when PRIVATE_KEY is missing', async () => {
      (mockRuntime.getSetting as Mock).mockReturnValue(undefined);

      const result = await bridgeAssetsAction.validate(mockRuntime, mockMessage, mockState);

      expect(result).toBe(false);
    });

    it('should return false when both ALCHEMY_API_KEY and ZKEVM_RPC_URL are missing', async () => {
      (mockRuntime.getSetting as Mock).mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return 'test-private-key';
        return undefined;
      });

      const result = await bridgeAssetsAction.validate(mockRuntime, mockMessage, mockState);

      expect(result).toBe(false);
    });

    it('should return true when PRIVATE_KEY and ALCHEMY_API_KEY are provided', async () => {
      (mockRuntime.getSetting as Mock).mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return 'test-private-key';
        if (key === 'ALCHEMY_API_KEY') return 'test-api-key';
        return undefined;
      });

      const result = await bridgeAssetsAction.validate(mockRuntime, mockMessage, mockState);

      expect(result).toBe(true);
    });

    it('should return true when PRIVATE_KEY and ZKEVM_RPC_URL are provided', async () => {
      (mockRuntime.getSetting as Mock).mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return 'test-private-key';
        if (key === 'ZKEVM_RPC_URL') return 'https://zkevm-rpc.com';
        return undefined;
      });

      const result = await bridgeAssetsAction.validate(mockRuntime, mockMessage, mockState);

      expect(result).toBe(true);
    });

    it('should use environment variables as fallback', async () => {
      process.env.PRIVATE_KEY = 'env-private-key';
      process.env.ALCHEMY_API_KEY = 'env-api-key';

      (mockRuntime.getSetting as Mock).mockReturnValue(undefined);

      const result = await bridgeAssetsAction.validate(mockRuntime, mockMessage, mockState);

      expect(result).toBe(true);
    });
  });

  describe('action properties', () => {
    it('should have correct name', () => {
      expect(bridgeAssetsAction.name).toBe('BRIDGE_ASSETS');
    });

    it('should have correct similes', () => {
      expect(bridgeAssetsAction.similes).toEqual([
        'BRIDGE_TOKENS',
        'DEPOSIT_ASSETS',
        'WITHDRAW_ASSETS',
        'BRIDGE_ETH',
        'BRIDGE_ERC20',
      ]);
    });

    it('should have correct description', () => {
      expect(bridgeAssetsAction.description).toBe(
        'Bridges assets (ETH or ERC-20 tokens) between Ethereum and Polygon zkEVM.'
      );
    });

    it('should have examples', () => {
      expect(bridgeAssetsAction.examples).toBeDefined();
      expect(Array.isArray(bridgeAssetsAction.examples)).toBe(true);
      expect(bridgeAssetsAction.examples!.length).toBeGreaterThan(0);
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
        bridgeAssetsAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('PRIVATE_KEY is required for bridging assets.');
    });

    it('should throw error when both API endpoints are missing', async () => {
      (mockRuntime.getSetting as Mock).mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return 'test-private-key';
        return undefined;
      });

      await expect(
        bridgeAssetsAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.');
    });

    it('should handle ETH deposit successfully', async () => {
      const { callLLMWithTimeout } = await import('../src/utils/llmHelpers');
      (callLLMWithTimeout as Mock).mockResolvedValue({
        tokenAddress: null,
        amount: '0.1',
        direction: 'deposit',
      });

      const result = (await bridgeAssetsAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect(result.text).toContain('Successfully deposited 0.1 ETH to Polygon zkEVM!');
      expect((result.data as any).direction).toBe('deposit');
      expect((result.data as any).amount).toBe('0.1');
      expect(mockCallback).toHaveBeenCalled();
    });

    it('should handle ERC20 withdrawal successfully', async () => {
      const { callLLMWithTimeout } = await import('../src/utils/llmHelpers');
      (callLLMWithTimeout as Mock).mockResolvedValue({
        tokenAddress: '0x1234567890123456789012345678901234567890',
        amount: '100',
        direction: 'withdraw',
      });

      const result = (await bridgeAssetsAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect(result.text).toContain('Successfully withdrew 100 tokens from Polygon zkEVM!');
      expect((result.data as any).direction).toBe('withdraw');
      expect((result.data as any).amount).toBe('100');
      expect(mockCallback).toHaveBeenCalled();
    });

    it('should throw error when LLM returns error', async () => {
      const { callLLMWithTimeout } = await import('../src/utils/llmHelpers');
      (callLLMWithTimeout as Mock).mockResolvedValue({
        error: 'Bridge parameters not found',
      });

      await expect(
        bridgeAssetsAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Bridge parameters not found');
    });

    it('should throw error when required parameters are missing', async () => {
      const { callLLMWithTimeout } = await import('../src/utils/llmHelpers');
      (callLLMWithTimeout as Mock).mockResolvedValue({
        tokenAddress: null,
        // missing amount and direction
      });

      await expect(
        bridgeAssetsAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Missing required bridge parameters: amount and direction are required.');
    });

    it('should throw error when direction is invalid', async () => {
      const { callLLMWithTimeout } = await import('../src/utils/llmHelpers');
      (callLLMWithTimeout as Mock).mockResolvedValue({
        tokenAddress: null,
        amount: '0.1',
        direction: 'invalid',
      });

      await expect(
        bridgeAssetsAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Invalid direction. Must be "deposit" or "withdraw".');
    });
  });
});
