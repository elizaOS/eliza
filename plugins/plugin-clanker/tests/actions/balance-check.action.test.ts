import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { balanceCheckAction } from '../../src/actions/balance-check.action';
import { WalletService } from '../../src/services/wallet.service';
import { ClankerService } from '../../src/services/clanker.service';
import { parseUnits } from 'ethers';

// Mock services
const mockWalletService = {
  getBalance: mock(async () => parseUnits('1.5', 18)),
  getTokenBalance: mock(async (address: string) => ({
    token: address,
    symbol: 'TEST',
    decimals: 18,
    balance: parseUnits('1000', 18),
    formattedBalance: '1000.0',
    priceUsd: 1.0,
    valueUsd: 1000.0,
  })),
  getAddress: mock(() => '0x' + '1'.repeat(40)),
};

const mockClankerService = {
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

// Mock runtime
const mockRuntime = {
  getService: (serviceType: string) => {
    if (serviceType === WalletService.serviceType) {
      return mockWalletService;
    }
    if (serviceType === ClankerService.serviceType) {
      return mockClankerService;
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

describe('balanceCheckAction', () => {
  beforeEach(() => {
    // Clear all mocks
    mockWalletService.getBalance.mockClear();
    mockWalletService.getTokenBalance.mockClear();
    mockWalletService.getAddress.mockClear();
    mockClankerService.getTokenInfo.mockClear();
  });

  describe('validate', () => {
    it('should return true for balance-related queries', async () => {
      const balanceQueries = [
        'check my balance',
        'what is my wallet balance',
        'show my holdings',
        'check portfolio',
        'wallet status',
        'how much do I have',
      ];

      for (const query of balanceQueries) {
        const result = await balanceCheckAction.validate!(
          mockRuntime as any,
          createMemory(query),
          undefined
        );
        expect(result).toBe(true);
      }
    });

    it('should return false for non-balance queries', async () => {
      const nonBalanceQueries = [
        'deploy a token',
        'swap tokens',
        'add liquidity',
        'hello world',
      ];

      for (const query of nonBalanceQueries) {
        const result = await balanceCheckAction.validate!(
          mockRuntime as any,
          createMemory(query),
          undefined
        );
        expect(result).toBe(false);
      }
    });

    it('should return false when wallet service is not available', async () => {
      const runtimeWithoutService = {
        getService: () => null,
      };

      const result = await balanceCheckAction.validate!(
        runtimeWithoutService as any,
        createMemory('check balance'),
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

      const result = await balanceCheckAction.validate!(
        runtimeWithError as any,
        createMemory('check balance'),
        undefined
      );

      expect(result).toBe(false);
    });
  });

  describe('handler - ETH balance', () => {
    it('should check ETH balance successfully', async () => {
      const memory = createMemory('check my balance');

      const result = await balanceCheckAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(true);
      expect(result.text).toContain('💰 Wallet Balance');
      expect(result.text).toContain('1.5 ETH');
      expect(mockWalletService.getBalance).toHaveBeenCalledTimes(1);
    });

    it('should handle zero ETH balance', async () => {
      mockWalletService.getBalance.mockResolvedValueOnce(0n);
      const memory = createMemory('check balance');

      const result = await balanceCheckAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(true);
      expect(result.text).toContain('0.0 ETH');
    });
  });

  describe('handler - Token balance', () => {
    it('should check specific token balance with valid address', async () => {
      const tokenAddress = '0x' + 'a'.repeat(40);
      const memory = createMemory(`check balance of ${tokenAddress}`);

      const result = await balanceCheckAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(true);
      expect(result.text).toContain('Token Balance');
      expect(result.text).toContain('Test Token (TEST)');
      expect(result.text).toContain('1000.0 TEST');
      expect(result.text).toContain('$1,000.00');
      expect(mockWalletService.getTokenBalance).toHaveBeenCalledWith(tokenAddress);
    });

    it('should handle invalid token address', async () => {
      const memory = createMemory('check balance of invalid-address');

      const result = await balanceCheckAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle token balance query failure', async () => {
      const tokenAddress = '0x' + 'b'.repeat(40);
      mockWalletService.getTokenBalance.mockRejectedValueOnce(new Error('Token not found'));

      const memory = createMemory(`check balance of ${tokenAddress}`);

      const result = await balanceCheckAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Token not found');
    });
  });

  describe('handler - Service availability', () => {
    it('should fail when wallet service is not available', async () => {
      const runtimeWithoutWallet = {
        getService: (serviceType: string) => {
          if (serviceType === WalletService.serviceType) return null;
          return mockClankerService;
        },
      };

      const memory = createMemory('check balance');

      const result = await balanceCheckAction.handler!(
        runtimeWithoutWallet as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('Required services not available');
    });

    it('should fail when clanker service is not available for token queries', async () => {
      const runtimeWithoutClanker = {
        getService: (serviceType: string) => {
          if (serviceType === WalletService.serviceType) return mockWalletService;
          return null;
        },
      };

      const tokenAddress = '0x' + 'c'.repeat(40);
      const memory = createMemory(`check balance of ${tokenAddress}`);

      const result = await balanceCheckAction.handler!(
        runtimeWithoutClanker as any,
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
    it('should call callback with formatted response', async () => {
      const callback = mock(() => Promise.resolve());
      const memory = createMemory('check my balance');

      await balanceCheckAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        callback
      );

      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining('💰 Wallet Balance'),
        actions: ['CHECK_BALANCE'],
        source: undefined,
      });
    });

    it('should call callback with error message on failure', async () => {
      const callback = mock(() => Promise.resolve());
      mockWalletService.getBalance.mockRejectedValueOnce(new Error('Network error'));
      const memory = createMemory('check balance');

      await balanceCheckAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        callback
      );

      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ Failed to check balance'),
        actions: ['CHECK_BALANCE'],
        source: undefined,
      });
    });
  });

  describe('address parsing', () => {
    it('should extract token address from various formats', async () => {
      const testCases = [
        `balance of 0x${'1'.repeat(40)}`,
        `check 0x${'2'.repeat(40)} balance`,
        `what is my 0x${'3'.repeat(40)} holdings`,
      ];

      for (const testCase of testCases) {
        const memory = createMemory(testCase);
        await balanceCheckAction.handler!(
          mockRuntime as any,
          memory,
          undefined,
          {},
          undefined
        );

        expect(mockWalletService.getTokenBalance).toHaveBeenCalled();
      }
    });

    it('should handle multiple addresses and use the first valid one', async () => {
      const memory = createMemory(`check balance of 0x${'1'.repeat(40)} and 0x${'2'.repeat(40)}`);

      await balanceCheckAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(mockWalletService.getTokenBalance).toHaveBeenCalledWith('0x' + '1'.repeat(40));
    });
  });

  describe('response formatting', () => {
    it('should include wallet address in response', async () => {
      const memory = createMemory('check balance');

      const result = await balanceCheckAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.text).toContain('Wallet: 0x1111...1111');
    });

    it('should format large numbers correctly', async () => {
      mockWalletService.getBalance.mockResolvedValueOnce(parseUnits('1234.56789', 18));
      const memory = createMemory('check balance');

      const result = await balanceCheckAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.text).toContain('1234.568 ETH'); // Should be rounded appropriately
    });
  });

  describe('error handling', () => {
    it('should handle wallet service errors', async () => {
      mockWalletService.getBalance.mockRejectedValueOnce(new Error('Connection timeout'));
      const memory = createMemory('check balance');

      const result = await balanceCheckAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle clanker service errors for token info', async () => {
      mockClankerService.getTokenInfo.mockRejectedValueOnce(new Error('Token not found'));
      const tokenAddress = '0x' + 'd'.repeat(40);
      const memory = createMemory(`balance of ${tokenAddress}`);

      const result = await balanceCheckAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
    });
  });
});
