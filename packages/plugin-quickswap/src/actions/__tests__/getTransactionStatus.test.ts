import { vi, describe, it, expect, beforeEach } from 'vitest';
import { IAgentRuntime, Memory } from '@elizaos/core';
import { getTransactionStatusAction } from '../getTransactionStatus.js';
import { initializeQuickswapClient } from '../../utils/quickswapClient.js';

// Mock core modules
vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual('@elizaos/core');
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

// Mock local modules
vi.mock('../../utils/quickswapClient.js');

describe('getTransactionStatusAction', () => {
  let mockRuntime: IAgentRuntime;
  let mockMemory: Memory;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRuntime = {
      getSetting: vi.fn(),
      getService: vi.fn(),
    } as unknown as IAgentRuntime;

    mockMemory = {
      entityId: 'user-id' as any,
      roomId: 'room-id' as any,
      content: {
        text: 'Check status of transaction 0xmno',
        transactionHash: '0xmno',
      },
    };
  });

  describe('validate', () => {
    it('should return false if QUICKSWAP_API_URL is not provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue(undefined);
      const result = await getTransactionStatusAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(false);
    });

    it('should return true if QUICKSWAP_API_URL is provided', async () => {
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
      const result = await getTransactionStatusAction.validate(mockRuntime, mockMemory);
      expect(result).toBe(true);
    });
  });

  describe('handler', () => {
    const mockQuickswapClient = {
      GetTransactionStatus: vi.fn(),
    };

    beforeEach(() => {
      (initializeQuickswapClient as vi.Mock).mockResolvedValue(mockQuickswapClient);
      (mockRuntime.getSetting as vi.Mock).mockReturnValue('http://fake-api-url.com');
    });

    it('should call GetTransactionStatus and return success', async () => {
      const statusResult = {
        success: true,
        status: 'Confirmed',
        blockNumber: '12345',
        gasUsed: '50000',
        from: '0xabc',
        to: '0xdef',
        value: '10 ETH',
      };
      mockQuickswapClient.GetTransactionStatus.mockResolvedValue(statusResult);

      const result = (await getTransactionStatusAction.handler(mockRuntime, mockMemory)) as {
        text: string;
        data: { success: boolean };
      };

      expect(mockQuickswapClient.GetTransactionStatus).toHaveBeenCalledWith('0xmno');
      expect(result.text).toContain('Transaction Status');
      expect(result.data?.success).toBe(true);
    });

    it('should return an error message on failed status check', async () => {
      const statusResult = { success: false, error: 'Transaction not found' };
      mockQuickswapClient.GetTransactionStatus.mockResolvedValue(statusResult);

      const result = (await getTransactionStatusAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Transaction not found');
    });

    it('should handle Zod validation errors', async () => {
      mockMemory.content = { text: 'some text' };
      const result = (await getTransactionStatusAction.handler(mockRuntime, mockMemory)) as {
        text: string;
      };
      expect(result.text).toContain('Error**: Invalid parameters');
    });
  });
});
