import { ModelType, type ModelTypeName } from '@elizaos/core';
import { describe, expect, test } from 'vitest';
import { localAiPlugin } from '../src/index';

describe('LocalAI Plugin Initialization', () => {
  // Mock runtime for testing
  const mockRuntime = {
    useModel: async (modelType: ModelTypeName, _params: any) => {
      if (modelType === ModelType.TEXT_SMALL) {
        return 'Initialization successful';
      }
      throw new Error(`Unexpected model class: ${modelType}`);
    },
  };

  test('should initialize plugin with default configuration', async () => {
    try {
      if (!localAiPlugin.init) {
        throw new Error('Plugin initialization failed');
      }
      // Initialize plugin
      await localAiPlugin.init({}, mockRuntime as any);

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
});
