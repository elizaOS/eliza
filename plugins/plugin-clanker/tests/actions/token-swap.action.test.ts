import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { tokenSwapAction } from '../../src/actions/token-swap.action';
import { ClankerService } from '../../src/services/clanker.service';
import { WalletService } from '../../src/services/wallet.service';
import { parseUnits } from 'ethers';
import { ClankerError, ErrorCode } from '../../src/utils/errors';

// Mock services
const mockClankerService = {
  swapTokens: mock(async () => {
    throw new ClankerError(
      ErrorCode.PROTOCOL_ERROR,
      'Token swapping not supported by Clanker SDK. Use Uniswap v4 directly or other DEX integration.'
    );
  }),
  getTokenInfo: mock(async (address: string) => ({
    address,
    name: 'Test Token',
    symbol: 'TEST',
    decimals: 18,
    totalSupply: parseUnits('1000000', 18),
    price: 1.0,
    priceUsd: 1.0,
    createdAt: Date.now(),
  })),
};

const mockWalletService = {
  getBalance: mock(async () => parseUnits('2.0', 18)),
  getTokenBalance: mock(async (address: string) => ({
    token: address,
    symbol: 'TOKEN',
    decimals: 18,
    balance: parseUnits('1000', 18),
    formattedBalance: '1000.0',
    priceUsd: 1.0,
    valueUsd: 1000.0,
  })),
  getAddress: mock(() => '0x' + '1'.repeat(40)),
};

// Mock runtime
const mockRuntime = {
  getService: (serviceType: string) => {
    if (serviceType === ClankerService.serviceType) {
      return mockClankerService;
    }
    if (serviceType === WalletService.serviceType) {
      return mockWalletService;
    }
    return null;
  },
};

// Mock memory objects
const createMemory = (text: string) => ({
  content: { text },
  userId: 'test-user',
  agentId: 'test-agent',
  roomId: 'test-room',
});

describe('tokenSwapAction', () => {
  beforeEach(() => {
    // Clear all mocks
    mockClankerService.swapTokens.mockClear();
    mockClankerService.getTokenInfo.mockClear();
    mockWalletService.getBalance.mockClear();
    mockWalletService.getTokenBalance.mockClear();
    mockWalletService.getAddress.mockClear();
  });

  describe('validate', () => {
    it('should return true for swap-related queries', async () => {
      const swapQueries = [
        'swap 1 ETH for USDC',
        'trade 1000 USDC for BASE tokens',
        'exchange ETH to tokens',
        'buy tokens with ETH',
        'sell tokens for ETH',
        'convert USDC to ETH',
      ];

      for (const query of swapQueries) {
        const result = await tokenSwapAction.validate!(
          mockRuntime as any,
          createMemory(query),
          undefined
        );
        expect(result).toBe(true);
      }
    });

    it('should return false for non-swap queries', async () => {
      const nonSwapQueries = [
        'deploy a token',
        'check balance',
        'add liquidity',
        'hello world',
        'get token info',
      ];

      for (const query of nonSwapQueries) {
        const result = await tokenSwapAction.validate!(
          mockRuntime as any,
          createMemory(query),
          undefined
        );
        expect(result).toBe(false);
      }
    });

    it('should return false when required services are not available', async () => {
      const runtimeWithoutServices = {
        getService: () => null,
      };

      const result = await tokenSwapAction.validate!(
        runtimeWithoutServices as any,
        createMemory('swap ETH for USDC'),
        undefined
      );

      expect(result).toBe(false);
    });

    it('should handle validation errors gracefully', async () => {
      const runtimeWithError = {
        getService: () => {
          throw new Error('Service error');
        },
      };

      const result = await tokenSwapAction.validate!(
        runtimeWithError as any,
        createMemory('swap tokens'),
        undefined
      );

      expect(result).toBe(false);
    });
  });

  describe('handler - Token Swap (Deprecated)', () => {
    it('should throw error for swap operations', async () => {
      const memory = createMemory('swap 1 ETH for USDC');

      const result = await tokenSwapAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Token swapping not supported by Clanker SDK');
      expect(mockClankerService.swapTokens).toHaveBeenCalled();
    });

    it('should parse swap parameters correctly before throwing error', async () => {
      const fromToken = '0x' + 'a'.repeat(40);
      const toToken = '0x' + 'b'.repeat(40);
      const memory = createMemory(`swap ${fromToken} for ${toToken} with 100 tokens`);

      const result = await tokenSwapAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(mockClankerService.swapTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          fromToken: fromToken,
          toToken: toToken,
        })
      );
    });

    it('should handle ETH to token swaps', async () => {
      const toToken = '0x' + 'c'.repeat(40);
      const memory = createMemory(`swap 1 ETH for ${toToken}`);

      const result = await tokenSwapAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(mockClankerService.swapTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          fromToken: expect.stringMatching(/0x0+/), // WETH address
          toToken: toToken,
        })
      );
    });

    it('should handle token to ETH swaps', async () => {
      const fromToken = '0x' + 'd'.repeat(40);
      const memory = createMemory(`sell ${fromToken} for ETH`);

      const result = await tokenSwapAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(mockClankerService.swapTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          fromToken: fromToken,
          toToken: expect.stringMatching(/0x0+/), // WETH address
        })
      );
    });
  });

  describe('handler - Service availability', () => {
    it('should fail when clanker service is not available', async () => {
      const runtimeWithoutClanker = {
        getService: (serviceType: string) => {
          if (serviceType === ClankerService.serviceType) return null;
          return mockWalletService;
        },
      };

      const memory = createMemory('swap ETH for USDC');

      const result = await tokenSwapAction.handler!(
        runtimeWithoutClanker as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('Required services not available');
    });

    it('should fail when wallet service is not available', async () => {
      const runtimeWithoutWallet = {
        getService: (serviceType: string) => {
          if (serviceType === WalletService.serviceType) return null;
          return mockClankerService;
        },
      };

      const memory = createMemory('trade tokens');

      const result = await tokenSwapAction.handler!(
        runtimeWithoutWallet as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('Required services not available');
    });
  });

  describe('handler - Callback functionality', () => {
    it('should call callback with deprecation error message', async () => {
      const callback = mock(() => Promise.resolve());
      const memory = createMemory('swap 1 ETH for USDC');

      await tokenSwapAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        callback
      );

      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ Token swap failed'),
        actions: ['SWAP_TOKENS'],
        source: undefined,
      });
    });
  });

  describe('parameter parsing', () => {
    it('should extract token addresses from swap queries', async () => {
      const testCases = [
        `swap 0x${'1'.repeat(40)} for 0x${'2'.repeat(40)}`,
        `trade 0x${'3'.repeat(40)} to 0x${'4'.repeat(40)}`,
        `exchange 0x${'5'.repeat(40)} 0x${'6'.repeat(40)}`,
      ];

      for (const testCase of testCases) {
        const memory = createMemory(testCase);
        await tokenSwapAction.handler!(
          mockRuntime as any,
          memory,
          undefined,
          {},
          undefined
        );

        expect(mockClankerService.swapTokens).toHaveBeenCalled();
        mockClankerService.swapTokens.mockClear();
      }
    });

    it('should extract amounts from swap queries', async () => {
      const memory = createMemory('swap 1.5 ETH for USDC');

      await tokenSwapAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(mockClankerService.swapTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: expect.any(BigInt),
        })
      );
    });

    it('should handle different amount formats', async () => {
      const testCases = [
        'swap 1000 tokens',
        'trade 1.5 ETH',
        'exchange 0.001 tokens',
        'swap 1,000,000 tokens',
      ];

      for (const testCase of testCases) {
        const memory = createMemory(testCase);
        await tokenSwapAction.handler!(
          mockRuntime as any,
          memory,
          undefined,
          {},
          undefined
        );

        expect(mockClankerService.swapTokens).toHaveBeenCalled();
        mockClankerService.swapTokens.mockClear();
      }
    });

    it('should parse slippage tolerance when specified', async () => {
      const memory = createMemory('swap 1 ETH for USDC with 1% slippage');

      await tokenSwapAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(mockClankerService.swapTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          slippage: 0.01,
        })
      );
    });
  });

  describe('token symbol handling', () => {
    it('should handle common token symbols', async () => {
      const symbolQueries = [
        'swap ETH for USDC',
        'trade WETH to USDT',
        'exchange BASE for ETH',
        'buy USDC with ETH',
      ];

      for (const query of symbolQueries) {
        const memory = createMemory(query);
        await tokenSwapAction.handler!(
          mockRuntime as any,
          memory,
          undefined,
          {},
          undefined
        );

        expect(mockClankerService.swapTokens).toHaveBeenCalled();
        mockClankerService.swapTokens.mockClear();
      }
    });

    it('should map ETH to WETH address', async () => {
      const memory = createMemory('swap ETH for USDC');

      await tokenSwapAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      const call = mockClankerService.swapTokens.mock.calls[0][0];
      expect(call.fromToken).toMatch(/^0x/);
      expect(call.fromToken).not.toBe('ETH');
    });
  });

  describe('error messages', () => {
    it('should provide helpful deprecation message in error response', async () => {
      const memory = createMemory('swap tokens');

      const result = await tokenSwapAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Use Uniswap v4 directly or other DEX integration');
    });

    it('should handle invalid token addresses gracefully', async () => {
      const memory = createMemory('swap invalid-address for another-invalid');

      const result = await tokenSwapAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      // Should still try to call the service but get parameter validation error
    });
  });

  describe('swap direction detection', () => {
    it('should correctly identify buy operations', async () => {
      const buyQueries = [
        'buy USDC with ETH',
        'purchase tokens using ETH',
        'get BASE with ETH',
      ];

      for (const query of buyQueries) {
        const memory = createMemory(query);
        await tokenSwapAction.handler!(
          mockRuntime as any,
          memory,
          undefined,
          {},
          undefined
        );

        expect(mockClankerService.swapTokens).toHaveBeenCalled();
        mockClankerService.swapTokens.mockClear();
      }
    });

    it('should correctly identify sell operations', async () => {
      const sellQueries = [
        'sell USDC for ETH',
        'dump tokens for ETH',
        'liquidate BASE to ETH',
      ];

      for (const query of sellQueries) {
        const memory = createMemory(query);
        await tokenSwapAction.handler!(
          mockRuntime as any,
          memory,
          undefined,
          {},
          undefined
        );

        expect(mockClankerService.swapTokens).toHaveBeenCalled();
        mockClankerService.swapTokens.mockClear();
      }
    });
  });

  describe('balance checking integration', () => {
    it('should attempt to check balances before swap (deprecated)', async () => {
      const memory = createMemory('swap 1 ETH for USDC');

      await tokenSwapAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      // Should have attempted to check balance before failing
      expect(mockWalletService.getBalance).toHaveBeenCalled();
    });

    it('should check token balance for token-to-token swaps', async () => {
      const fromToken = '0x' + 'e'.repeat(40);
      const memory = createMemory(`swap 100 ${fromToken} for USDC`);

      await tokenSwapAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(mockWalletService.getTokenBalance).toHaveBeenCalledWith(fromToken);
    });
  });

  describe('backwards compatibility', () => {
    it('should maintain action structure for backwards compatibility', () => {
      expect(tokenSwapAction.name).toBe('SWAP_TOKENS');
      expect(tokenSwapAction.similes).toContain('TRADE');
      expect(tokenSwapAction.similes).toContain('EXCHANGE');
      expect(tokenSwapAction.description).toBeDefined();
    });

    it('should have proper examples showing deprecation', () => {
      expect(tokenSwapAction.examples).toBeDefined();
      expect(tokenSwapAction.examples!.length).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty token addresses', async () => {
      const memory = createMemory('swap for tokens');

      const result = await tokenSwapAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
    });

    it('should handle missing amounts', async () => {
      const memory = createMemory('swap ETH for USDC');

      const result = await tokenSwapAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      // Should still attempt the operation with parsed parameters
    });

    it('should handle very large numbers', async () => {
      const memory = createMemory('swap 1000000000000 tokens for ETH');

      const result = await tokenSwapAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(mockClankerService.swapTokens).toHaveBeenCalled();
    });
  });
});
