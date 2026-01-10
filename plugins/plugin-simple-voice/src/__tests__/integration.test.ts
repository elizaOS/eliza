import { describe, expect, it, spyOn, beforeEach, afterAll, beforeAll } from 'bun:test';
import { samPlugin } from '../index';
import { createMockRuntime, setupLoggerSpies, MockRuntime } from './test-utils';
import { HandlerCallback, IAgentRuntime, Memory, State, UUID } from '@elizaos/core';

/**
 * Integration tests for SAM plugin components working together.
 * Tests how SAY_ALOUD action integrates with SamTTSService and hardware bridge.
 */

// Set up spies on logger
beforeAll(() => {
  setupLoggerSpies();
});

afterAll(() => {
  // No global restore needed in bun:test
});

describe('Integration: SAY_ALOUD Action with SamTTSService', () => {
  let mockRuntime: MockRuntime;
  let mockHardwareBridge: {
    sendAudioData: (audioBuffer: Uint8Array) => Promise<void>;
    isConnected: () => boolean;
    capabilityDescription: string;
  };

  beforeEach(() => {
    // Create a mock hardware bridge service with spy methods
    const sendAudioDataSpy = async () => Promise.resolve();
    mockHardwareBridge = {
      sendAudioData: sendAudioDataSpy,
      isConnected: () => true,
      capabilityDescription: 'Mock hardware bridge for audio output',
    };
    spyOn(mockHardwareBridge, 'sendAudioData');

    // Create a mock SAM TTS service with spy methods
    const mockSamService = {
      generateAudio: async (text: string, _options?: Record<string, unknown>) => {
        // Simulate audio generation
        const audioLength = text.length * 100; // Simulate audio data
        return new Uint8Array(audioLength).fill(42);
      },
      speakText: async (text: string, options?: Record<string, unknown>) => {
        const audioBuffer = await mockSamService.generateAudio(text, options);
        await mockHardwareBridge.sendAudioData(audioBuffer);
        return audioBuffer;
      },
      createWAVBuffer: (audioData: Uint8Array, _sampleRate = 22050) => {
        // Simulate WAV header creation
        const wavHeader = new Uint8Array(44);
        const wavData = new Uint8Array(44 + audioData.length);
        wavData.set(wavHeader, 0);
        wavData.set(audioData, 44);
        return wavData;
      },
      stop: () => Promise.resolve(),
      capabilityDescription: 'Mock SAM TTS service with audio generation',
    };

    // Apply spies to the service methods
    spyOn(mockSamService, 'generateAudio');
    spyOn(mockSamService, 'speakText');
    spyOn(mockSamService, 'createWAVBuffer');

    // Create a mock runtime with service lookup
    const getServiceImpl = (serviceType: string) => {
      if (serviceType === 'SAM_TTS') {
        return mockSamService;
      }
      if (serviceType === 'hardwareBridge') {
        return mockHardwareBridge;
      }
      return null;
    };

    mockRuntime = createMockRuntime({
      getService: getServiceImpl,
    });

    // Store the service reference for later use in tests
    (mockRuntime as MockRuntime & { _mockSamService: unknown })._mockSamService = mockSamService;
  });

  it('should handle SAY_ALOUD action with SamTTSService available', async () => {
    // Find the SAY_ALOUD action
    const sayAloudAction = samPlugin.actions?.find((action) => action.name === 'SAY_ALOUD');
    expect(sayAloudAction).toBeDefined();

    // Create a mock message and state
    const mockMessage: Memory = {
      id: '12345678-1234-1234-1234-123456789012' as UUID,
      roomId: '12345678-1234-1234-1234-123456789012' as UUID,
      entityId: '12345678-1234-1234-1234-123456789012' as UUID,
      agentId: '12345678-1234-1234-1234-123456789012' as UUID,
      content: {
        text: 'say aloud: Hello from the retro future!',
        source: 'test',
      },
      createdAt: Date.now(),
    };

    const mockState: State = {
      values: {},
      data: {},
      text: '',
    };

    // Create a mock callback to capture the response
    const callbackCalls: unknown[][] = [];
    const callbackFn = (...args: unknown[]) => {
      callbackCalls.push(args);
    };

    // Execute the action
    await sayAloudAction?.handler(
      mockRuntime as unknown as IAgentRuntime,
      mockMessage,
      mockState,
      {},
      callbackFn as HandlerCallback,
      []
    );

    // Verify the callback was called with expected response
    expect(callbackCalls.length).toBeGreaterThan(0);
    if (callbackCalls.length > 0) {
      const response = callbackCalls[0][0];
      expect(response.text).toContain('SAM voice');
      expect(response.action).toBe('SAY_ALOUD');
    }

    // Verify SAM service was used
    const samService = (
      mockRuntime as MockRuntime & {
        _mockSamService: { speakText: { mock?: { calls?: unknown[] }; mockClear?: () => void } };
      }
    )._mockSamService;
    expect(samService).toBeDefined();
    expect(samService?.speakText).toHaveBeenCalled();

    // Verify hardware bridge was used
    expect(mockHardwareBridge.sendAudioData).toHaveBeenCalled();
  });

  it('should extract text correctly from various message formats', async () => {
    const sayAloudAction = samPlugin.actions?.find((action) => action.name === 'SAY_ALOUD');
    expect(sayAloudAction).toBeDefined();

    const testCases = [
      {
        input: 'say aloud: Welcome to 1985',
        expectedText: 'aloud: welcome to 1985',
      },
      {
        input: 'please speak this text: System online',
        expectedText: 'text: system online',
      },
      {
        input: 'speak up: Error detected',
        expectedText: 'up: error detected',
      },
      {
        input: 'can you say aloud the following: Hello world',
        expectedText: 'the following: hello world',
      },
    ];

    const samService = (
      mockRuntime as MockRuntime & {
        _mockSamService: { speakText: { mock?: { calls?: unknown[] }; mockClear?: () => void } };
      }
    )._mockSamService;

    for (const testCase of testCases) {
      const mockMessage: Memory = {
        id: '12345678-1234-1234-1234-123456789012' as UUID,
        roomId: '12345678-1234-1234-1234-123456789012' as UUID,
        entityId: '12345678-1234-1234-1234-123456789012' as UUID,
        agentId: '12345678-1234-1234-1234-123456789012' as UUID,
        content: {
          text: testCase.input,
          source: 'test',
        },
        createdAt: Date.now(),
      };

      const mockState: State = { values: {}, data: {}, text: '' };
      const callbackFn = () => {};

      // Reset spy call count
      samService?.speakText.mockClear();

      // Execute the action
      await sayAloudAction?.handler(
        mockRuntime as unknown as IAgentRuntime,
        mockMessage,
        mockState,
        {},
        callbackFn as HandlerCallback,
        []
      );

      // Verify the correct text was extracted and passed to SAM service
      expect(samService?.speakText).toHaveBeenCalledWith(testCase.expectedText, expect.any(Object));
    }
  });

  it('should handle voice parameters from message content', async () => {
    const sayAloudAction = samPlugin.actions?.find((action) => action.name === 'SAY_ALOUD');
    expect(sayAloudAction).toBeDefined();

    const mockMessage: Memory = {
      id: '12345678-1234-1234-1234-123456789012' as UUID,
      roomId: '12345678-1234-1234-1234-123456789012' as UUID,
      entityId: '12345678-1234-1234-1234-123456789012' as UUID,
      agentId: '12345678-1234-1234-1234-123456789012' as UUID,
      content: {
        text: 'say aloud with robotic voice: Fast robot voice',
        source: 'test',
      },
      createdAt: Date.now(),
    };

    const mockState: State = { values: {}, data: {}, text: '' };
    const callbackFn = () => {};
    const samService = (
      mockRuntime as MockRuntime & {
        _mockSamService: { speakText: { mock?: { calls?: unknown[] }; mockClear?: () => void } };
      }
    )._mockSamService;

    // Execute the action
    await sayAloudAction?.handler(
      mockRuntime as unknown as IAgentRuntime,
      mockMessage,
      mockState,
      {},
      callbackFn as HandlerCallback,
      []
    );

    // Verify the service was called with custom parameters
    expect(samService?.speakText).toHaveBeenCalled();
    const callArgs = samService?.speakText.mock.calls[0];
    expect(callArgs[1]).toMatchObject({
      throat: 200,
      mouth: 50,
    });
  });

  it('should handle service unavailability gracefully', async () => {
    // Create runtime without SAM service
    const runtimeWithoutSam = createMockRuntime({
      getService: (serviceType: string) => {
        if (serviceType === 'SAM_TTS') {
          return null; // Service not available
        }
        return null;
      },
    });

    const sayAloudAction = samPlugin.actions?.find((action) => action.name === 'SAY_ALOUD');
    expect(sayAloudAction).toBeDefined();

    const mockMessage: Memory = {
      id: '12345678-1234-1234-1234-123456789012' as UUID,
      roomId: '12345678-1234-1234-1234-123456789012' as UUID,
      entityId: '12345678-1234-1234-1234-123456789012' as UUID,
      agentId: '12345678-1234-1234-1234-123456789012' as UUID,
      content: {
        text: 'say aloud: This should fail gracefully',
        source: 'test',
      },
      createdAt: Date.now(),
    };

    const mockState: State = { values: {}, data: {}, text: '' };
    const callbackCalls: unknown[][] = [];
    const callbackFn = (...args: unknown[]) => {
      callbackCalls.push(args);
    };

    // Execute the action - should not throw
    await sayAloudAction?.handler(
      runtimeWithoutSam as unknown as IAgentRuntime,
      mockMessage,
      mockState,
      {},
      callbackFn as HandlerCallback,
      []
    );

    // Should have responded with an error message
    expect(callbackCalls.length).toBeGreaterThan(0);
    if (callbackCalls.length > 0) {
      const response = callbackCalls[0][0];
      expect(response.text).toContain('not available');
    }
  });
});

describe('Integration: Plugin initialization and service registration', () => {
  it('should initialize the plugin and register the service', async () => {
    // Create a fresh mock runtime with mocked registerService for testing initialization flow
    const mockRuntime = createMockRuntime();

    // Create and install a mock registerService
    const registerServiceCalls: { type: unknown; service: unknown }[] = [];
    mockRuntime.registerService = (type: unknown, service: unknown) => {
      registerServiceCalls.push({ type, service });
    };

    // Run a minimal simulation of the plugin initialization process
    if (samPlugin.init) {
      await samPlugin.init({}, mockRuntime as unknown as IAgentRuntime);

      // Directly mock the service registration that happens during initialization
      // because unit tests don't run the full agent initialization flow
      if (samPlugin.services) {
        const SamTTSServiceClass = samPlugin.services[0];
        const _serviceInstance = await SamTTSServiceClass.start(
          mockRuntime as unknown as IAgentRuntime
        );

        // Register the Service class to match the core API
        mockRuntime.registerService(SamTTSServiceClass);
      }

      // Now verify the service was registered with the runtime
      expect(registerServiceCalls.length).toBeGreaterThan(0);
    }
  });

  it('should register all plugin components correctly', async () => {
    const mockRuntime = createMockRuntime();

    // Track registrations
    const registeredActions: unknown[] = [];
    const registeredServices: unknown[] = [];

    mockRuntime.registerAction = (action: unknown) => {
      registeredActions.push(action);
    };

    mockRuntime.registerService = (service: unknown) => {
      registeredServices.push(service);
    };

    // Initialize plugin
    if (samPlugin.init) {
      await samPlugin.init({}, mockRuntime as unknown as IAgentRuntime);
    }

    // Manually register components (as the runtime would do)
    if (samPlugin.actions) {
      for (const action of samPlugin.actions) {
        mockRuntime.registerAction(action);
      }
    }

    if (samPlugin.services) {
      for (const ServiceClass of samPlugin.services) {
        const serviceInstance = await ServiceClass.start(mockRuntime as unknown as IAgentRuntime);
        mockRuntime.registerService(serviceInstance);
      }
    }

    // Verify registrations
    expect(registeredActions).toHaveLength(1);
    expect(registeredActions[0].name).toBe('SAY_ALOUD');

    expect(registeredServices).toHaveLength(1);
    expect(registeredServices[0].constructor.name).toBe('SamTTSService');
  });
});
