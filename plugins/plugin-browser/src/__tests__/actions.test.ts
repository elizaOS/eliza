import { describe, expect, it, mock, beforeEach, spyOn } from 'bun:test';
import { Memory, State, HandlerCallback, IAgentRuntime, logger, UUID } from '@elizaos/core';
import {
  createMockRuntime,
  createMockMemory,
  createMockState,
  setupLoggerSpies,
} from './test-utils';
import { stagehandPlugin } from '../index';
import { StagehandService, BrowserSession } from '../service';
import { StagehandWebSocketClient } from '../websocket-client';

// Mock modules
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

mock.module('../websocket-client', () => ({
  StagehandWebSocketClient: mock().mockImplementation(() => ({
    navigate: mock().mockResolvedValue({
      url: 'https://example.com',
      title: 'Example Domain',
    }),
    getState: mock().mockResolvedValue({
      url: 'https://example.com',
      title: 'Example Domain',
      sessionId: 'test-session-1',
      createdAt: new Date(),
    }),
    goBack: mock().mockResolvedValue({
      url: 'https://previous.com',
      title: 'Previous Page',
    }),
    goForward: mock().mockResolvedValue({
      url: 'https://next.com',
      title: 'Next Page',
    }),
    refresh: mock().mockResolvedValue({
      url: 'https://current.com',
      title: 'Current Page',
    }),
  })),
}));

describe('BROWSER_NAVIGATE action', () => {
  let mockRuntime: IAgentRuntime;
  let mockService: any;
  let mockClient: any;
  let mockSession: any;
  let mockCallback: HandlerCallback;
  let browserNavigateAction: any;

  beforeEach(() => {
    setupLoggerSpies();

    // Reset mocks
    mockSession = new BrowserSession('test-session-1');
    mockClient = new StagehandWebSocketClient('ws://localhost:3456');

    mockService = {
      getCurrentSession: mock().mockResolvedValue(mockSession),
      createSession: mock().mockResolvedValue(mockSession),
      getClient: mock().mockReturnValue(mockClient),
      isInitialized: true,
    };

    mockRuntime = createMockRuntime({
      getService: mock().mockReturnValue(mockService),
    });

    mockCallback = mock();

    // Get the browser navigate action from the plugin
    browserNavigateAction = stagehandPlugin.actions?.find(
      (action) => action.name === 'BROWSER_NAVIGATE'
    );
  });

  describe('validate', () => {
    it('should validate when URL is found in message', async () => {
      const message = createMockMemory({
        content: { text: 'Navigate to https://google.com', source: 'test' },
      });

      const isValid = await browserNavigateAction.validate(
        mockRuntime,
        message as Memory,
        {} as State
      );

      expect(isValid).toBe(true);
    });

    it('should validate domain without protocol', async () => {
      const message = createMockMemory({
        content: { text: 'Go to example.com', source: 'test' },
      });

      const isValid = await browserNavigateAction.validate(
        mockRuntime,
        message as Memory,
        {} as State
      );

      expect(isValid).toBe(true);
    });

    it('should validate URL in quotes', async () => {
      const message = createMockMemory({
        content: { text: 'Open "https://example.com" in browser', source: 'test' },
      });

      const isValid = await browserNavigateAction.validate(
        mockRuntime,
        message as Memory,
        {} as State
      );

      expect(isValid).toBe(true);
    });

    it('should not validate when no URL found', async () => {
      const message = createMockMemory({
        content: { text: 'Just regular text without URLs', source: 'test' },
      });

      const isValid = await browserNavigateAction.validate(
        mockRuntime,
        message as Memory,
        {} as State
      );

      expect(isValid).toBe(false);
    });
  });

  describe('handler', () => {
    it('should navigate to URL and return success', async () => {
      const message = createMockMemory({
        content: { text: 'Navigate to https://google.com', source: 'test' },
      });

      mockClient.navigate.mockResolvedValue({
        url: 'https://google.com',
        title: 'Google',
      });

      await browserNavigateAction.handler(
        mockRuntime,
        message as Memory,
        {} as State,
        {},
        mockCallback,
        []
      );

      expect(mockClient.navigate).toHaveBeenCalledWith('test-session-1', 'https://google.com');

      expect(mockCallback).toHaveBeenCalledWith({
        text: `I've navigated to https://google.com. The page title is: "Google"`,
        actions: ['BROWSER_NAVIGATE'],
        source: 'test',
      });
    });

    it('should create session if none exists', async () => {
      mockService.getCurrentSession.mockResolvedValue(undefined);

      const message = createMockMemory({
        content: { text: 'Navigate to https://example.com', source: 'test' },
      });

      await browserNavigateAction.handler(
        mockRuntime,
        message as Memory,
        {} as State,
        {},
        mockCallback,
        []
      );

      expect(mockService.createSession).toHaveBeenCalledWith(expect.stringContaining('session-'));
      expect(mockClient.navigate).toHaveBeenCalled();
    });

    it('should handle domain without protocol', async () => {
      const message = createMockMemory({
        content: { text: 'Go to example.com', source: 'test' },
      });

      await browserNavigateAction.handler(
        mockRuntime,
        message as Memory,
        {} as State,
        {},
        mockCallback,
        []
      );

      expect(mockClient.navigate).toHaveBeenCalledWith('test-session-1', 'https://example.com');
    });

    it('should handle error when service not available', async () => {
      mockRuntime.getService = mock().mockReturnValue(null);

      const message = createMockMemory({
        content: { text: 'Navigate to https://example.com', source: 'test' },
      });

      await browserNavigateAction.handler(
        mockRuntime,
        message as Memory,
        {} as State,
        {},
        mockCallback,
        []
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: 'The browser automation service is not available. Please ensure the Stagehand plugin is properly configured.',
        error: true,
      });
    });

    it('should handle error when no URL found', async () => {
      const message = createMockMemory({
        content: { text: 'Just some text', source: 'test' },
      });

      await browserNavigateAction.handler(
        mockRuntime,
        message as Memory,
        {} as State,
        {},
        mockCallback,
        []
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: "I couldn't find a URL in your request. Please provide a valid URL to navigate to.",
        error: true,
      });
    });

    it('should handle navigation errors', async () => {
      const message = createMockMemory({
        content: { text: 'Navigate to https://example.com', source: 'test' },
      });

      mockClient.navigate.mockRejectedValue(new Error('Navigation failed'));

      await browserNavigateAction.handler(
        mockRuntime,
        message as Memory,
        {} as State,
        {},
        mockCallback,
        []
      );

      expect(mockCallback).toHaveBeenCalledWith({
        text: "I couldn't navigate to the requested page. Please check the URL and try again.",
        error: true,
      });
    });
  });

  describe('examples', () => {
    it('should have valid examples', () => {
      expect(browserNavigateAction.examples).toBeDefined();
      expect(Array.isArray(browserNavigateAction.examples)).toBe(true);
      expect(browserNavigateAction.examples.length).toBeGreaterThan(0);

      // Check that examples have required fields
      browserNavigateAction.examples.forEach((example: any) => {
        expect(Array.isArray(example)).toBe(true);
        expect(example[0].name).toBeDefined();
        expect(example[0].content.text).toBeDefined();
        expect(example[1].name).toBeDefined();
        expect(example[1].content.text).toBeDefined();
        expect(example[1].content.actions).toContain('BROWSER_NAVIGATE');
      });
    });
  });

  describe('action metadata', () => {
    it('should have correct action name', () => {
      expect(browserNavigateAction.name).toBe('BROWSER_NAVIGATE');
    });

    it('should have similes', () => {
      expect(browserNavigateAction.similes).toBeDefined();
      expect(browserNavigateAction.similes).toContain('GO_TO_URL');
      expect(browserNavigateAction.similes).toContain('OPEN_WEBSITE');
    });

    it('should have a description', () => {
      expect(browserNavigateAction.description).toContain('Navigate');
    });
  });
});

// Additional tests for other actions would follow the same pattern
// For now, we'll test the core navigation action thoroughly
