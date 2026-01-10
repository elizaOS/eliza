import { describe, test, expect, jest, beforeEach, afterEach } from 'bun:test';
import { openrouterPlugin } from '../src/index';
import { logger } from '@elizaos/core';
import * as undici from 'undici';

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

describe('OpenRouter Plugin Configuration', () => {
  beforeEach(() => {
    // Stub undici fetch to prevent network calls
    jest.spyOn(undici, 'fetch').mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [] }),
        headers: new Headers(),
      } as any)
    );
  });

  afterEach(() => {
    // Clear all mocks
    jest.restoreAllMocks();
  });
  test('should warn when API key is missing', async () => {
    // Save original env value
    const originalApiKey = process.env.OPENROUTER_API_KEY;

    // Clear API key from environment
    delete process.env.OPENROUTER_API_KEY;

    // Create a mock runtime with no API key
    const mockRuntime = createMockRuntime({});

    // Spy on logger warnings
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    // Initialize plugin
    if (openrouterPlugin.init) {
      await openrouterPlugin.init({}, mockRuntime);
    }

    // Wait a tick for async initialization
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Check that warning was logged
    expect(warnSpy).toHaveBeenCalled();

    // Restore mock
    warnSpy.mockRestore();

    // Restore original env value
    if (originalApiKey) {
      process.env.OPENROUTER_API_KEY = originalApiKey;
    }
  });

  test('should initialize properly with valid API key', async () => {
    // Skip if no API key available for testing
    if (!process.env.OPENROUTER_API_KEY) {
      console.warn('Skipping test: OPENROUTER_API_KEY not set');
      return;
    }

    // Create a mock runtime with API key
    const mockRuntime = createMockRuntime({
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    });

    // Initialize plugin
    if (openrouterPlugin.init) {
      await openrouterPlugin.init({}, mockRuntime);
    }

    // Wait a tick for async validation
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Check that fetch was called to validate API key
    expect(undici.fetch).toHaveBeenCalled();
    expect(undici.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/models'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.stringContaining('Bearer'),
        }),
      })
    );
  });

  test('should use custom image model when configured', () => {
    // Create a mock runtime with custom model settings
    const customImageModel = 'anthropic/claude-3-opus-vision';
    const mockRuntime = createMockRuntime({
      OPENROUTER_IMAGE_MODEL: customImageModel,
      OPENROUTER_API_KEY: 'test-api-key',
    });

    // Create spy to access private function
    const getSpy = jest.spyOn(mockRuntime, 'getSetting');

    // Check if our model is used
    if (openrouterPlugin.models && openrouterPlugin.models['IMAGE_DESCRIPTION']) {
      const imageDescHandler = openrouterPlugin.models['IMAGE_DESCRIPTION'];

      // Just initiating the handler should call getSetting with OPENROUTER_IMAGE_MODEL
      try {
        imageDescHandler(mockRuntime, 'https://example.com/image.jpg');
      } catch (err) {
        // We expect an error since we're not making a real API call
        // We just want to verify getSetting was called
      }

      // Verify getSetting was called with OPENROUTER_IMAGE_MODEL
      expect(getSpy).toHaveBeenCalledWith('OPENROUTER_IMAGE_MODEL');
    }
  });

  test('should have TEXT_EMBEDDING model registered', () => {
    const { models } = openrouterPlugin;
    expect(models).toBeDefined();
    if (!models) return;
    expect(models).toHaveProperty('TEXT_EMBEDDING');
    expect(typeof models['TEXT_EMBEDDING']).toBe('function');
  });

  test('should use default embedding model', () => {
    const mockRuntime = createMockRuntime({
      OPENROUTER_API_KEY: 'test-api-key',
    });

    // Create spy to access getSetting calls
    const getSpy = jest.spyOn(mockRuntime, 'getSetting');

    if (openrouterPlugin.models && openrouterPlugin.models['TEXT_EMBEDDING']) {
      const embeddingHandler = openrouterPlugin.models['TEXT_EMBEDDING'];

      // Call with null to trigger the test embedding path (no API call)
      try {
        embeddingHandler(mockRuntime, null);
      } catch (err) {
        // Ignore errors, we just want to verify config access
      }

      // Verify getSetting was called with OPENROUTER_EMBEDDING_MODEL or EMBEDDING_MODEL
      const calls = getSpy.mock.calls.map((call) => call[0]);
      expect(
        calls.some(
          (call) =>
            call === 'OPENROUTER_EMBEDDING_MODEL' ||
            call === 'EMBEDDING_MODEL' ||
            call === 'OPENROUTER_EMBEDDING_DIMENSIONS' ||
            call === 'EMBEDDING_DIMENSIONS'
        )
      ).toBe(true);
    }
  });
});
