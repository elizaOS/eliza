import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { estimateTransactionFeeAction } from '../src/actions/estimateTransactionFee';
import type { IAgentRuntime, Memory, State, Content } from '@elizaos/core';
import {
  createMockRuntime,
  createMockMessage,
  createMockState,
  createMockCallback,
} from './test-helpers';

// Mock the dependencies
vi.mock('ethers', () => ({
  JsonRpcProvider: vi.fn().mockImplementation(() => ({
    estimateGas: vi.fn().mockResolvedValue(BigInt('21000')),
    send: vi.fn().mockImplementation((method) => {
      if (method === 'eth_gasPrice') {
        return Promise.resolve('0x4a817c800'); // 20 Gwei in hex
      }
      return Promise.resolve('0x0');
    }),
  })),
  isAddress: vi.fn().mockReturnValue(true),
  getAddress: vi.fn().mockImplementation((addr) => addr),
  parseUnits: vi.fn().mockImplementation((value, unit) => {
    if (unit === 'gwei') {
      return BigInt(value) * BigInt('1000000000');
    }
    if (unit === 'ether') {
      return BigInt(value) * BigInt('1000000000000000000');
    }
    return BigInt(value);
  }),
  formatUnits: vi.fn().mockImplementation((value, unit) => {
    if (unit === 'gwei') {
      return (Number(value) / 1e9).toString();
    }
    if (unit === 'ether') {
      return (Number(value) / 1e18).toString();
    }
    return value.toString();
  }),
}));

vi.mock('../src/utils/llmHelpers', () => ({
  callLLMWithTimeout: vi.fn().mockResolvedValue({
    to: '0x742d35Cc6634C0532925A3B8D4C9dB96C4B4d8B6',
    value: '0.1',
  }),
}));

describe('estimateTransactionFee', () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;
  let mockCallback: any;

  beforeEach(() => {
    mockRuntime = createMockRuntime({
      ALCHEMY_API_KEY: 'test-alchemy-key',
      ZKEVM_RPC_URL: 'https://polygonzkevm-mainnet.g.alchemy.com/v2',
    });

    mockMessage = createMockMessage(
      'Estimate fee for sending 0.1 ETH to 0x742d35Cc6634C0532925A3B8D4C9dB96C4B4d8B6'
    );
    mockState = createMockState();
    mockCallback = createMockCallback();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('action properties', () => {
    it('should have correct action name', () => {
      expect(estimateTransactionFeeAction.name).toBe('ESTIMATE_TRANSACTION_FEE');
    });

    it('should have expected similes', () => {
      expect(estimateTransactionFeeAction.similes).toContain('ESTIMATE_FEE');
      expect(estimateTransactionFeeAction.similes).toContain('TRANSACTION_FEE');
      expect(estimateTransactionFeeAction.similes).toContain('FEE_ESTIMATE');
      expect(estimateTransactionFeeAction.similes).toContain('CALCULATE_FEE');
    });

    it('should have proper description', () => {
      expect(estimateTransactionFeeAction.description).toContain(
        'Estimate gas limit and total fee'
      );
      expect(estimateTransactionFeeAction.description).toContain('Polygon zkEVM');
    });

    it('should have examples', () => {
      expect(estimateTransactionFeeAction.examples).toBeDefined();
      expect(Array.isArray(estimateTransactionFeeAction.examples)).toBe(true);
      expect(estimateTransactionFeeAction.examples!.length).toBeGreaterThan(0);
    });
  });

  describe('validate', () => {
    it('should return true when ALCHEMY_API_KEY is provided', async () => {
      const result = await estimateTransactionFeeAction.validate(
        mockRuntime,
        mockMessage,
        mockState
      );
      expect(result).toBe(true);
    });

    it('should return true when ZKEVM_RPC_URL is provided', async () => {
      const runtimeWithRpc = createMockRuntime({
        ALCHEMY_API_KEY: undefined,
        ZKEVM_RPC_URL: 'https://test-rpc.com',
      });

      const result = await estimateTransactionFeeAction.validate(
        runtimeWithRpc,
        mockMessage,
        mockState
      );
      expect(result).toBe(true);
    });

    it('should return false when neither API key nor RPC URL is provided', async () => {
      const runtimeWithoutConfig = createMockRuntime({
        ALCHEMY_API_KEY: undefined,
        ZKEVM_RPC_URL: undefined,
      });

      const result = await estimateTransactionFeeAction.validate(
        runtimeWithoutConfig,
        mockMessage,
        mockState
      );
      expect(result).toBe(false);
    });

    it('should return true for fee estimation keywords', async () => {
      const feeMessages = [
        'estimate fee for this transaction',
        'what will the transaction fee be',
        'calculate fee for sending ETH',
        'gas limit and cost estimate',
        'how much will it cost to send',
      ];

      for (const text of feeMessages) {
        const message = createMockMessage(text);
        const result = await estimateTransactionFeeAction.validate(mockRuntime, message, mockState);
        expect(result).toBe(true);
      }
    });

    it('should return true for address + value patterns', async () => {
      const addressValueMessage = createMockMessage(
        'Send 1.5 ETH to 0x742d35Cc6634C0532925A3B8D4C9dB96C4B4d8B6'
      );
      const result = await estimateTransactionFeeAction.validate(
        mockRuntime,
        addressValueMessage,
        mockState
      );
      expect(result).toBe(true);
    });

    it('should return false for non-relevant messages', async () => {
      const irrelevantMessage = createMockMessage('What is the weather today?');
      const result = await estimateTransactionFeeAction.validate(
        mockRuntime,
        irrelevantMessage,
        mockState
      );
      expect(result).toBe(false);
    });
  });

  describe('handler - ETH Transfer', () => {
    it('should estimate fee for simple ETH transfer', async () => {
      const result = (await estimateTransactionFeeAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect(result).toBeDefined();
      expect((result.data as any).gasLimit).toBe('21000');
      expect((result.data as any).fee).toBeDefined(); // Total fee in wei
      expect((result.data as any).gasPrice).toBeDefined();
      expect((result.data as any).network).toBe('polygon-zkevm');
      expect(result.text).toContain('Transaction Fee Estimate');
      expect(result.text).toContain('Gas Limit: 21000 units');
    });

    it('should return data in correct format { gasLimit: string, fee: string }', async () => {
      const result = (await estimateTransactionFeeAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect(typeof (result.data as any).gasLimit).toBe('string');
      expect(typeof (result.data as any).fee).toBe('string');

      // Verify fee calculation: gasLimit * gasPrice
      const expectedFee = (BigInt('21000') * BigInt('20000000000')).toString(); // 21000 * 20 Gwei
      expect((result.data as any).fee).toBe(expectedFee);
    });

    it('should call callback with result', async () => {
      await estimateTransactionFeeAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(mockCallback).toHaveBeenCalledOnce();
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Transaction Fee Estimate'),
          actions: ['ESTIMATE_TRANSACTION_FEE'],
          data: expect.objectContaining({
            gasLimit: expect.any(String),
            fee: expect.any(String),
          }),
        })
      );
    });
  });

  describe('handler - Contract Call', () => {
    it('should estimate fee for contract call with higher gas limit', async () => {
      // Override the mock to return higher gas estimate for contract calls
      const ethers = await import('ethers');
      const mockProvider = ethers.JsonRpcProvider as any;
      mockProvider.mockImplementation(() => ({
        estimateGas: vi.fn().mockResolvedValue(BigInt('150000')), // Higher gas for contract call
        send: vi.fn().mockImplementation((method: string) => {
          if (method === 'eth_gasPrice') {
            return Promise.resolve('0x4a817c800'); // 20 Gwei in hex
          }
          return Promise.resolve('0x0');
        }),
      }));

      const contractMessage = createMockMessage(
        'Estimate fee for calling contract at 0x1234567890123456789012345678901234567890'
      );

      const result = (await estimateTransactionFeeAction.handler(
        mockRuntime,
        contractMessage,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect(result).toBeDefined();
      expect((result.data as any).gasLimit).toBe('150000');
      expect((result.data as any).fee).toBeDefined();
      expect(result.text).toContain('Gas Limit: 150000 units');

      // Verify fee calculation for contract call
      const expectedFee = (BigInt('150000') * BigInt('20000000000')).toString();
      expect((result.data as any).fee).toBe(expectedFee);
    });
  });

  describe('handler - Error Cases', () => {
    it('should handle missing configuration', async () => {
      const badRuntime = createMockRuntime({
        ALCHEMY_API_KEY: undefined,
        ZKEVM_RPC_URL: undefined,
      });

      const result = (await estimateTransactionFeeAction.handler(
        badRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      )) as Content;

      expect(result.text).toContain('ALCHEMY_API_KEY or ZKEVM_RPC_URL is required');
      expect(result.data as any).toHaveProperty('error');
      expect((result.data as any).success).toBe(false);
    });
  });
});
