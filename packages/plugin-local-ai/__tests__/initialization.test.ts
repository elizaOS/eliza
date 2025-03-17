import { type ModelType, ModelType } from '@elizaos/core';
import { describe, expect, test } from 'vitest';
import { localAIPlugin } from '../src/index';

describe('LocalAI Plugin Initialization', () => {
  // Mock runtime for testing
  const mockRuntime = {
    useModel: async (modelType: ModelType, _params: any) => {
      if (modelType === ModelType.TEXT_SMALL) {
        return 'Initialization successful';
      }
      throw new Error(`Unexpected model class: ${modelType}`);
    },
  };

  test('should initialize plugin with default configuration', async () => {
    try {
      if (!localAIPlugin.init) {
        throw new Error('Plugin initialization failed');
      }
      // Initialize plugin
      await localAIPlugin.init({}, mockRuntime as any);

      // Run initialization test
      const result = await mockRuntime.useModel(ModelType.TEXT_SMALL, {
        context:
          "Debug Mode: Test initialization. Respond with 'Initialization successful' if you can read this.",
        stopSequences: [],
      });

      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result).toContain('successful');
    } catch (error) {
      console.error('Test failed:', error);
      throw error;
    }
  });

  // test("should initialize with custom model path", async () => {
  // 	const customConfig = {
  // 		LLAMALOCAL_PATH: "./custom/models",
  // 		CACHE_DIR: "./custom/cache",
  // 	};

  // 	try {
  // 		if (!localAIPlugin.init) {
  // 			throw new Error("Plugin initialization failed");
  // 		}
  // 		await localAIPlugin.init(customConfig, mockRuntime as any);
  // 		expect(process.env.LLAMALOCAL_PATH).toBe(customConfig.LLAMALOCAL_PATH);
  // 		expect(process.env.CACHE_DIR).toBe(customConfig.CACHE_DIR);
  // 	} catch (error) {
  // 		console.error("Test failed:", error);
  // 		throw error;
  // 	}
  // });

  // test("should handle invalid configuration", async () => {
  // 	const invalidConfig = {
  // 		LLAMALOCAL_PATH: 123, // Invalid type
  // 	};

  // 	if (!localAIPlugin.init) {
  // 		throw new Error("Plugin initialization failed");
  // 	}

  // 	await expect(localAIPlugin.init(invalidConfig as any, mockRuntime as any)).rejects.toThrow();
  // });
});
