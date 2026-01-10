import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAllApiKeysAction } from '../actions/getAllApiKeys';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';

// Mock the crypto module
vi.mock('crypto', () => ({
  createHmac: vi.fn(() => ({
    update: vi.fn(() => ({
      digest: vi.fn(() => 'mock-signature'),
    })),
  })),
}));

// Mock fetch globally
(global as any).fetch = vi.fn();

describe('getAllApiKeysAction', () => {
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
        if (key === 'WALLET_PRIVATE_KEY')
          return '0x1234567890123456789012345678901234567890123456789012345678901234';
        if (key === 'CLOB_API_URL') return 'https://clob.polymarket.com';
        if (key === 'CLOB_API_KEY') return 'test-api-key';
        if (key === 'CLOB_API_SECRET') return 'test-api-secret';
        if (key === 'CLOB_API_PASSPHRASE') return 'test-passphrase';
        return undefined;
      }),
    } as any;

    // Mock message
    mockMessage = {
      content: {
        text: 'Get my API keys',
      },
    } as any;

    // Mock state
    mockState = {} as State;

    // Mock callback
    mockCallback = vi.fn();
  });

  describe('validate', () => {
    it('should return true when private key is available', async () => {
      const result = await getAllApiKeysAction.validate(mockRuntime, mockMessage);
      expect(result).toBe(true);
    });

    it('should return false when no private key is available', async () => {
      mockRuntime.getSetting = vi.fn(() => undefined);
      const result = await getAllApiKeysAction.validate(mockRuntime, mockMessage);
      expect(result).toBe(false);
    });
  });

  describe('handler', () => {
    beforeEach(() => {
      // Reset fetch mock
      (global as any).fetch.mockReset();
    });

    it('should successfully retrieve non-empty array of API keys', async () => {
      // Mock successful API response with array of keys
      const mockApiKeys = [
        {
          key: 'api-key-1',
          secret: 'secret-1',
          passphrase: 'passphrase-1',
          created_at: '2023-01-01T00:00:00Z',
          active: true,
        },
        {
          key: 'api-key-2',
          secret: 'secret-2',
          passphrase: 'passphrase-2',
          created_at: '2023-01-02T00:00:00Z',
          active: false,
        },
      ];

      (global as any).fetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockApiKeys),
      });

      await getAllApiKeysAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('✅ **API Keys Retrieved Successfully**'),
        action: 'GET_API_KEYS',
        data: {
          success: true,
          apiKeys: expect.arrayContaining([
            expect.objectContaining({
              key: 'api-key-1',
              secret: 'secret-1',
              passphrase: 'passphrase-1',
            }),
          ]),
          count: 2,
          address: expect.any(String),
        },
      });

      expect(mockCallback.mock.calls[0][0].text).toContain('Total API Keys**: 2');
      expect(mockCallback.mock.calls[0][0].text).toContain('Key 1:');
      expect(mockCallback.mock.calls[0][0].text).toContain('Key 2:');
    });

    it('should handle empty array of API keys', async () => {
      // Mock API response with empty array
      (global as any).fetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue([]),
      });

      await getAllApiKeysAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('✅ **API Keys Retrieved Successfully**'),
        action: 'GET_API_KEYS',
        data: {
          success: true,
          apiKeys: [],
          count: 0,
          address: expect.any(String),
        },
      });

      expect(mockCallback.mock.calls[0][0].text).toContain('Total API Keys**: 0');
      expect(mockCallback.mock.calls[0][0].text).toContain('No API keys found');
      expect(mockCallback.mock.calls[0][0].text).toContain('CREATE_API_KEY action');
    });

    it('should handle API response with data wrapper', async () => {
      // Mock API response with data wrapper
      const mockApiResponse = {
        data: [
          {
            api_key: 'wrapped-key-1',
            api_secret: 'wrapped-secret-1',
            api_passphrase: 'wrapped-passphrase-1',
            createdAt: '2023-01-01T00:00:00Z',
          },
        ],
      };

      (global as any).fetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockApiResponse),
      });

      await getAllApiKeysAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('✅ **API Keys Retrieved Successfully**'),
        action: 'GET_API_KEYS',
        data: {
          success: true,
          apiKeys: expect.arrayContaining([
            expect.objectContaining({
              key: 'wrapped-key-1',
              secret: 'wrapped-secret-1',
              passphrase: 'wrapped-passphrase-1',
            }),
          ]),
          count: 1,
          address: expect.any(String),
        },
      });
    });

    it('should handle missing API credentials error', async () => {
      // Mock runtime without API credentials
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'WALLET_PRIVATE_KEY')
          return '0x1234567890123456789012345678901234567890123456789012345678901234';
        if (key === 'CLOB_API_URL') return 'https://clob.polymarket.com';
        return undefined; // No API credentials
      });

      await getAllApiKeysAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Failed to Retrieve API Keys**'),
        action: 'GET_API_KEYS',
        data: {
          success: false,
          error:
            'API credentials not found. You need to create API keys first using the CREATE_API_KEY action',
        },
      });
    });

    it('should handle network/auth error from API', async () => {
      // Mock failed API response
      (global as any).fetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: vi.fn().mockResolvedValue('{"error":"Invalid credentials"}'),
      });

      await getAllApiKeysAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Failed to Retrieve API Keys**'),
        action: 'GET_API_KEYS',
        data: {
          success: false,
          error: expect.stringContaining('Failed to retrieve API keys: 401 Unauthorized'),
        },
      });
    });

    it('should handle network connectivity issues', async () => {
      // Mock network error
      (global as any).fetch.mockRejectedValue(new Error('Network error'));

      await getAllApiKeysAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: expect.stringContaining('❌ **Failed to Retrieve API Keys**'),
        action: 'GET_API_KEYS',
        data: {
          success: false,
          error: 'Network error',
        },
      });
    });

    it('should truncate sensitive data in response', async () => {
      // Mock API response with long credentials
      const mockApiKeys = [
        {
          key: 'very-long-api-key-12345678901234567890',
          secret: 'very-long-secret-12345678901234567890',
          passphrase: 'very-long-passphrase-12345678901234567890',
          active: true,
        },
      ];

      (global as any).fetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockApiKeys),
      });

      await getAllApiKeysAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      const responseText = mockCallback.mock.calls[0][0].text;

      // Check that sensitive data is truncated
      expect(responseText).toContain('very-lon...');
      expect(responseText).not.toContain('very-long-secret-12345678901234567890');
      expect(responseText).not.toContain('very-long-passphrase-12345678901234567890');
    });
  });
});
