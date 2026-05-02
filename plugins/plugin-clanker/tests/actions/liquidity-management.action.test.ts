import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { liquidityManagementAction } from '../../src/actions/liquidity-management.action';
import { ClankerService } from '../../src/services/clanker.service';
import { WalletService } from '../../src/services/wallet.service';
import { parseUnits } from 'ethers';
import { ClankerError, ErrorCode } from '../../src/utils/errors';

// Mock services
const mockClankerService = {
  addLiquidity: mock(async () => {
    throw new ClankerError(
      ErrorCode.PROTOCOL_ERROR,
      'Liquidity operations not supported by Clanker SDK. Use Uniswap v4 directly or other DEX integration.'
    );
  }),
  removeLiquidity: mock(async () => {
    throw new ClankerError(
      ErrorCode.PROTOCOL_ERROR,
      'Liquidity operations not supported by Clanker SDK. Use Uniswap v4 directly or other DEX integration.'
    );
  }),
};

const mockWalletService = {
  getBalance: mock(async () => parseUnits('1.5', 18)),
  getTokenBalance: mock(async () => ({
    token: '0x' + '2'.repeat(40),
    symbol: 'USDC',
    decimals: 6,
    balance: parseUnits('1000', 6),
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

describe('liquidityManagementAction', () => {
  beforeEach(() => {
    // Clear all mocks
    mockClankerService.addLiquidity.mockClear();
    mockClankerService.removeLiquidity.mockClear();
    mockWalletService.getBalance.mockClear();
    mockWalletService.getTokenBalance.mockClear();
    mockWalletService.getAddress.mockClear();
  });

  describe('validate', () => {
    it('should return true for liquidity-related queries', async () => {
      const liquidityQueries = [
        'add liquidity with 1 ETH and 1000 USDC',
        'provide liquidity to the pool',
        'remove 50% of my liquidity',
        'withdraw liquidity from pool',
        'manage liquidity positions',
        'liquidity pool operations',
      ];

      for (const query of liquidityQueries) {
        const result = await liquidityManagementAction.validate!(
          mockRuntime as any,
          createMemory(query),
          undefined
        );
        expect(result).toBe(true);
      }
    });

    it('should return false for non-liquidity queries', async () => {
      const nonLiquidityQueries = [
        'deploy a token',
        'swap tokens',
        'check balance',
        'hello world',
        'get token info',
      ];

      for (const query of nonLiquidityQueries) {
        const result = await liquidityManagementAction.validate!(
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

      const result = await liquidityManagementAction.validate!(
        runtimeWithoutServices as any,
        createMemory('add liquidity'),
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

      const result = await liquidityManagementAction.validate!(
        runtimeWithError as any,
        createMemory('add liquidity'),
        undefined
      );

      expect(result).toBe(false);
    });
  });

  describe('handler - Add Liquidity (Deprecated)', () => {
    it('should throw error for add liquidity operations', async () => {
      const memory = createMemory('add liquidity with 1 ETH and 1000 USDC to pool');

      const result = await liquidityManagementAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Liquidity operations not supported by Clanker SDK');
      expect(mockClankerService.addLiquidity).toHaveBeenCalled();
    });

    it('should parse add liquidity parameters correctly before throwing error', async () => {
      const tokenA = '0x' + 'a'.repeat(40);
      const tokenB = '0x' + 'b'.repeat(40);
      const memory = createMemory(`add liquidity ${tokenA} and ${tokenB} with 1 ETH and 1000 tokens`);

      const result = await liquidityManagementAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(mockClankerService.addLiquidity).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenA: tokenA,
          tokenB: tokenB,
        })
      );
    });
  });

  describe('handler - Remove Liquidity (Deprecated)', () => {
    it('should throw error for remove liquidity operations', async () => {
      const memory = createMemory('remove 50% of my liquidity from pool');

      const result = await liquidityManagementAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Liquidity operations not supported by Clanker SDK');
      expect(mockClankerService.removeLiquidity).toHaveBeenCalled();
    });

    it('should parse remove liquidity parameters correctly before throwing error', async () => {
      const lpToken = '0x' + 'c'.repeat(40);
      const memory = createMemory(`remove liquidity from ${lpToken} with 100 LP tokens`);

      const result = await liquidityManagementAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(mockClankerService.removeLiquidity).toHaveBeenCalledWith(
        expect.objectContaining({
          lpToken: lpToken,
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

      const memory = createMemory('add liquidity');

      const result = await liquidityManagementAction.handler!(
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

      const memory = createMemory('remove liquidity');

      const result = await liquidityManagementAction.handler!(
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
    it('should call callback with deprecation error message for add liquidity', async () => {
      const callback = mock(() => Promise.resolve());
      const memory = createMemory('add liquidity to pool');

      await liquidityManagementAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        callback
      );

      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ Liquidity management failed'),
        actions: ['MANAGE_LIQUIDITY'],
        source: undefined,
      });
    });

    it('should call callback with deprecation error message for remove liquidity', async () => {
      const callback = mock(() => Promise.resolve());
      const memory = createMemory('remove liquidity from pool');

      await liquidityManagementAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        callback
      );

      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ Liquidity management failed'),
        actions: ['MANAGE_LIQUIDITY'],
        source: undefined,
      });
    });
  });

  describe('parameter parsing', () => {
    it('should extract token addresses from add liquidity queries', async () => {
      const testCases = [
        `add liquidity 0x${'1'.repeat(40)} and 0x${'2'.repeat(40)}`,
        `provide liquidity with 0x${'3'.repeat(40)} 0x${'4'.repeat(40)}`,
        `pool 0x${'5'.repeat(40)} 0x${'6'.repeat(40)} liquidity`,
      ];

      for (const testCase of testCases) {
        const memory = createMemory(testCase);
        await liquidityManagementAction.handler!(
          mockRuntime as any,
          memory,
          undefined,
          {},
          undefined
        );

        expect(mockClankerService.addLiquidity).toHaveBeenCalled();
      }
    });

    it('should extract LP token address from remove liquidity queries', async () => {
      const testCases = [
        `remove liquidity 0x${'1'.repeat(40)}`,
        `withdraw from 0x${'2'.repeat(40)} pool`,
        `remove LP 0x${'3'.repeat(40)}`,
      ];

      for (const testCase of testCases) {
        const memory = createMemory(testCase);
        await liquidityManagementAction.handler!(
          mockRuntime as any,
          memory,
          undefined,
          {},
          undefined
        );

        expect(mockClankerService.removeLiquidity).toHaveBeenCalled();
      }
    });

    it('should extract amounts from liquidity queries', async () => {
      const memory = createMemory('add liquidity with 1.5 ETH and 1000 USDC');

      await liquidityManagementAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(mockClankerService.addLiquidity).toHaveBeenCalledWith(
        expect.objectContaining({
          amountA: expect.any(BigInt),
          amountB: expect.any(BigInt),
        })
      );
    });

    it('should handle percentage-based removal', async () => {
      const lpToken = '0x' + 'd'.repeat(40);
      const memory = createMemory(`remove 75% liquidity from ${lpToken}`);

      await liquidityManagementAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(mockClankerService.removeLiquidity).toHaveBeenCalled();
    });
  });

  describe('error messages', () => {
    it('should provide helpful deprecation message in error response', async () => {
      const memory = createMemory('add liquidity to pool');

      const result = await liquidityManagementAction.handler!(
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
      const memory = createMemory('add liquidity with invalid-address and another-invalid');

      const result = await liquidityManagementAction.handler!(
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

  describe('operation detection', () => {
    it('should correctly identify add liquidity operations', async () => {
      const addLiquidityQueries = [
        'add liquidity',
        'provide liquidity',
        'supply liquidity',
        'deposit into pool',
        'LP add',
      ];

      for (const query of addLiquidityQueries) {
        const memory = createMemory(query);
        await liquidityManagementAction.handler!(
          mockRuntime as any,
          memory,
          undefined,
          {},
          undefined
        );

        expect(mockClankerService.addLiquidity).toHaveBeenCalled();
        mockClankerService.addLiquidity.mockClear();
      }
    });

    it('should correctly identify remove liquidity operations', async () => {
      const removeLiquidityQueries = [
        'remove liquidity',
        'withdraw liquidity',
        'exit pool',
        'LP remove',
        'unstake LP',
      ];

      for (const query of removeLiquidityQueries) {
        const memory = createMemory(query);
        await liquidityManagementAction.handler!(
          mockRuntime as any,
          memory,
          undefined,
          {},
          undefined
        );

        expect(mockClankerService.removeLiquidity).toHaveBeenCalled();
        mockClankerService.removeLiquidity.mockClear();
      }
    });
  });

  describe('backwards compatibility', () => {
    it('should maintain action structure for backwards compatibility', () => {
      expect(liquidityManagementAction.name).toBe('MANAGE_LIQUIDITY');
      expect(liquidityManagementAction.similes).toContain('ADD_LIQUIDITY');
      expect(liquidityManagementAction.similes).toContain('REMOVE_LIQUIDITY');
      expect(liquidityManagementAction.description).toBeDefined();
    });

    it('should have proper examples showing deprecation', () => {
      expect(liquidityManagementAction.examples).toBeDefined();
      expect(liquidityManagementAction.examples!.length).toBeGreaterThan(0);
    });
  });
});
