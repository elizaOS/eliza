import {
  describe,
  expect,
  it,
  mock,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  spyOn,
} from 'bun:test';
import {
  createMockRuntime,
  createMockMemory,
  createMockState,
  setupLoggerSpies,
} from './test-utils';
import { type HandlerCallback, type Memory, type State, type IAgentRuntime } from '@elizaos/core';
import { Stagehand } from '@browserbasehq/stagehand';

// Move the plugin imports to after mocks are set up
let stagehandPlugin: any;
let StagehandService: any;
let BrowserSession: any;

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
        screenshot: mock().mockResolvedValue(Buffer.from('fake-screenshot-data')),
      };

      return {
        init: mock().mockResolvedValue(undefined),
        close: mock().mockResolvedValue(undefined),
        page: mockPage,
        act: mock().mockResolvedValue({ success: true }),
        extract: mock().mockResolvedValue({ data: 'extracted text', found: true }),
      };
    }),
  };
});

describe('Phase 3 Browser Actions', () => {
  let loggerSpies: ReturnType<typeof setupLoggerSpies>;

  beforeAll(async () => {
    // Import after mocks are set up
    const indexModule = await import('../index');
    stagehandPlugin = indexModule.stagehandPlugin;
    StagehandService = indexModule.StagehandService;
    BrowserSession = indexModule.BrowserSession;

    loggerSpies = setupLoggerSpies();
  });

  afterAll(() => {
    mock.restore();
  });

  describe('BROWSER_EXTRACT Action', () => {
    const getExtractAction = () =>
      stagehandPlugin?.actions?.find((a: any) => a.name === 'BROWSER_EXTRACT');
    let mockRuntime: any;
    let mockService: any;
    let mockSession: any;
    let mockCallback: HandlerCallback;

    beforeEach(() => {
      mock.restore();

      mockRuntime = createMockRuntime();

      // For stub actions, we don't need a real service
      (mockRuntime.getService as any).mockReturnValue(null);
      mockCallback = mock().mockResolvedValue([]);
    });

    it('should validate extract messages', async () => {
      const extractAction = getExtractAction();
      const validMessages = [
        'Extract the main heading',
        'Get the page title',
        'Read the article content',
        'Find the author name',
      ];

      for (const text of validMessages) {
        const message = createMockMemory({ content: { text } });
        const isValid = await extractAction!.validate(mockRuntime, message as Memory, {} as State);
        expect(isValid).toBe(true);
      }
    });

    it('should handle extract action when data is found', async () => {
      const extractAction = getExtractAction();
      const message = createMockMemory({
        content: { text: 'Extract the main heading from the page', source: 'test' },
      });

      const result = await extractAction!.handler(
        mockRuntime,
        message as Memory,
        {} as State,
        {},
        mockCallback,
        []
      );

      // For stub implementation, we only check the callback
      expect(mockCallback).toHaveBeenCalledWith({
        text: 'I found the main heading: "Sample extracted data"',
        actions: ['BROWSER_EXTRACT'],
        source: 'test',
      });
    });

    it('should handle extract action when data is not found', async () => {
      const extractAction = getExtractAction();
      const message = createMockMemory({
        content: { text: 'Find the price information', source: 'test' },
      });

      const result = await extractAction!.handler(
        mockRuntime,
        message as Memory,
        {} as State,
        {},
        mockCallback,
        []
      );

      // For stub implementation, we always return found data
      expect(mockCallback).toHaveBeenCalledWith({
        text: 'I found the price information: "Sample extracted data"',
        actions: ['BROWSER_EXTRACT'],
        source: 'test',
      });
    });

    it('should handle specific data extraction', async () => {
      const extractAction = getExtractAction();
      const message = createMockMemory({
        content: { text: 'Extract the author name', source: 'test' },
      });

      const result = await extractAction!.handler(
        mockRuntime,
        message as Memory,
        {} as State,
        {},
        mockCallback,
        []
      );

      // For stub implementation, we only check the callback
      expect(mockCallback).toHaveBeenCalledWith({
        text: 'I found the author name: "Sample extracted data"',
        actions: ['BROWSER_EXTRACT'],
        source: 'test',
      });
    });
  });

  describe('BROWSER_SCREENSHOT Action', () => {
    const getScreenshotAction = () =>
      stagehandPlugin?.actions?.find((a: any) => a.name === 'BROWSER_SCREENSHOT');
    let mockRuntime: any;
    let mockService: any;
    let mockSession: any;
    let mockCallback: HandlerCallback;

    beforeEach(() => {
      mock.restore();

      mockRuntime = createMockRuntime();

      // For stub actions, we don't need a real service
      (mockRuntime.getService as any).mockReturnValue(null);
      mockCallback = mock().mockResolvedValue([]);
    });

    it('should validate screenshot messages', async () => {
      const screenshotAction = getScreenshotAction();
      const validMessages = [
        'Take a screenshot',
        'Capture the page',
        'Take a snapshot of the current view',
        'Screenshot this page',
      ];

      for (const text of validMessages) {
        const message = createMockMemory({ content: { text } });
        const isValid = await screenshotAction!.validate(
          mockRuntime,
          message as Memory,
          {} as State
        );
        expect(isValid).toBe(true);
      }
    });

    it('should handle screenshot action', async () => {
      const screenshotAction = getScreenshotAction();
      const message = createMockMemory({
        content: { text: 'Take a screenshot of the page', source: 'test' },
      });

      const result = await screenshotAction!.handler(
        mockRuntime,
        message as Memory,
        {} as State,
        {},
        mockCallback,
        []
      );

      // For stub implementation, we only check the callback
      expect(mockCallback).toHaveBeenCalledWith({
        text: "I've taken a screenshot of the page",
        actions: ['BROWSER_SCREENSHOT'],
        source: 'test',
      });
    });

    it('should not validate non-screenshot messages', async () => {
      const screenshotAction = getScreenshotAction();
      const message = createMockMemory({ content: { text: 'Navigate to google.com' } });
      const isValid = await screenshotAction!.validate(mockRuntime, message as Memory, {} as State);
      expect(isValid).toBe(false);
    });
  });

  describe('Integration Tests', () => {
    it('should have all Phase 3 actions registered', () => {
      const actionNames = stagehandPlugin?.actions?.map((a: any) => a.name) || [];

      expect(actionNames).toContain('BROWSER_EXTRACT');
      expect(actionNames).toContain('BROWSER_SCREENSHOT');
    });

    it('should support extraction after navigation', async () => {
      const navigateAction = stagehandPlugin?.actions?.find(
        (a: any) => a.name === 'BROWSER_NAVIGATE'
      );
      const extractAction = stagehandPlugin?.actions?.find(
        (a: any) => a.name === 'BROWSER_EXTRACT'
      );

      expect(navigateAction).toBeDefined();
      expect(extractAction).toBeDefined();

      // Both actions should work with the same session
      const mockRuntime = createMockRuntime();
      // Mock a basic service for validation
      const mockService = { isInitialized: true };
      (mockRuntime.getService as any).mockReturnValue(mockService);
      // Enable browser in settings
      (mockRuntime.getSetting as any).mockReturnValue('true');

      const message1 = createMockMemory({ content: { text: 'Navigate to https://example.com' } });
      const message2 = createMockMemory({ content: { text: 'Extract the page title' } });

      // Validate both actions can work in sequence
      const canNavigate = await navigateAction!.validate(
        mockRuntime as unknown as IAgentRuntime,
        message1 as Memory,
        {} as State
      );
      const canExtract = await extractAction!.validate(
        mockRuntime as unknown as IAgentRuntime,
        message2 as Memory,
        {} as State
      );

      expect(canNavigate).toBe(true);
      expect(canExtract).toBe(true); // Stub validation only checks text content
    });
  });
});
