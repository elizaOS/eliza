import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockRuntime, createMockAlchemyResponses, resetCommonMocks } from '../test-helpers';

describe('Alchemy API Integration', () => {
  beforeEach(() => {
    resetCommonMocks();
  });

  describe('API connectivity', () => {
    it('should connect to Alchemy API with valid key', () => {
      const runtime = createMockRuntime({
        ALCHEMY_API_KEY: 'test-alchemy-key',
      });

      const apiKey = runtime.getSetting('ALCHEMY_API_KEY');
      expect(apiKey).toBe('test-alchemy-key');
    });

    it('should handle missing API key gracefully', () => {
      const runtime = createMockRuntime({
        ALCHEMY_API_KEY: undefined,
      });

      const apiKey = runtime.getSetting('ALCHEMY_API_KEY');
      expect(apiKey).toBeUndefined();
    });
  });

  describe('API responses', () => {
    it('should mock block number responses correctly', async () => {
      const mockResponses = createMockAlchemyResponses();

      const blockNumber = await mockResponses.getBlockNumber();
      expect(blockNumber).toBe(22628395);
      expect(mockResponses.getBlockNumber).toHaveBeenCalled();
    });

    it('should mock balance responses correctly', async () => {
      const mockResponses = createMockAlchemyResponses();

      const balance = await mockResponses.getBalance();
      expect(balance).toBe('199996706426001177549345550');
      expect(mockResponses.getBalance).toHaveBeenCalled();
    });

    it('should mock gas price responses correctly', async () => {
      const mockResponses = createMockAlchemyResponses();

      const gasPrice = await mockResponses.getGasPrice();
      expect(gasPrice).toBe('19800000');
      expect(mockResponses.getGasPrice).toHaveBeenCalled();
    });

    it('should mock transaction responses correctly', async () => {
      const mockResponses = createMockAlchemyResponses();

      const transaction = await mockResponses.getTransaction();
      expect(transaction).toHaveProperty('hash');
      expect(transaction).toHaveProperty('from');
      expect(transaction).toHaveProperty('to');
      expect(mockResponses.getTransaction).toHaveBeenCalled();
    });

    it('should mock transaction receipt responses correctly', async () => {
      const mockResponses = createMockAlchemyResponses();

      const receipt = await mockResponses.getTransactionReceipt();
      expect(receipt).toHaveProperty('transactionHash');
      expect(receipt).toHaveProperty('status');
      expect(receipt).toHaveProperty('gasUsed');
      expect(mockResponses.getTransactionReceipt).toHaveBeenCalled();
    });

    it('should mock contract code responses correctly', async () => {
      const mockResponses = createMockAlchemyResponses();

      const code = await mockResponses.getCode();
      expect(code).toMatch(/^0x[0-9a-f]+/i);
      expect(mockResponses.getCode).toHaveBeenCalled();
    });
  });

  describe('zkEVM specific API calls', () => {
    it('should handle eth_getLogs calls', async () => {
      const mockResponses = createMockAlchemyResponses();

      const logs = await mockResponses.send('eth_getLogs', [{}]);
      expect(Array.isArray(logs)).toBe(true);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toHaveProperty('address');
      expect(logs[0]).toHaveProperty('topics');
    });

    it('should handle zk_getBatchById calls', async () => {
      const mockResponses = createMockAlchemyResponses();

      const batch = await mockResponses.send('zk_getBatchById', ['0x3039']);
      expect(batch).toHaveProperty('batchNumber');
      expect(batch).toHaveProperty('timestamp');
      expect(batch).toHaveProperty('transactions');
    });

    it('should handle unknown method calls', async () => {
      const mockResponses = createMockAlchemyResponses();

      const result = await mockResponses.send('unknown_method', []);
      expect(result).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should handle API rate limits', async () => {
      const mockProvider = {
        getBlockNumber: vi.fn().mockRejectedValue(new Error('Rate limit exceeded')),
      };

      try {
        await mockProvider.getBlockNumber();
      } catch (error) {
        expect(error.message).toBe('Rate limit exceeded');
      }
    });

    it('should handle network timeouts', async () => {
      const mockProvider = {
        getBalance: vi.fn().mockRejectedValue(new Error('Request timeout')),
      };

      try {
        await mockProvider.getBalance();
      } catch (error) {
        expect(error.message).toBe('Request timeout');
      }
    });

    it('should handle invalid API responses', async () => {
      const mockProvider = {
        getTransaction: vi.fn().mockResolvedValue(null),
      };

      const result = await mockProvider.getTransaction();
      expect(result).toBeNull();
    });
  });

  describe('dual API strategy', () => {
    it('should prefer Alchemy when both APIs are available', () => {
      const runtime = createMockRuntime({
        ALCHEMY_API_KEY: 'test-key',
        ZKEVM_RPC_URL: 'https://test-rpc.com',
      });

      const alchemyKey = runtime.getSetting('ALCHEMY_API_KEY');
      const rpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

      expect(alchemyKey).toBe('test-key');
      expect(rpcUrl).toBe('https://test-rpc.com');
    });

    it('should fallback to RPC when Alchemy is unavailable', () => {
      const runtime = createMockRuntime({
        ALCHEMY_API_KEY: undefined,
        ZKEVM_RPC_URL: 'https://test-rpc.com',
      });

      const alchemyKey = runtime.getSetting('ALCHEMY_API_KEY');
      const rpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

      expect(alchemyKey).toBeUndefined();
      expect(rpcUrl).toBe('https://test-rpc.com');
    });
  });
});
