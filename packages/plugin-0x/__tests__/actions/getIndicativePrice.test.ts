import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getIndicativePrice } from '../../src/actions/getIndicativePrice';
import type { Memory, State, IAgentRuntime, HandlerCallback } from '@elizaos/core';
import { generateObject } from '@elizaos/core';
import { createClientV2 } from '@0x/swap-ts-sdk';
import { EVMTokenRegistry } from '../../src/EVMtokenRegistry';
import { Chains } from '../../src/types';

// Mock dependencies
vi.mock('@elizaos/core', () => ({
  elizaLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
  composeContext: vi.fn(),
  generateObject: vi.fn().mockResolvedValue({
    object: {
      sellTokenSymbol: 'ETH',
      sellAmount: 1,
      buyTokenSymbol: 'USDC',
      chain: 'ethereum',
    },
  }),
  ModelClass: {
    SMALL: 'SMALL',
  },
  MemoryManager: {
    create: vi.fn(),
  },
}));

vi.mock('@0x/swap-ts-sdk', () => ({
  createClientV2: vi.fn().mockReturnValue({
    getIndicativePrice: vi.fn().mockResolvedValue({
      buyAmount: '1000000000000000000',
      sellAmount: '1000000000000000000',
      estimatedPriceImpact: '0.01',
      grossPrice: '1',
      sellTokenToEthRate: '1',
      buyTokenToEthRate: '1',
      permit2: {
        permitData: {},
      },
    }),
  }),
}));

vi.mock('../../src/EVMtokenRegistry', () => ({
  EVMTokenRegistry: {
    getInstance: vi.fn().mockReturnValue({
      isChainSupported: vi.fn().mockReturnValue(true),
      initializeChain: vi.fn().mockResolvedValue(undefined),
      getTokenBySymbol: vi.fn().mockImplementation((chain: string, symbol: string) => ({
        address: `0x${symbol}address`,
        decimals: 18,
        symbol,
      })),
    }),
  },
}));

describe('GET_INDICATIVE_PRICE_0X Action', () => {
  const mockRuntime: Required<Pick<IAgentRuntime, 'getSetting' | 'composeState' | 'updateRecentMessageState'>> = {
    getSetting: vi.fn(),
    composeState: vi.fn(),
    updateRecentMessageState: vi.fn(),
  };

  const mockMessage: Required<Pick<Memory, 'id' | 'content'>> = {
    id: 'test-message-id',
    content: {
      sellTokenSymbol: 'ETH',
      sellAmount: 1,
      buyTokenSymbol: 'USDC',
      chain: 'ethereum',
    },
  };

  const mockState: Required<Pick<State, 'messages' | 'context'>> = {
    messages: [],
    context: {},
  };

  const mockCallback: HandlerCallback = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockRuntime.getSetting.mockImplementation((key: string): string => {
      const settings: Record<string, string> = {
        ZERO_EX_API_KEY: 'test-api-key',
      };
      const value = settings[key];
      if (value === undefined) {
        throw new Error(`Unexpected setting key: ${key}`);
      }
      return value;
    });

    mockRuntime.composeState.mockResolvedValue(mockState);
    mockRuntime.updateRecentMessageState.mockResolvedValue(mockState);
  });

  describe('validate', () => {
    it('should validate successfully with API key', async () => {
      const result = await getIndicativePrice.validate(mockRuntime);
      expect(result).toBe(true);
    });

    it('should fail validation without API key', async () => {
      mockRuntime.getSetting.mockReturnValue(undefined);
      const result = await getIndicativePrice.validate(mockRuntime);
      expect(result).toBe(false);
    });
  });

  describe('handler', () => {
    it('should get indicative price successfully', async () => {
      const result = await getIndicativePrice.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBeDefined();
      expect(createClientV2).toHaveBeenCalledWith({ apiKey: 'test-api-key' });
      expect(mockCallback).toHaveBeenCalled();
    });

    it('should handle invalid chain', async () => {
      vi.mocked(generateObject).mockResolvedValueOnce({
        object: {
          ...mockMessage.content,
          chain: 'invalid-chain',
        },
      });

      await getIndicativePrice.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('Unsupported chain'),
      });
    });

    it('should handle token not found', async () => {
      vi.mocked(EVMTokenRegistry.getInstance).mockReturnValueOnce({
        isChainSupported: vi.fn().mockReturnValue(true),
        initializeChain: vi.fn().mockResolvedValue(undefined),
        getTokenBySymbol: vi.fn().mockReturnValue(null),
      });

      await getIndicativePrice.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('not found'),
      });
    });

    it('should handle 0x API error', async () => {
      vi.mocked(createClientV2).mockReturnValueOnce({
        getIndicativePrice: vi.fn().mockRejectedValue(new Error('API Error')),
      });

      await getIndicativePrice.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(mockCallback).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining('Error getting price'),
        content: expect.objectContaining({
          error: expect.any(String),
        }),
      }));
    });
  });
});
