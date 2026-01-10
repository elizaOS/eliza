import { describe, expect, it, mock, beforeEach, spyOn } from 'bun:test';
import { Memory, State, IAgentRuntime, logger } from '@elizaos/core';
import { createMockRuntime, createMockMemory, createMockState } from './test-utils';
import { stagehandPlugin } from '../index';
import { StagehandService, BrowserSession } from '../service';
import { StagehandWebSocketClient } from '../websocket-client';

// Mock the service
mock.module('../service', () => ({
  StagehandService: {
    serviceType: 'STAGEHAND',
    start: mock(),
    stop: mock(),
  },
  BrowserSession: mock().mockImplementation((id: string) => ({
    id,
    createdAt: new Date(),
  })),
}));

// Mock the websocket client
mock.module('../websocket-client', () => ({
  StagehandWebSocketClient: mock().mockImplementation(() => ({
    getState: mock().mockResolvedValue({
      url: 'https://example.com',
      title: 'Test Page Title',
      sessionId: 'test-session-1',
      createdAt: new Date(),
    }),
  })),
}));

describe('BROWSER_STATE provider', () => {
  let mockRuntime: IAgentRuntime;
  let mockService: any;
  let mockClient: any;
  let mockSession: any;
  let mockMessage: Memory;
  let mockState: State;
  let browserStateProvider: any;

  beforeEach(() => {
    // Reset all mocks
    mockMessage = createMockMemory();
    mockState = createMockState();

    mockSession = new BrowserSession('test-session-1');

    mockClient = new StagehandWebSocketClient('ws://localhost:3456');

    mockService = {
      getCurrentSession: mock().mockResolvedValue(mockSession),
      getClient: mock().mockReturnValue(mockClient),
      isInitialized: true,
    };

    mockRuntime = createMockRuntime({
      getService: mock().mockReturnValue(mockService),
    });

    // Mock logger
    spyOn(logger, 'error').mockImplementation(() => {});

    // Get the provider from the plugin
    browserStateProvider = stagehandPlugin.providers?.find((p) => p.name === 'BROWSER_STATE');
  });

  describe('get method', () => {
    it('should return current session information when session exists', async () => {
      const result = await browserStateProvider.get(mockRuntime, mockMessage, mockState);

      expect(result.text).toBe('Current browser page: "Test Page Title" at https://example.com');
      expect(result.values).toEqual({
        hasSession: true,
        url: 'https://example.com',
        title: 'Test Page Title',
      });
      expect(result.data.sessionId).toBe('test-session-1');
      expect(result.data.createdAt).toBeInstanceOf(Date);
    });

    it('should return no session message when no session exists', async () => {
      mockService.getCurrentSession.mockResolvedValue(undefined);

      const result = await browserStateProvider.get(mockRuntime, mockMessage, mockState);

      expect(result.text).toBe('No active browser session');
      expect(result.values).toEqual({
        hasSession: false,
      });
      expect(result.data).toEqual({});
    });

    it('should handle errors gracefully when getting page info fails', async () => {
      mockClient.getState.mockRejectedValue(new Error('Page error'));

      const result = await browserStateProvider.get(mockRuntime, mockMessage, mockState);

      expect(result.text).toBe('Error getting browser state');
      expect(result.values).toEqual({
        hasSession: true,
        error: true,
      });
      expect(logger.error).toHaveBeenCalledWith('Error getting browser state:', expect.any(Error));
    });

    it('should work when service is not available', async () => {
      mockRuntime.getService = mock().mockReturnValue(null);

      const result = await browserStateProvider.get(mockRuntime, mockMessage, mockState);

      expect(result.text).toBe('No active browser session');
      expect(result.values.hasSession).toBe(false);
    });

    it('should provide session creation time', async () => {
      const testDate = new Date('2024-01-01T00:00:00Z');
      mockSession.createdAt = testDate;

      const result = await browserStateProvider.get(mockRuntime, mockMessage, mockState);

      expect(result.data.createdAt).toEqual(testDate);
    });

    it('should handle URL without title', async () => {
      mockClient.getState.mockResolvedValue({
        url: 'https://example.com',
        title: '',
        sessionId: 'test-session-1',
        createdAt: new Date(),
      });

      const result = await browserStateProvider.get(mockRuntime, mockMessage, mockState);

      expect(result.text).toBe('Current browser page: "" at https://example.com');
    });
  });

  describe('provider structure', () => {
    it('should have correct name', () => {
      expect(browserStateProvider.name).toBe('BROWSER_STATE');
    });

    it('should have a description', () => {
      expect(browserStateProvider.description).toContain('browser state information');
    });

    it('should have get method', () => {
      expect(typeof browserStateProvider.get).toBe('function');
    });
  });
});
