import { describe, it, expect, vi, beforeEach } from 'vitest';
import { revokeApiKeyAction } from '../actions/revokeApiKey';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';

// Mock the dependencies
vi.mock('../utils/clobClient');
vi.mock('../utils/llmHelpers');

describe('revokeApiKeyAction', () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;
  let mockCallback: any;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Mock runtime
    mockRuntime = {
      getSetting: vi.fn((key: string) => {
        if (key === 'WALLET_PRIVATE_KEY') return 'test-private-key';
        if (key === 'CLOB_API_URL') return 'https://clob.polymarket.com';
        return undefined;
      }),
      useModel: vi.fn(),
    } as any;

    // Mock message
    mockMessage = {
      content: {
        text: 'Revoke API key 12345678-1234-5678-9abc-123456789012',
      },
    } as any;

    // Mock state
    mockState = {} as State;

    // Mock callback
    mockCallback = vi.fn();
  });

  describe('validate', () => {
    it('should return true when private key is available', async () => {
      const result = await revokeApiKeyAction.validate(mockRuntime, mockMessage);
      expect(result).toBe(true);
    });

    it('should return false when no private key is available', async () => {
      mockRuntime.getSetting = vi.fn(() => undefined);
      const result = await revokeApiKeyAction.validate(mockRuntime, mockMessage);
      expect(result).toBe(false);
    });
  });

  describe('handler', () => {
    beforeEach(async () => {
      // Mock the LLM helper
      const { callLLMWithTimeout } = (await vi.importMock('../utils/llmHelpers')) as any;
      callLLMWithTimeout.mockResolvedValue = vi
        .fn()
        .mockResolvedValue('12345678-1234-5678-9abc-123456789012');

      // Mock the CLOB client
      const { initializeClobClient } = (await vi.importMock('../utils/clobClient')) as any;
      const mockClobClient = {
        deleteApiKey: vi.fn().mockResolvedValue({ success: true }),
      };
      initializeClobClient.mockResolvedValue = vi.fn().mockResolvedValue(mockClobClient);
    });

    it('should successfully revoke a valid API key', async () => {
      // Set up mocks for this specific test
      const { callLLMWithTimeout } = (await vi.importMock('../utils/llmHelpers')) as any;
      const { initializeClobClient } = (await vi.importMock('../utils/clobClient')) as any;

      (callLLMWithTimeout as any).mockResolvedValue('12345678-1234-5678-9abc-123456789012');
      const mockClobClient = { deleteApiKey: vi.fn().mockResolvedValue({ success: true }) };
      (initializeClobClient as any).mockResolvedValue(mockClobClient);

      await revokeApiKeyAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('✅ **API Key Revoked Successfully**'),
        action: 'DELETE_API_KEY',
        data: {
          success: true,
          revocation: expect.objectContaining({
            success: true,
            apiKeyId: '12345678-1234-5678-9abc-123456789012',
            revokedAt: expect.any(String),
            message: 'API key revoked successfully',
          }),
        },
      });
    });

    it('should handle invalid API key ID format', async () => {
      const { callLLMWithTimeout } = (await vi.importMock('../utils/llmHelpers')) as any;
      (callLLMWithTimeout as any).mockResolvedValue('NONE');

      await revokeApiKeyAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **API Key Revocation Failed**'),
        action: 'DELETE_API_KEY',
        data: {
          success: false,
          error: 'No valid API key ID provided',
        },
      });
    });

    it('should handle API key not found error', async () => {
      const { callLLMWithTimeout } = (await vi.importMock('../utils/llmHelpers')) as any;
      const { initializeClobClient } = (await vi.importMock('../utils/clobClient')) as any;

      (callLLMWithTimeout as any).mockResolvedValue('12345678-1234-5678-9abc-123456789012');
      const mockClobClient = {
        deleteApiKey: vi.fn().mockRejectedValue(new Error('API key not found')),
      };
      (initializeClobClient as any).mockResolvedValue(mockClobClient);

      await revokeApiKeyAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **API Key Revocation Failed**'),
        action: 'DELETE_API_KEY',
        data: {
          success: false,
          error: 'API key not found',
        },
      });
    });

    it('should handle network connectivity issues', async () => {
      const { initializeClobClient } = (await vi.importMock('../utils/clobClient')) as any;
      (initializeClobClient as any).mockRejectedValue(new Error('Network error'));

      await revokeApiKeyAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **API Key Revocation Failed**'),
        action: 'DELETE_API_KEY',
        data: {
          success: false,
          error: 'Network error',
        },
      });
    });

    it('should extract API key ID from various message formats', async () => {
      const { callLLMWithTimeout } = (await vi.importMock('../utils/llmHelpers')) as any;
      const { initializeClobClient } = (await vi.importMock('../utils/clobClient')) as any;

      // Test different message formats
      const testCases = [
        {
          message: 'Delete API key abc12345-def6-7890-ghij-klmnopqrstuv',
          expectedId: 'abc12345-def6-7890-ghij-klmnopqrstuv',
        },
        {
          message: 'Remove key 98765432-1098-7654-3210-fedcba987654',
          expectedId: '98765432-1098-7654-3210-fedcba987654',
        },
      ];

      const mockClobClient = { deleteApiKey: vi.fn().mockResolvedValue({ success: true }) };
      (initializeClobClient as any).mockResolvedValue(mockClobClient);

      for (const testCase of testCases) {
        (callLLMWithTimeout as any).mockResolvedValueOnce(testCase.expectedId);

        const testMessage = {
          content: { text: testCase.message },
        } as any;

        await revokeApiKeyAction.handler(mockRuntime, testMessage, mockState, {}, mockCallback);

        expect(callLLMWithTimeout).toHaveBeenCalledWith(
          mockRuntime,
          mockState,
          expect.stringContaining(testCase.message),
          'revokeApiKeyAction',
          5000
        );
      }
    });
  });

  describe('action properties', () => {
    it('should have correct action name', () => {
      expect(revokeApiKeyAction.name).toBe('DELETE_API_KEY');
    });

    it('should have appropriate similes', () => {
      expect(revokeApiKeyAction.similes).toContain('REVOKE_API_KEY');
      expect(revokeApiKeyAction.similes).toContain('DELETE_POLYMARKET_API_KEY');
      expect(revokeApiKeyAction.similes).toContain('REMOVE_API_CREDENTIALS');
    });

    it('should have proper description', () => {
      expect(revokeApiKeyAction.description).toContain('Revoke/delete');
      expect(revokeApiKeyAction.description).toContain('API key');
      expect(revokeApiKeyAction.description).toContain('CLOB authentication');
    });

    it('should have example conversations', () => {
      expect(revokeApiKeyAction.examples).toHaveLength(2);
      expect(revokeApiKeyAction.examples[0][0].content.text).toContain('Revoke API key');
      expect(revokeApiKeyAction.examples[1][0].content.text).toContain('Delete my CLOB');
    });
  });
});
