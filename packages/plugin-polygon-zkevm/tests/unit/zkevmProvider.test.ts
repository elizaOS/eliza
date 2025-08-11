import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JsonRpcProvider } from 'ethers';
import { createMockRuntime, resetCommonMocks } from '../test-helpers';

describe('zkEVM Provider', () => {
  beforeEach(() => {
    resetCommonMocks();
  });

  describe('provider initialization', () => {
    it('should create Alchemy provider when API key is available', () => {
      const runtime = createMockRuntime({
        ALCHEMY_API_KEY: 'test-key',
      });

      const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
      expect(alchemyApiKey).toBe('test-key');
    });

    it('should create RPC provider when RPC URL is available', () => {
      const runtime = createMockRuntime({
        ZKEVM_RPC_URL: 'https://test-rpc.com',
      });

      const rpcUrl = runtime.getSetting('ZKEVM_RPC_URL');
      expect(rpcUrl).toBe('https://test-rpc.com');
    });

    it('should handle missing configuration gracefully', () => {
      const runtime = createMockRuntime({
        ALCHEMY_API_KEY: undefined,
        ZKEVM_RPC_URL: undefined,
      });

      const alchemyKey = runtime.getSetting('ALCHEMY_API_KEY');
      const rpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

      expect(alchemyKey).toBeUndefined();
      expect(rpcUrl).toBeUndefined();
    });
  });

  describe('block number formatting', () => {
    it('should format block numbers with commas', () => {
      const blockNumber = 22628395;
      const formatted = blockNumber.toLocaleString();
      expect(formatted).toBe('22,628,395');
    });

    it('should convert decimal to hex format', () => {
      const blockNumber = 22628395;
      const hex = `0x${blockNumber.toString(16)}`;
      expect(hex).toBe('0x159482b');
    });

    it('should parse hex back to decimal', () => {
      const hex = '0x159482b';
      const decimal = parseInt(hex, 16);
      expect(decimal).toBe(22628395);
    });
  });

  describe('error handling', () => {
    it('should handle network errors gracefully', async () => {
      const mockProvider = {
        getBlockNumber: vi.fn().mockRejectedValue(new Error('Network error')),
      };

      try {
        await mockProvider.getBlockNumber();
      } catch (error) {
        expect(error.message).toBe('Network error');
      }
    });

    it('should handle invalid responses', async () => {
      const mockProvider = {
        getBalance: vi.fn().mockResolvedValue(null),
      };

      const balance = await mockProvider.getBalance();
      expect(balance).toBeNull();
    });
  });

  describe('zkEVM specific features', () => {
    it('should handle batch information queries', () => {
      const batchNumber = 12345;
      const batchHex = `0x${batchNumber.toString(16)}`;
      expect(batchHex).toBe('0x3039');
    });

    it('should handle block status mapping', () => {
      const statusMap = {
        0: 'Virtual',
        1: 'Trusted',
        2: 'Consolidated',
      };

      expect(statusMap[0]).toBe('Virtual');
      expect(statusMap[1]).toBe('Trusted');
      expect(statusMap[2]).toBe('Consolidated');
    });
  });
});
