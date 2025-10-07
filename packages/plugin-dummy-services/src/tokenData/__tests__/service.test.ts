import { describe, expect, it, beforeEach } from 'bun:test';
import { DummyTokenDataService } from '../service';
import { type IAgentRuntime } from '@elizaos/core';

describe('DummyTokenDataService', () => {
  let service: DummyTokenDataService;
  const mockRuntime = {} as IAgentRuntime;

  beforeEach(async () => {
    service = new DummyTokenDataService(mockRuntime);
    await service.start();
  });

  describe('getTokenDetails', () => {
    it('should return token details for a given address', async () => {
      const address = 'So11111111111111111111111111111111111111112';
      const tokenData = await service.getTokenDetails(address, 'solana');

      expect(tokenData).toBeDefined();
      expect(tokenData?.address).toBe(address);
      expect(tokenData?.chain).toBe('solana');
      expect(tokenData?.sourceProvider).toBe('dummy');
      expect(tokenData?.id).toBe(`solana:${address}`);
    });

    it('should generate consistent symbol from address', async () => {
      const address = 'So11111111111111111111111111111111111111112';
      const tokenData = await service.getTokenDetails(address, 'solana');

      expect(tokenData?.symbol).toBe('1111'); // First 4 chars after 'So'
      expect(tokenData?.name).toBe('Dummy Token 1111');
    });

    it('should include all required fields', async () => {
      const tokenData = await service.getTokenDetails('test-address', 'ethereum');

      expect(tokenData).toHaveProperty('price');
      expect(tokenData).toHaveProperty('priceChange24hPercent');
      expect(tokenData).toHaveProperty('volume24hUSD');
      expect(tokenData).toHaveProperty('marketCapUSD');
      expect(tokenData).toHaveProperty('liquidity');
      expect(tokenData).toHaveProperty('holders');
      expect(tokenData).toHaveProperty('logoURI');
      expect(tokenData).toHaveProperty('decimals');
      expect(tokenData).toHaveProperty('lastUpdatedAt');
      expect(tokenData).toHaveProperty('raw');
    });

    it('should always return 18 decimals', async () => {
      const tokenData = await service.getTokenDetails('any-address', 'any-chain');
      expect(tokenData?.decimals).toBe(18);
    });
  });

  describe('getTrendingTokens', () => {
    it('should return requested number of trending tokens', async () => {
      const tokens = await service.getTrendingTokens('solana', 5);

      expect(tokens).toHaveLength(5);
      tokens.forEach((token) => {
        expect(token.chain).toBe('solana');
        expect(token.sourceProvider).toBe('dummy');
      });
    });

    it('should use default values when parameters are omitted', async () => {
      const tokens = await service.getTrendingTokens();

      expect(tokens).toHaveLength(10); // Default limit
      tokens.forEach((token) => {
        expect(token.chain).toBe('solana'); // Default chain
      });
    });

    it('should generate random but valid data for each token', async () => {
      const tokens = await service.getTrendingTokens('ethereum', 3);

      tokens.forEach((token) => {
        expect(token.price).toBeGreaterThanOrEqual(0);
        expect(token.price).toBeLessThanOrEqual(100);
        expect(token.priceChange24hPercent).toBeGreaterThanOrEqual(-10);
        expect(token.priceChange24hPercent).toBeLessThanOrEqual(10);
        expect(token.volume24hUSD).toBeGreaterThanOrEqual(0);
        expect(token.marketCapUSD).toBeGreaterThanOrEqual(0);
        expect(token.liquidity).toBeGreaterThanOrEqual(0);
        expect(token.holders).toBeGreaterThanOrEqual(0);
        expect(token.holders).toBeLessThanOrEqual(10000);
      });
    });
  });

  describe('searchTokens', () => {
    it('should return tokens matching the query', async () => {
      const tokens = await service.searchTokens('BTC', 'ethereum', 3);

      expect(tokens).toHaveLength(3);
      tokens.forEach((token) => {
        expect(token.symbol).toBe('BTC');
        expect(token.name).toBe('Dummy Token BTC');
        expect(token.chain).toBe('ethereum');
      });
    });

    it('should use default values when optional parameters are omitted', async () => {
      const tokens = await service.searchTokens('ETH');

      expect(tokens).toHaveLength(5); // Default limit
      tokens.forEach((token) => {
        expect(token.symbol).toBe('ETH');
        expect(token.chain).toBe('solana'); // Default chain
      });
    });

    it('should uppercase the query for symbol', async () => {
      const tokens = await service.searchTokens('usdc');

      tokens.forEach((token) => {
        expect(token.symbol).toBe('USDC');
        expect(token.name).toBe('Dummy Token USDC');
      });
    });
  });

  describe('getTokensByAddresses', () => {
    it('should return tokens for all provided addresses', async () => {
      const addresses = ['address1', 'address2', 'address3'];
      const tokens = await service.getTokensByAddresses(addresses, 'polygon');

      expect(tokens).toHaveLength(3);
      tokens.forEach((token, index) => {
        expect(token.address).toBe(addresses[index]);
        expect(token.chain).toBe('polygon');
        expect(token.id).toBe(`polygon:${addresses[index]}`);
      });
    });

    it('should handle empty addresses array', async () => {
      const tokens = await service.getTokensByAddresses([], 'solana');
      expect(tokens).toHaveLength(0);
    });

    it('should generate appropriate symbols from addresses', async () => {
      const addresses = ['0xAbCdEf123456', '0x9876543210Fe'];
      const tokens = await service.getTokensByAddresses(addresses, 'ethereum');

      expect(tokens[0].symbol).toBe('ABCD'); // First 4 chars after '0x'
      expect(tokens[1].symbol).toBe('9876');
    });
  });

  describe('service lifecycle', () => {
    it('should create service and support start/stop', async () => {
      const newService = new DummyTokenDataService(mockRuntime);
      expect(newService).toBeInstanceOf(DummyTokenDataService);

      // Start and stop should not throw
      await expect(newService.start()).resolves.toBeUndefined();
      await expect(newService.stop()).resolves.toBeUndefined();
    });

    it('should maintain service name', () => {
      const newService = new DummyTokenDataService(mockRuntime);
      expect(newService.serviceName).toBe('dummy-token-data');
    });
  });

  describe('data consistency', () => {
    it('should always mark data as dummy', async () => {
      const tokenData = await service.getTokenDetails('any-address', 'any-chain');
      expect(tokenData?.raw.dummyData).toBe(true);
    });

    it('should use placeholder logo URI', async () => {
      const tokenData = await service.getTokenDetails('any-address', 'any-chain');
      expect(tokenData?.logoURI).toBe('https://via.placeholder.com/150');
    });

    it('should generate valid timestamps', async () => {
      const tokenData = await service.getTokenDetails('any-address', 'any-chain');
      const timestamp = tokenData?.lastUpdatedAt;

      expect(timestamp).toBeInstanceOf(Date);
      expect(timestamp?.getTime()).toBeLessThanOrEqual(Date.now());
      expect(timestamp?.getTime()).toBeGreaterThan(Date.now() - 1000); // Within last second
    });
  });
});
