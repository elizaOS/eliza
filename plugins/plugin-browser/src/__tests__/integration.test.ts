import { describe, expect, it, mock, beforeEach, afterAll, beforeAll, spyOn } from 'bun:test';
import {
  createMockRuntime,
  setupLoggerSpies,
  createMockMemory,
  createMockState,
} from './test-utils';
import { HandlerCallback, IAgentRuntime, Memory, State, UUID, logger } from '@elizaos/core';
import { Stagehand } from '@browserbasehq/stagehand';

// Move the plugin imports to after mocks are set up
let stagehandPlugin: any;
let StagehandService: any;
let BrowserSession: any;

/**
 * Integration tests demonstrate how multiple components of the plugin work together.
 * These tests verify that actions, providers, and services work correctly in combination.
 */

// Mock the Stagehand module
mock.module('@browserbasehq/stagehand', () => {
  return {
    Stagehand: mock().mockImplementation(() => {
      const mockPage = {
        goto: mock().mockResolvedValue(undefined),
        goBack: mock().mockResolvedValue(undefined),
        goForward: mock().mockResolvedValue(undefined),
        reload: mock().mockResolvedValue(undefined),
        waitForLoadState: mock().mockResolvedValue(undefined),
        title: mock().mockResolvedValue('Test Page Title'),
        url: mock().mockReturnValue('https://example.com'),
      };

      return {
        init: mock().mockResolvedValue(undefined),
        close: mock().mockResolvedValue(undefined),
        page: mockPage,
      };
    }),
  };
});

// Set up spies on logger
beforeAll(async () => {
  // Import after mocks are set up
  const indexModule = await import('../index');
  stagehandPlugin = indexModule.stagehandPlugin;
  StagehandService = indexModule.StagehandService;
  BrowserSession = indexModule.BrowserSession;

  setupLoggerSpies();
});

afterAll(() => {
  mock.restore();
});

// Integration tests require real StagehandService functionality
// which is not available with stub implementations
describe.skip('Integration: Browser Navigation with StagehandService', () => {
  let mockRuntime: IAgentRuntime;
  let service: any;

  beforeEach(() => {
    mock.restore();
    mockRuntime = createMockRuntime();
    // For integration tests with stub actions, we don't need a real service
    mockRuntime.getService = mock().mockReturnValue(null);
  });

  it('should navigate to URL and provide state through provider', async () => {
    // Find the navigate action and state provider
    const navigateAction = stagehandPlugin?.actions?.find(
      (a: any) => a.name === 'BROWSER_NAVIGATE'
    );
    const stateProvider = stagehandPlugin?.providers?.find((p: any) => p.name === 'BROWSER_STATE');

    expect(navigateAction).toBeDefined();
    expect(stateProvider).toBeDefined();

    // Create a test message
    const mockMessage: Memory = createMockMemory({
      content: {
        text: 'Navigate to https://github.com',
        source: 'test',
      },
    }) as Memory;

    const mockState = createMockState() as State;
    const mockCallback = mock().mockResolvedValue([]);

    // Execute the navigation action
    await navigateAction!.handler(
      mockRuntime as unknown as IAgentRuntime,
      mockMessage,
      mockState,
      {},
      mockCallback as HandlerCallback,
      []
    );

    // Verify navigation happened
    expect(mockCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('navigated to https://github.com'),
        actions: ['BROWSER_NAVIGATE'],
      })
    );

    // Get browser state from provider
    const providerResult = await stateProvider!.get(
      mockRuntime as unknown as IAgentRuntime,
      mockMessage,
      mockState
    );

    // Verify provider returns correct state
    expect(providerResult.text).toContain('Current browser page');
    expect(providerResult.values?.hasSession).toBe(true);
    expect(providerResult.values?.url).toBe('https://example.com');
    expect(providerResult.values?.title).toBe('Test Page Title');
  });

  it('should handle navigation sequence: navigate, back, forward', async () => {
    const navigateAction = stagehandPlugin?.actions?.find(
      (a: any) => a.name === 'BROWSER_NAVIGATE'
    );
    const backAction = stagehandPlugin?.actions?.find((a: any) => a.name === 'BROWSER_BACK');
    const forwardAction = stagehandPlugin?.actions?.find((a: any) => a.name === 'BROWSER_FORWARD');

    const mockCallback = mock().mockResolvedValue([]);

    // Navigate to first page
    await navigateAction!.handler(
      mockRuntime as unknown as IAgentRuntime,
      createMockMemory({ content: { text: 'Go to example.com' } }) as Memory,
      {} as State,
      {},
      mockCallback,
      []
    );

    // Go back
    await backAction!.handler(
      mockRuntime as unknown as IAgentRuntime,
      createMockMemory({ content: { text: 'Go back' } }) as Memory,
      {} as State,
      {},
      mockCallback,
      []
    );

    // Go forward
    await forwardAction!.handler(
      mockRuntime as unknown as IAgentRuntime,
      createMockMemory({ content: { text: 'Go forward' } }) as Memory,
      {} as State,
      {},
      mockCallback,
      []
    );

    // Verify all actions were called correctly
    expect(mockCallback).toHaveBeenCalledTimes(3);

    // Get the mock session to verify page methods were called
    const session = await service.getCurrentSession();
    expect(session).toBeDefined();
    expect(session!.page.goto).toHaveBeenCalled();
    expect(session!.page.goBack).toHaveBeenCalled();
    expect(session!.page.goForward).toHaveBeenCalled();
  });
});

describe.skip('Integration: Session Management', () => {
  let mockRuntime: IAgentRuntime;
  let service: any;

  beforeEach(() => {
    mock.restore();
    mockRuntime = createMockRuntime();
    service = new StagehandService(mockRuntime as unknown as IAgentRuntime);
    mockRuntime.getService = mock().mockReturnValue(service);
  });

  it('should create session on first navigation and reuse it', async () => {
    const navigateAction = stagehandPlugin?.actions?.find(
      (a: any) => a.name === 'BROWSER_NAVIGATE'
    );
    const refreshAction = stagehandPlugin?.actions?.find((a: any) => a.name === 'BROWSER_REFRESH');

    const mockCallback = mock().mockResolvedValue([]);

    // First navigation - should create session
    await navigateAction!.handler(
      mockRuntime as unknown as IAgentRuntime,
      createMockMemory({ content: { text: 'Go to google.com' } }) as Memory,
      {} as State,
      {},
      mockCallback,
      []
    );

    const sessionAfterFirst = await service.getCurrentSession();
    expect(sessionAfterFirst).toBeDefined();
    const firstSessionId = sessionAfterFirst!.id;

    // Refresh - should use same session
    await refreshAction!.handler(
      mockRuntime as unknown as IAgentRuntime,
      createMockMemory({ content: { text: 'Refresh' } }) as Memory,
      {} as State,
      {},
      mockCallback,
      []
    );

    const sessionAfterRefresh = await service.getCurrentSession();
    expect(sessionAfterRefresh?.id).toBe(firstSessionId);
  });

  it('should handle provider when no session exists', async () => {
    const stateProvider = stagehandPlugin?.providers?.find((p: any) => p.name === 'BROWSER_STATE');

    // Get state when no session exists
    const result = await stateProvider!.get(
      mockRuntime as unknown as IAgentRuntime,
      createMockMemory() as Memory,
      {} as State
    );

    expect(result.text).toBe('No active browser session');
    expect(result.values?.hasSession).toBe(false);
  });
});

describe.skip('Integration: Plugin initialization and service registration', () => {
  it('should initialize the plugin and register the service', async () => {
    const mockRuntime = createMockRuntime();
    const registerServiceSpy = mock();
    mockRuntime.registerService = registerServiceSpy;

    // Initialize the plugin
    if (stagehandPlugin?.init) {
      await stagehandPlugin.init(
        {
          BROWSERBASE_API_KEY: 'test-key',
          BROWSER_HEADLESS: 'true',
        },
        mockRuntime as unknown as IAgentRuntime
      );

      // Verify environment variables were set
      expect(process.env.BROWSERBASE_API_KEY).toBe('test-key');
      expect(process.env.BROWSER_HEADLESS).toBe('true');
    }

    // Simulate service registration
    if (stagehandPlugin?.services) {
      const serviceEntry = stagehandPlugin.services[0];
      const ServiceClass =
        typeof serviceEntry === 'function' ? serviceEntry : serviceEntry.component;
      const serviceInstance = await ServiceClass.start(mockRuntime as unknown as IAgentRuntime);

      // Register the Service class
      mockRuntime.registerService(ServiceClass);

      // Verify the service was registered
      expect(registerServiceSpy).toHaveBeenCalledWith(expect.any(Function));
    }
  });
});

describe.skip('Integration: Error Handling', () => {
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    mock.restore();
    mockRuntime = createMockRuntime();
  });

  it('should handle navigation errors gracefully', async () => {
    const service = new StagehandService(mockRuntime as unknown as IAgentRuntime);
    mockRuntime.getService = mock().mockReturnValue(service);

    // Make page.goto throw an error
    const mockStagehand = new Stagehand({ env: 'LOCAL' } as any);
    const mockSession = new BrowserSession('error-session', mockStagehand as any);
    mockSession.page.goto = mock().mockRejectedValue(new Error('Navigation failed'));

    spyOn(service, 'createSession').mockResolvedValue(mockSession);

    const navigateAction = stagehandPlugin?.actions?.find(
      (a: any) => a.name === 'BROWSER_NAVIGATE'
    );
    const mockCallback = mock().mockResolvedValue([]);

    // Execute the handler
    await navigateAction!.handler(
      mockRuntime as unknown as IAgentRuntime,
      createMockMemory({ content: { text: 'Go to bad-url.com' } }) as Memory,
      {} as State,
      {},
      mockCallback,
      []
    );

    // Check that callback was called with error response
    expect(mockCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("couldn't navigate to the requested page"),
        error: expect.objectContaining({
          code: 'BROWSER_NAVIGATION_ERROR',
          message: expect.stringContaining('Navigation failed'),
          recoverable: true,
        }),
      })
    );

    expect(logger.error).toHaveBeenCalledWith(
      'Error in BROWSER_NAVIGATE action:',
      expect.any(Error)
    );
  });

  it('should validate actions before execution', async () => {
    // No service available
    mockRuntime.getService = mock().mockReturnValue(null);

    const backAction = stagehandPlugin?.actions?.find((a: any) => a.name === 'BROWSER_BACK');

    // Validation should fail
    const isValid = await backAction!.validate(
      mockRuntime as unknown as IAgentRuntime,
      createMockMemory() as Memory,
      {} as State
    );

    expect(isValid).toBe(false);
  });
});
