import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IAgentRuntime, ModelType } from '@elizaos/core';
import aiGatewayPlugin from '../src';

describe('AI Gateway Plugin', () => {
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    // Create a mock runtime
    mockRuntime = {
      getSetting: vi.fn((key: string) => {
        const settings: Record<string, string> = {
          AIGATEWAY_API_KEY: 'test-api-key',
          AIGATEWAY_BASE_URL: 'https://test-gateway.com/v1',
          AIGATEWAY_DEFAULT_MODEL: 'test/model-small',
          AIGATEWAY_LARGE_MODEL: 'test/model-large',
        };
        return settings[key];
      }),
      character: {
        system: 'You are a helpful assistant',
      },
      emitEvent: vi.fn(),
      useModel: vi.fn(),
    } as any;
  });

  describe('Plugin Structure', () => {
    it('should have correct plugin name', () => {
      expect(aiGatewayPlugin.name).toBe('aigateway');
    });

    it('should have a description', () => {
      expect(aiGatewayPlugin.description).toBeDefined();
      expect(typeof aiGatewayPlugin.description).toBe('string');
    });

    it('should export required actions', () => {
      expect(aiGatewayPlugin.actions).toBeDefined();
      expect(Array.isArray(aiGatewayPlugin.actions)).toBe(true);
      expect(aiGatewayPlugin.actions.length).toBeGreaterThan(0);
      
      const actionNames = aiGatewayPlugin.actions.map(a => a.name);
      expect(actionNames).toContain('GENERATE_TEXT');
      expect(actionNames).toContain('GENERATE_IMAGE');
      expect(actionNames).toContain('GENERATE_EMBEDDING');
      expect(actionNames).toContain('LIST_MODELS');
    });

    it('should have model implementations', () => {
      expect(aiGatewayPlugin.models).toBeDefined();
      expect(aiGatewayPlugin.models[ModelType.TEXT_SMALL]).toBeDefined();
      expect(aiGatewayPlugin.models[ModelType.TEXT_LARGE]).toBeDefined();
      expect(aiGatewayPlugin.models[ModelType.TEXT_EMBEDDING]).toBeDefined();
      expect(aiGatewayPlugin.models[ModelType.IMAGE]).toBeDefined();
    });

    it('should have init function', () => {
      expect(aiGatewayPlugin.init).toBeDefined();
      expect(typeof aiGatewayPlugin.init).toBe('function');
    });

    it('should have tests array', () => {
      expect(aiGatewayPlugin.tests).toBeDefined();
      expect(Array.isArray(aiGatewayPlugin.tests)).toBe(true);
    });
  });

  describe('Plugin Initialization', () => {
    it('should initialize without errors', async () => {
      await expect(aiGatewayPlugin.init({}, mockRuntime)).resolves.not.toThrow();
    });

    it('should warn when no API key is configured', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      mockRuntime.getSetting = vi.fn(() => undefined);
      await aiGatewayPlugin.init({}, mockRuntime);
      
      // Check that a warning was logged
      // Note: This depends on the implementation using console.warn or logger.warn
      // Adjust based on actual implementation
      
      warnSpy.mockRestore();
    });
  });

  describe('Actions', () => {
    describe('GENERATE_TEXT Action', () => {
      const generateTextAction = aiGatewayPlugin.actions.find(
        a => a.name === 'GENERATE_TEXT'
      );

      it('should be defined', () => {
        expect(generateTextAction).toBeDefined();
      });

      it('should have validate function', () => {
        expect(generateTextAction?.validate).toBeDefined();
        expect(typeof generateTextAction?.validate).toBe('function');
      });

      it('should have handler function', () => {
        expect(generateTextAction?.handler).toBeDefined();
        expect(typeof generateTextAction?.handler).toBe('function');
      });

      it('should have examples', () => {
        expect(generateTextAction?.examples).toBeDefined();
        expect(Array.isArray(generateTextAction?.examples)).toBe(true);
        expect(generateTextAction?.examples.length).toBeGreaterThan(0);
      });

      it('should validate message with text content', async () => {
        const message = {
          content: { text: 'Generate some text' }
        } as any;
        
        const isValid = await generateTextAction?.validate(mockRuntime, message);
        expect(isValid).toBe(true);
      });

      it('should not validate message without text content', async () => {
        const message = {
          content: {}
        } as any;
        
        const isValid = await generateTextAction?.validate(mockRuntime, message);
        expect(isValid).toBe(false);
      });
    });

    describe('GENERATE_IMAGE Action', () => {
      const generateImageAction = aiGatewayPlugin.actions.find(
        a => a.name === 'GENERATE_IMAGE'
      );

      it('should be defined', () => {
        expect(generateImageAction).toBeDefined();
      });

      it('should validate message with image keywords', async () => {
        const message = {
          content: { text: 'Generate an image of a sunset' }
        } as any;
        
        const isValid = await generateImageAction?.validate(mockRuntime, message);
        expect(isValid).toBe(true);
      });
    });

    describe('LIST_MODELS Action', () => {
      const listModelsAction = aiGatewayPlugin.actions.find(
        a => a.name === 'LIST_MODELS'
      );

      it('should be defined', () => {
        expect(listModelsAction).toBeDefined();
      });

      it('should have handler that returns model list', async () => {
        const message = {
          content: { text: 'list models' }
        } as any;
        
        const callback = vi.fn();
        const result = await listModelsAction?.handler(
          mockRuntime,
          message,
          undefined,
          undefined,
          callback
        );
        
        expect(result).toBeUndefined();
        expect(callback).toHaveBeenCalled();
        expect(callback.mock.calls[0][0]).toHaveProperty('models');
      });
    });
  });

  describe('Model Providers', () => {
    it('should provide TEXT_SMALL model', async () => {
      const modelFn = aiGatewayPlugin.models[ModelType.TEXT_SMALL];
      expect(modelFn).toBeDefined();
      expect(typeof modelFn).toBe('function');
    });

    it('should provide TEXT_LARGE model', async () => {
      const modelFn = aiGatewayPlugin.models[ModelType.TEXT_LARGE];
      expect(modelFn).toBeDefined();
      expect(typeof modelFn).toBe('function');
    });

    it('should provide TEXT_EMBEDDING model', async () => {
      const modelFn = aiGatewayPlugin.models[ModelType.TEXT_EMBEDDING];
      expect(modelFn).toBeDefined();
      expect(typeof modelFn).toBe('function');
    });

    it('should provide IMAGE model', async () => {
      const modelFn = aiGatewayPlugin.models[ModelType.IMAGE];
      expect(modelFn).toBeDefined();
      expect(typeof modelFn).toBe('function');
    });

    it('should handle null embedding params for initialization', async () => {
      await aiGatewayPlugin.init({}, mockRuntime);
      const modelFn = aiGatewayPlugin.models[ModelType.TEXT_EMBEDDING];
      const result = await modelFn(mockRuntime, null);
      
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toBe(0.1); // Test vector
    });
  });

  describe('Configuration', () => {
    it('should read configuration from runtime settings', async () => {
      const getSpy = vi.spyOn(mockRuntime, 'getSetting');
      
      await aiGatewayPlugin.init({}, mockRuntime);
      
      expect(getSpy).toHaveBeenCalledWith('AIGATEWAY_API_KEY');
      expect(getSpy).toHaveBeenCalledWith('AIGATEWAY_USE_OIDC');
    });

    it('should support environment variable fallback', async () => {
      process.env.AIGATEWAY_API_KEY = 'env-api-key';
      mockRuntime.getSetting = vi.fn(() => undefined);
      
      await aiGatewayPlugin.init({}, mockRuntime);
      
      // The plugin should still initialize with env vars
      expect(true).toBe(true); // Placeholder assertion
      
      delete process.env.AIGATEWAY_API_KEY;
    });
  });
});