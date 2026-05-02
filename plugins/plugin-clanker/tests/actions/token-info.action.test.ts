import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { tokenInfoAction } from '../../src/actions/token-info.action';
import { ClankerService } from '../../src/services/clanker.service';
import { WalletService } from '../../src/services/wallet.service';
import { parseUnits } from 'ethers';

// Mock services
const mockClankerService = {
  getTokenInfo: mock(async (address: string) => ({
    address,
    name: 'Test Token',
    symbol: 'TEST',
    decimals: 18,
    totalSupply: parseUnits('1000000', 18),
    price: 1.25,
    priceUsd: 1.25,
    volume24h: parseUnits('50000', 18),
    holders: 1500,
    liquidity: parseUnits('100000', 18),
    marketCap: 1250000n,
    createdAt: Date.now() - 86400000, // 1 day ago
    creator: '0x' + '9'.repeat(40),
  })),
  getCachedTokenInfo: mock(() => null),
};

const mockWalletService = {
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

describe('tokenInfoAction', () => {
  beforeEach(() => {
    // Clear all mocks
    mockClankerService.getTokenInfo.mockClear();
    mockClankerService.getCachedTokenInfo.mockClear();
    mockWalletService.getAddress.mockClear();
  });

  describe('validate', () => {
    it('should return true for token info queries', async () => {
      const tokenInfoQueries = [
        'get info for token 0x1234567890abcdef1234567890abcdef12345678',
        'what is the price of 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        'token information for 0x' + 'a'.repeat(40),
        'show me details about 0x' + 'b'.repeat(40),
        'info on token 0x' + 'c'.repeat(40),
        'check token 0x' + 'd'.repeat(40),
      ];

      for (const query of tokenInfoQueries) {
        const result = await tokenInfoAction.validate!(
          mockRuntime as any,
          createMemory(query),
          undefined
        );
        expect(result).toBe(true);
      }
    });

    it('should return true for queries with token symbols', async () => {
      const symbolQueries = [
        'what is BASE token info',
        'get USDC price',
        'check WETH information',
        'show ETH details',
      ];

      for (const query of symbolQueries) {
        const result = await tokenInfoAction.validate!(
          mockRuntime as any,
          createMemory(query),
          undefined
        );
        expect(result).toBe(true);
      }
    });

    it('should return false for non-token-info queries', async () => {
      const nonTokenInfoQueries = [
        'deploy a token',
        'swap tokens',
        'check balance',
        'hello world',
        'add liquidity',
      ];

      for (const query of nonTokenInfoQueries) {
        const result = await tokenInfoAction.validate!(
          mockRuntime as any,
          createMemory(query),
          undefined
        );
        expect(result).toBe(false);
      }
    });

    it('should return false when clanker service is not available', async () => {
      const runtimeWithoutService = {
        getService: () => null,
      };

      const result = await tokenInfoAction.validate!(
        runtimeWithoutService as any,
        createMemory('get token info for 0x' + '1'.repeat(40)),
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

      const result = await tokenInfoAction.validate!(
        runtimeWithError as any,
        createMemory('token info'),
        undefined
      );

      expect(result).toBe(false);
    });
  });

  describe('handler - Token address queries', () => {
    it('should get token info with valid address', async () => {
      const tokenAddress = '0x' + 'a'.repeat(40);
      const memory = createMemory(`get info for token ${tokenAddress}`);

      const result = await tokenInfoAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(true);
      expect(result.text).toContain('📊 Token Information');
      expect(result.text).toContain('Test Token (TEST)');
      expect(result.text).toContain('$1.25');
      expect(result.text).toContain('1,000,000');
      expect(mockClankerService.getTokenInfo).toHaveBeenCalledWith(tokenAddress);
    });

    it('should handle token with no market data', async () => {
      mockClankerService.getTokenInfo.mockResolvedValueOnce({
        address: '0x' + 'b'.repeat(40),
        name: 'New Token',
        symbol: 'NEW',
        decimals: 18,
        totalSupply: parseUnits('1000000', 18),
        price: 0,
        priceUsd: 0,
        volume24h: 0n,
        holders: 0,
        liquidity: 0n,
        marketCap: 0n,
        createdAt: Date.now(),
      });

      const tokenAddress = '0x' + 'b'.repeat(40);
      const memory = createMemory(`info for ${tokenAddress}`);

      const result = await tokenInfoAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(true);
      expect(result.text).toContain('New Token (NEW)');
      expect(result.text).toContain('Price: Not available');
      expect(result.text).toContain('Market Cap: Not available');
    });

    it('should handle invalid token address', async () => {
      const memory = createMemory('get info for token invalid-address');

      const result = await tokenInfoAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Invalid token address');
    });

    it('should handle token not found error', async () => {
      mockClankerService.getTokenInfo.mockRejectedValueOnce(new Error('Token not found'));
      const tokenAddress = '0x' + 'c'.repeat(40);
      const memory = createMemory(`info for ${tokenAddress}`);

      const result = await tokenInfoAction.handler!(
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
    it('should fail when clanker service is not available', async () => {
      const runtimeWithoutClanker = {
        getService: (serviceType: string) => {
          if (serviceType === ClankerService.serviceType) return null;
          return mockWalletService;
        },
      };

      const tokenAddress = '0x' + 'd'.repeat(40);
      const memory = createMemory(`token info ${tokenAddress}`);

      const result = await tokenInfoAction.handler!(
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
      const tokenAddress = '0x' + 'e'.repeat(40);
      const memory = createMemory(`get token info for ${tokenAddress}`);

      await tokenInfoAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        callback
      );

      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining('📊 Token Information'),
        actions: ['GET_TOKEN_INFO'],
        source: undefined,
      });
    });

    it('should call callback with error message on failure', async () => {
      const callback = mock(() => Promise.resolve());
      mockClankerService.getTokenInfo.mockRejectedValueOnce(new Error('Network error'));
      const tokenAddress = '0x' + 'f'.repeat(40);
      const memory = createMemory(`token info ${tokenAddress}`);

      await tokenInfoAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        callback
      );

      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ Failed to get token information'),
        actions: ['GET_TOKEN_INFO'],
        source: undefined,
      });
    });
  });

  describe('address parsing', () => {
    it('should extract token address from various formats', async () => {
      const testCases = [
        `info for token 0x${'1'.repeat(40)}`,
        `get 0x${'2'.repeat(40)} details`,
        `what about 0x${'3'.repeat(40)} price`,
        `check token 0x${'4'.repeat(40)} information`,
      ];

      for (const testCase of testCases) {
        const memory = createMemory(testCase);
        await tokenInfoAction.handler!(
          mockRuntime as any,
          memory,
          undefined,
          {},
          undefined
        );

        expect(mockClankerService.getTokenInfo).toHaveBeenCalled();
      }
    });

    it('should handle mixed case addresses', async () => {
      const mixedCaseAddress = '0xaBcDeF' + '1'.repeat(34);
      const memory = createMemory(`token info for ${mixedCaseAddress}`);

      await tokenInfoAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(mockClankerService.getTokenInfo).toHaveBeenCalledWith(mixedCaseAddress.toLowerCase());
    });
  });

  describe('response formatting', () => {
    it('should format complete token information correctly', async () => {
      const tokenAddress = '0x' + 'a'.repeat(40);
      const memory = createMemory(`token info ${tokenAddress}`);

      const result = await tokenInfoAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.text).toContain('📊 Token Information');
      expect(result.text).toContain('Test Token (TEST)');
      expect(result.text).toContain('Contract: 0xaaaa...aaaa');
      expect(result.text).toContain('Price: $1.25');
      expect(result.text).toContain('Total Supply: 1,000,000 TEST');
      expect(result.text).toContain('Market Cap: $1,250,000.00');
      expect(result.text).toContain('Holders: 1,500');
      expect(result.text).toContain('24h Volume: 50,000.0 TEST');
    });

    it('should include blockchain explorer links', async () => {
      const tokenAddress = '0x' + 'b'.repeat(40);
      const memory = createMemory(`info ${tokenAddress}`);

      const result = await tokenInfoAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.text).toContain('https://basescan.org/token/');
      expect(result.text).toContain('https://clanker.world/clanker/');
    });

    it('should handle very large numbers correctly', async () => {
      mockClankerService.getTokenInfo.mockResolvedValueOnce({
        address: '0x' + 'c'.repeat(40),
        name: 'Big Token',
        symbol: 'BIG',
        decimals: 18,
        totalSupply: parseUnits('1000000000000', 18), // 1 trillion
        price: 0.000001,
        priceUsd: 0.000001,
        volume24h: parseUnits('1000000000', 18), // 1 billion
        holders: 50000,
        liquidity: parseUnits('500000000', 18),
        marketCap: 1000000n,
        createdAt: Date.now(),
      });

      const tokenAddress = '0x' + 'c'.repeat(40);
      const memory = createMemory(`token info ${tokenAddress}`);

      const result = await tokenInfoAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.text).toContain('1,000,000,000,000 BIG'); // Properly formatted large number
    });
  });

  describe('error handling', () => {
    it('should handle network errors', async () => {
      mockClankerService.getTokenInfo.mockRejectedValueOnce(new Error('Network timeout'));
      const tokenAddress = '0x' + 'd'.repeat(40);
      const memory = createMemory(`token info ${tokenAddress}`);

      const result = await tokenInfoAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Network timeout');
    });

    it('should handle malformed token addresses', async () => {
      const memory = createMemory('token info 0x123'); // Too short

      const result = await tokenInfoAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Invalid token address');
    });

    it('should handle unexpected service errors', async () => {
      mockClankerService.getTokenInfo.mockRejectedValueOnce(new Error('Unexpected error'));
      const tokenAddress = '0x' + 'e'.repeat(40);
      const memory = createMemory(`info ${tokenAddress}`);

      const result = await tokenInfoAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('data validation', () => {
    it('should return structured data in response', async () => {
      const tokenAddress = '0x' + 'f'.repeat(40);
      const memory = createMemory(`token info ${tokenAddress}`);

      const result = await tokenInfoAction.handler!(
        mockRuntime as any,
        memory,
        undefined,
        {},
        undefined
      );

      expect(result.data).toHaveProperty('tokenInfo');
      expect(result.data.tokenInfo).toHaveProperty('address');
      expect(result.data.tokenInfo).toHaveProperty('name');
      expect(result.data.tokenInfo).toHaveProperty('symbol');
      expect(result.data.tokenInfo).toHaveProperty('price');
    });
  });
});
