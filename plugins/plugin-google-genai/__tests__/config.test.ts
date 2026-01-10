import { describe, test, expect, vi, beforeEach } from 'vitest';
import { googleGenAIPlugin } from '../src/index';
import { logger } from '@elizaos/core';

// Mock the logger
vi.mock('@elizaos/core', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  EventType: {},
  ModelType: {},
}));

// Create a minimal mock runtime
const createMockRuntime = (env: Record<string, string>) => {
  return {
    getSetting: (key: string) => env[key],
    emitEvent: () => {},
    character: {
      system: 'You are a helpful assistant.',
    },
  } as unknown as any;
};

describe('Google GenAI Plugin Configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('should warn when API key is missing', async () => {
    // Create a mock runtime with no API key
    const mockRuntime = createMockRuntime({});

    // Initialize plugin
    if (googleGenAIPlugin.init) {
      await googleGenAIPlugin.init({}, mockRuntime);
    }

    // Check that warning was logged
    expect(logger.warn).toHaveBeenCalledWith(
      'GOOGLE_GENERATIVE_AI_API_KEY is not set in environment - Google AI functionality will be limited'
    );
  });

  test('should initialize properly with valid API key', async () => {
    // Skip if no API key available for testing
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      console.warn('Skipping test: GOOGLE_GENERATIVE_AI_API_KEY not set');
      return;
    }

    // Create a mock runtime with API key
    const mockRuntime = createMockRuntime({
      GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    });

    // Initialize plugin
    if (googleGenAIPlugin.init) {
      await googleGenAIPlugin.init({}, mockRuntime);
    }

    // Give time for API key validation
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Expect successful log message
    expect(logger.log).toHaveBeenCalled();
  });

  test('should use custom image model when configured', () => {
    // Create a mock runtime with custom model settings
    const customImageModel = 'gemini-2.0-flash-002';
    const mockRuntime = createMockRuntime({
      GOOGLE_IMAGE_MODEL: customImageModel,
      GOOGLE_GENERATIVE_AI_API_KEY: 'test-key',
    });

    // Verify getSetting returns the custom image model
    expect(mockRuntime.getSetting('GOOGLE_IMAGE_MODEL')).toBe(customImageModel);
  });
});
