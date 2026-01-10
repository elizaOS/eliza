import { type IAgentRuntime, ModelType, type Plugin, logger } from '@elizaos/core';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { MODEL_SPECS, type ModelSpec } from '../src/types';
import { TEST_PATHS, createMockRuntime, downloadModelMock } from './test-utils';

// Set environment variables before importing the plugin
process.env.MODELS_DIR = TEST_PATHS.MODELS_DIR;
process.env.CACHE_DIR = TEST_PATHS.CACHE_DIR;

// Mock the model download and initialization
vi.mock('../src/utils/downloadManager', () => ({
  DownloadManager: {
    getInstance: () => ({
      downloadModel: async (modelSpec: ModelSpec, modelPath: string) => {
        // Call the mock to track the call
        await downloadModelMock(modelSpec, modelPath);
      },
      getCacheDir: () => TEST_PATHS.CACHE_DIR,
      ensureDirectoryExists: vi.fn(),
    }),
  },
}));

// Import plugin after setting environment variables and mocks
import { localAiPlugin } from '../src/index';

// Type assertion for localAIPlugin
const plugin = localAiPlugin as Required<Plugin>;

describe('LocalAI Text Generation', () => {
  const mockRuntime = createMockRuntime();

  beforeEach(() => {
    // Clear mock calls before each test
    downloadModelMock.mockClear();
  });

  beforeAll(async () => {
    // Log the paths we're trying to use
    logger.info('Test is using paths:', {
      MODELS_DIR: TEST_PATHS.MODELS_DIR,
      CACHE_DIR: TEST_PATHS.CACHE_DIR,
      process_cwd: process.cwd(),
    });

    // Initialize plugin with the same paths
    await plugin.init(
      {
        MODELS_DIR: TEST_PATHS.MODELS_DIR,
        CACHE_DIR: TEST_PATHS.CACHE_DIR,
      },
      mockRuntime as IAgentRuntime
    );

    // Log environment variables after initialization
    logger.info('Environment variables after init:', {
      MODELS_DIR: process.env.MODELS_DIR,
      CACHE_DIR: process.env.CACHE_DIR,
    });
  }, 300000);

  test('should attempt to download small model when using TEXT_SMALL', async () => {
    const result = await mockRuntime.useModel(ModelType.TEXT_SMALL, {
      context: 'Generate a test response.',
      stopSequences: [],
      runtime: mockRuntime,
      modelClass: ModelType.TEXT_SMALL,
    });

    expect(downloadModelMock).toHaveBeenCalledTimes(1);
    expect(downloadModelMock.mock.calls[0][0]).toMatchObject({
      name: MODEL_SPECS.small.name,
    });
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('should attempt to download large model when using TEXT_LARGE', async () => {
    const result = await mockRuntime.useModel(ModelType.TEXT_LARGE, {
      context: 'Debug Mode: Generate a one-sentence response about artificial intelligence.',
      stopSequences: [],
      runtime: mockRuntime,
      modelClass: ModelType.TEXT_LARGE,
    });

    expect(downloadModelMock).toHaveBeenCalledTimes(1);
    expect(downloadModelMock.mock.calls[0][0]).toMatchObject({
      name: MODEL_SPECS.medium.name,
    });
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(10);
    expect(result.toLowerCase()).toContain('artificial intelligence');
  });

  test('should handle download failure gracefully', async () => {
    // Mock a download failure
    downloadModelMock.mockRejectedValueOnce(new Error('Download failed'));

    await expect(
      mockRuntime.useModel(ModelType.TEXT_SMALL, {
        context: 'This should fail due to download error',
        stopSequences: [],
        runtime: mockRuntime,
        modelClass: ModelType.TEXT_SMALL,
      })
    ).rejects.toThrow('Download failed');

    expect(downloadModelMock).toHaveBeenCalledTimes(1);
  });

  test('should handle empty context', async () => {
    await expect(
      mockRuntime.useModel(ModelType.TEXT_SMALL, {
        context: '',
        stopSequences: [],
        runtime: mockRuntime,
        modelClass: ModelType.TEXT_SMALL,
      })
    ).resolves.toBeDefined();
  });

  test('should handle stop sequences', async () => {
    const result = await mockRuntime.useModel(ModelType.TEXT_SMALL, {
      context: 'Generate a response with stop sequence.',
      stopSequences: ['STOP'],
      runtime: mockRuntime,
      modelClass: ModelType.TEXT_SMALL,
    });

    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  test('should handle model switching', async () => {
    // First use TEXT_SMALL
    const smallResult = await mockRuntime.useModel(ModelType.TEXT_SMALL, {
      context: 'Small model test',
      stopSequences: [],
      runtime: mockRuntime,
      modelClass: ModelType.TEXT_SMALL,
    });

    // Then use TEXT_LARGE
    const largeResult = await mockRuntime.useModel(ModelType.TEXT_LARGE, {
      context: 'Large model test',
      stopSequences: [],
      runtime: mockRuntime,
      modelClass: ModelType.TEXT_LARGE,
    });

    expect(smallResult).toBeDefined();
    expect(largeResult).toBeDefined();
    expect(smallResult).not.toBe(largeResult);

    // Verify both models were attempted to be downloaded
    expect(downloadModelMock).toHaveBeenCalledTimes(2);
    expect(downloadModelMock.mock.calls[0][0]).toMatchObject({
      name: MODEL_SPECS.small.name,
    });
    expect(downloadModelMock.mock.calls[1][0]).toMatchObject({
      name: MODEL_SPECS.medium.name,
    });
  });
});
