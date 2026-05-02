import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { ClankerService } from '../../src/services/clanker.service';
import { ClankerError, ErrorCode } from '../../src/utils/errors';
import { parseUnits } from 'ethers';

// Mock runtime
const mockRuntime = {
  getSetting: (key: string) => {
    if (key === 'clanker') {
      return {
        BASE_RPC_URL: 'https://mainnet.base.org',
        PRIVATE_KEY: '0x' + '0'.repeat(64),
        DEFAULT_SLIPPAGE: 0.05,
        MAX_GAS_PRICE: '100000000000',
        RETRY_ATTEMPTS: 3,
        NETWORK: 'base',
      };
    }
    return null;
  },
};

describe('ClankerService', () => {
  let service: ClankerService;

  beforeEach(() => {
    service = new ClankerService(mockRuntime as any);
  });

  describe('initialize', () => {
    it('should initialize successfully with valid config', async () => {
      await expect(service.initialize(mockRuntime as any)).resolves.not.toThrow();
    });

    it('should throw error without config', async () => {
      const badRuntime = {
        getSetting: () => null,
      };
      const badService = new ClankerService(badRuntime as any);
      await expect(badService.initialize(badRuntime as any)).rejects.toThrow(ClankerError);
    });
  });

  describe('deployToken', () => {
    beforeEach(async () => {
      await service.initialize(mockRuntime as any);
    });

    it('should validate token parameters', async () => {
      // Test invalid name
      await expect(
        service.deployToken({
          name: '',
          symbol: 'TEST',
        })
      ).rejects.toThrow();

      // Test invalid symbol
      await expect(
        service.deployToken({
          name: 'Test Token',
          symbol: 'VERYLONGSYMBOL',
        })
      ).rejects.toThrow();

      // Test name too long
      await expect(
        service.deployToken({
          name: 'A'.repeat(51),
          symbol: 'TEST',
        })
      ).rejects.toThrow();
    });

    it('should deploy token with valid parameters', async () => {
      const result = await service.deployToken({
        name: 'Test Token',
        symbol: 'TEST',
        vanity: false,
        metadata: {
          description: 'A test token for unit testing',
        },
      });

      expect(result).toHaveProperty('contractAddress');
      expect(result).toHaveProperty('transactionHash');
      expect(result).toHaveProperty('deploymentCost');
      expect(result.contractAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(result.transactionHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });
  });

  describe('getTokenInfo', () => {
    beforeEach(async () => {
      await service.initialize(mockRuntime as any);
    });

    it('should validate token address', async () => {
      await expect(service.getTokenInfo('invalid-address')).rejects.toThrow();
    });

    it('should return cached token info when available', async () => {
      const address = '0x' + '1'.repeat(40);

      // First call should hit the network (mocked)
      const info1 = await service.getTokenInfo(address);
      expect(info1).toHaveProperty('name');
      expect(info1).toHaveProperty('symbol');

      // Second call should return cached data
      const info2 = service.getCachedTokenInfo(address);
      expect(info2).toEqual(info1);
    });
  });

  describe('swapTokens', () => {
    beforeEach(async () => {
      await service.initialize(mockRuntime as any);
    });

    it('should throw error as swapping is not supported by Clanker SDK', async () => {
      await expect(
        service.swapTokens({
          fromToken: '0x' + '1'.repeat(40),
          toToken: '0x' + '2'.repeat(40),
          amount: parseUnits('1', 18),
          slippage: 0.01,
        })
      ).rejects.toThrow('Token swapping not supported by Clanker SDK');
    });
  });

  describe('addLiquidity', () => {
    beforeEach(async () => {
      await service.initialize(mockRuntime as any);
    });

    it('should throw error as liquidity operations are not supported by Clanker SDK', async () => {
      await expect(
        service.addLiquidity({
          tokenA: '0x' + '1'.repeat(40),
          tokenB: '0x' + '2'.repeat(40),
          amountA: parseUnits('1', 18),
          amountB: parseUnits('1000', 18),
          slippage: 0.01,
        })
      ).rejects.toThrow('Liquidity operations not supported by Clanker SDK');
    });
  });

  describe('removeLiquidity', () => {
    beforeEach(async () => {
      await service.initialize(mockRuntime as any);
    });

    it('should throw error as liquidity operations are not supported by Clanker SDK', async () => {
      await expect(
        service.removeLiquidity({
          lpToken: '0x' + '1'.repeat(40),
          liquidity: parseUnits('100', 18),
          minAmountA: parseUnits('1', 18),
          minAmountB: parseUnits('1000', 18),
        })
      ).rejects.toThrow('Liquidity operations not supported by Clanker SDK');
    });
  });
});
