import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { StagehandService } from '../service.js';
import { stagehandPlugin } from '../plugin.js';
import { StagehandProcessManager } from '../process-manager.js';
import { StagehandWebSocketClient } from '../websocket-client.js';

// Mock runtime for testing
const createMockRuntime = (): IAgentRuntime =>
  ({
    getSetting: (key: string) => {
      if (key === 'ENABLE_BROWSER' || key === 'BROWSER_ENABLED') {
        return 'true';
      }
      return undefined;
    },
    getService: (serviceName: string) => {
      if (serviceName === StagehandService.serviceType) {
        return service;
      }
      return null;
    },
    registerService: mock(),
  }) as unknown as IAgentRuntime;

// Create memory object
const createMemory = (text: string): Memory =>
  ({
    id: `mem-${Date.now()}`,
    userId: 'test-user',
    agentId: 'test-agent',
    roomId: 'test-room',
    content: { text },
    createdAt: new Date(),
  }) as Memory;

let service: StagehandService;
let runtime: IAgentRuntime;

describe('E2E Browser Actions', () => {
  beforeAll(async () => {
    // Create the service
    runtime = createMockRuntime();
    service = new StagehandService();

    // Initialize the service
    await service.init(runtime);

    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }, 30000);

  afterAll(async () => {
    // Clean up
    if (service) {
      await service.stop();
    }
  }, 10000);

  it('should navigate to a URL', async () => {
    const navigateAction = stagehandPlugin.actions?.find((a) => a.name === 'BROWSER_NAVIGATE');
    expect(navigateAction).toBeDefined();

    const message = createMemory('Navigate to https://example.com');
    const state = {} as State;

    // Validate the action
    const canNavigate = await navigateAction!.validate(runtime, message, state);
    expect(canNavigate).toBe(true);

    // Execute the action
    const mockCallback = mock();
    const result = await navigateAction!.handler(runtime, message, state, {}, mockCallback);

    expect(mockCallback).toHaveBeenCalled();
    const callbackArgs = mockCallback.mock.calls[0][0];
    expect(callbackArgs.text).toContain('navigated to https://example.com');
    expect(callbackArgs.actions).toContain('BROWSER_NAVIGATE');

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.data?.url).toBe('https://example.com');
  }, 30000);

  it('should click on an element', async () => {
    const clickAction = stagehandPlugin.actions?.find((a) => a.name === 'BROWSER_CLICK');
    expect(clickAction).toBeDefined();

    const message = createMemory('Click on the submit button');
    const state = {} as State;

    // Validate the action
    const canClick = await clickAction!.validate(runtime, message, state);
    expect(canClick).toBe(true);

    // Execute the action
    const mockCallback = mock();
    await clickAction!.handler(runtime, message, state, {}, mockCallback);

    expect(mockCallback).toHaveBeenCalled();
    const callbackArgs = mockCallback.mock.calls[0][0];
    expect(callbackArgs.text).toContain('clicked on "the submit button"');
    expect(callbackArgs.actions).toContain('BROWSER_CLICK');
  }, 30000);

  it('should type text into a field', async () => {
    const typeAction = stagehandPlugin.actions?.find((a) => a.name === 'BROWSER_TYPE');
    expect(typeAction).toBeDefined();

    const message = createMemory('Type "hello world" in the search box');
    const state = {} as State;

    // Validate the action
    const canType = await typeAction!.validate(runtime, message, state);
    expect(canType).toBe(true);

    // Execute the action
    const mockCallback = mock();
    await typeAction!.handler(runtime, message, state, {}, mockCallback);

    expect(mockCallback).toHaveBeenCalled();
    const callbackArgs = mockCallback.mock.calls[0][0];
    expect(callbackArgs.text).toContain('typed "hello world" in the search box');
    expect(callbackArgs.actions).toContain('BROWSER_TYPE');
  }, 30000);

  it('should select an option from dropdown', async () => {
    const selectAction = stagehandPlugin.actions?.find((a) => a.name === 'BROWSER_SELECT');
    expect(selectAction).toBeDefined();

    const message = createMemory('Select "United States" from the country dropdown');
    const state = {} as State;

    // Validate the action
    const canSelect = await selectAction!.validate(runtime, message, state);
    expect(canSelect).toBe(true);

    // Execute the action
    const mockCallback = mock();
    await selectAction!.handler(runtime, message, state, {}, mockCallback);

    expect(mockCallback).toHaveBeenCalled();
    const callbackArgs = mockCallback.mock.calls[0][0];
    expect(callbackArgs.text).toContain('selected "United States" from the country dropdown');
    expect(callbackArgs.actions).toContain('BROWSER_SELECT');
  }, 30000);

  it('should extract data from page', async () => {
    const extractAction = stagehandPlugin.actions?.find((a) => a.name === 'BROWSER_EXTRACT');
    expect(extractAction).toBeDefined();

    const message = createMemory('Extract the main heading from the page');
    const state = {} as State;

    // Validate the action
    const canExtract = await extractAction!.validate(runtime, message, state);
    expect(canExtract).toBe(true);

    // Execute the action
    const mockCallback = mock();
    await extractAction!.handler(runtime, message, state, {}, mockCallback);

    expect(mockCallback).toHaveBeenCalled();
    const callbackArgs = mockCallback.mock.calls[0][0];
    expect(callbackArgs.text).toMatch(/found the main heading|couldn't find/);
    expect(callbackArgs.actions).toContain('BROWSER_EXTRACT');
  }, 30000);

  it('should take a screenshot', async () => {
    const screenshotAction = stagehandPlugin.actions?.find((a) => a.name === 'BROWSER_SCREENSHOT');
    expect(screenshotAction).toBeDefined();

    const message = createMemory('Take a screenshot of the page');
    const state = {} as State;

    // Validate the action
    const canScreenshot = await screenshotAction!.validate(runtime, message, state);
    expect(canScreenshot).toBe(true);

    // Execute the action
    const mockCallback = mock();
    await screenshotAction!.handler(runtime, message, state, {}, mockCallback);

    expect(mockCallback).toHaveBeenCalled();
    const callbackArgs = mockCallback.mock.calls[0][0];
    expect(callbackArgs.text).toContain('taken a screenshot');
    expect(callbackArgs.actions).toContain('BROWSER_SCREENSHOT');
    expect(callbackArgs.data).toBeDefined();
    expect(callbackArgs.data.mimeType).toBe('image/png');
  }, 30000);

  it('should handle navigation errors gracefully', async () => {
    const navigateAction = stagehandPlugin.actions?.find((a) => a.name === 'BROWSER_NAVIGATE');
    expect(navigateAction).toBeDefined();

    const message = createMemory('Navigate to invalid://not-a-url');
    const state = {} as State;

    // Execute the action - should handle the error
    const mockCallback = mock();
    const result = await navigateAction!.handler(runtime, message, state, {}, mockCallback);

    expect(mockCallback).toHaveBeenCalled();
    const callbackArgs = mockCallback.mock.calls[0][0];
    expect(callbackArgs.error).toBe(true);
    expect(callbackArgs.text).toContain('Security error');

    expect(result.success).toBe(false);
  }, 30000);
});
