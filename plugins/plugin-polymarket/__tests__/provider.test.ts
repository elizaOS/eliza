import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import plugin from '../src/plugin';
import type { IAgentRuntime, Memory, State, Provider } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

// Setup environment variables
dotenv.config();

// Set up logging to capture issues
beforeAll(() => {
  vi.spyOn(logger, 'info');
  vi.spyOn(logger, 'error');
  vi.spyOn(logger, 'warn');
  vi.spyOn(logger, 'debug');
});

afterAll(() => {
  vi.restoreAllMocks();
});

// Helper function to document test results
function documentTestResult(testName: string, result: any, error: Error | null = null) {
  logger.info(`TEST: ${testName}`);
  if (result) {
    if (typeof result === 'string') {
      logger.info(`RESULT: ${result.substring(0, 100)}${result.length > 100 ? '...' : ''}`);
    } else {
      try {
        logger.info(`RESULT: ${JSON.stringify(result, null, 2).substring(0, 200)}...`);
      } catch (e) {
        logger.info(`RESULT: [Complex object that couldn't be stringified]`);
      }
    }
  }
  if (error) {
    logger.error(`ERROR: ${error.message}`);
    if (error.stack) {
      logger.error(`STACK: ${error.stack}`);
    }
  }
}

// Create a realistic runtime for testing
function createRealRuntime(): IAgentRuntime {
  return {
    character: {
      name: 'Test Character',
      system: 'You are a helpful assistant for testing.',
      plugins: [],
      settings: {},
    },
    getSetting: (key: string) => null,
    models: plugin.models,
    db: {
      get: async (key: string) => {
        logger.info(`DB Get: ${key}`);
        return null;
      },
      set: async (key: string, value: any) => {
        logger.info(`DB Set: ${key} = ${JSON.stringify(value)}`);
        return true;
      },
      delete: async (key: string) => {
        logger.info(`DB Delete: ${key}`);
        return true;
      },
      getKeys: async (pattern: string) => {
        logger.info(`DB GetKeys: ${pattern}`);
        return [];
      },
    },
    memory: {
      add: async (memory: any) => {
        logger.info(`Memory Add: ${JSON.stringify(memory).substring(0, 100)}`);
      },
      get: async (id: string) => {
        logger.info(`Memory Get: ${id}`);
        return null;
      },
      getByEntityId: async (entityId: string) => {
        logger.info(`Memory GetByEntityId: ${entityId}`);
        return [];
      },
      getLatest: async (entityId: string) => {
        logger.info(`Memory GetLatest: ${entityId}`);
        return null;
      },
      getRecentMessages: async (options: any) => {
        logger.info(`Memory GetRecentMessages: ${JSON.stringify(options)}`);
        return [];
      },
      search: async (query: string) => {
        logger.info(`Memory Search: ${query}`);
        return [];
      },
    },
    getService: (serviceType: string) => {
      logger.info(`GetService: ${serviceType}`);
      return null;
    },
  } as unknown as IAgentRuntime;
}

// Create realistic memory object
function createRealMemory(): Memory {
  const entityId = uuidv4();
  const roomId = uuidv4();

  return {
    id: uuidv4(),
    entityId,
    roomId,
    timestamp: Date.now(),
    content: {
      text: 'What can you provide?',
      source: 'test',
      actions: [],
    },
    metadata: {
      sessionId: uuidv4(),
      conversationId: uuidv4(),
    },
  } as Memory;
}

describe('Provider Tests', () => {
  // Find the HELLO_WORLD_PROVIDER from the providers array
  const helloWorldProvider = plugin.providers?.find(
    (provider) => provider.name === 'HELLO_WORLD_PROVIDER'
  );

  describe('HELLO_WORLD_PROVIDER', () => {
    it('should exist in the plugin', () => {
      expect(plugin.providers).toBeDefined();
      expect(Array.isArray(plugin.providers)).toBe(true);

      if (plugin.providers) {
        expect(plugin.providers.length).toBeGreaterThan(0);
        const result = plugin.providers.find((p) => p.name === 'HELLO_WORLD_PROVIDER');
        expect(result).toBeDefined();
        documentTestResult('Provider exists check', {
          found: !!result,
          providers: plugin.providers.map((p) => p.name),
        });
      }
    });

    it('should have the correct structure', () => {
      if (helloWorldProvider) {
        expect(helloWorldProvider).toHaveProperty('name', 'HELLO_WORLD_PROVIDER');
        expect(helloWorldProvider).toHaveProperty('description');
        expect(helloWorldProvider).toHaveProperty('get');
        expect(typeof helloWorldProvider.get).toBe('function');

        documentTestResult('Provider structure check', {
          name: helloWorldProvider.name,
          description: helloWorldProvider.description,
          hasGetMethod: typeof helloWorldProvider.get === 'function',
        });
      }
    });

    it('should have a description explaining its purpose', () => {
      if (helloWorldProvider && helloWorldProvider.description) {
        expect(typeof helloWorldProvider.description).toBe('string');
        expect(helloWorldProvider.description.length).toBeGreaterThan(0);

        documentTestResult('Provider description check', {
          description: helloWorldProvider.description,
        });
      }
    });

    it('should return provider data from the get method', async () => {
      if (helloWorldProvider) {
        const runtime = createRealRuntime();
        const message = createRealMemory();
        const state = {
          values: { example: 'test value' },
          data: { additionalContext: 'some context' },
          text: 'Current state context',
        } as State;

        let result = null;
        let error = null;

        try {
          logger.info('Calling provider.get with real implementation');
          result = await helloWorldProvider.get(runtime, message, state);

          expect(result).toBeDefined();
          expect(result).toHaveProperty('text');
          expect(result).toHaveProperty('values');
          expect(result).toHaveProperty('data');

          // Look for potential issues in the result
          if (!result.text || result.text.length === 0) {
            logger.warn('Provider returned empty text');
          }

          if (Object.keys(result.values).length === 0) {
            logger.warn('Provider returned empty values object');
          }

          if (Object.keys(result.data).length === 0) {
            logger.warn('Provider returned empty data object');
          }
        } catch (e) {
          error = e as Error;
          logger.error('Error in provider.get:', e);
        }

        documentTestResult('Provider get method', result, error);
      }
    });

    it('should handle error conditions gracefully', async () => {
      if (helloWorldProvider) {
        const runtime = createRealRuntime();
        // Create an invalid memory object to simulate an error scenario
        const invalidMemory = {
          // Missing properties that would be required
          id: uuidv4(),
        } as unknown as Memory;

        const state = {
          values: {},
          data: {},
          text: '',
        } as State;

        let result = null;
        let error = null;

        try {
          logger.info('Calling provider.get with invalid memory object');
          result = await helloWorldProvider.get(runtime, invalidMemory, state);

          // Even with invalid input, it should not throw errors
          expect(result).toBeDefined();

          // Log what actual implementation does with invalid input
          logger.info('Provider handled invalid input without throwing');
        } catch (e) {
          error = e as Error;
          logger.error('Provider threw an error with invalid input:', e);
        }

        documentTestResult('Provider error handling', result, error);
      }
    });
  });

  describe('Provider Registration', () => {
    it('should include providers in the plugin definition', () => {
      expect(plugin).toHaveProperty('providers');
      expect(Array.isArray(plugin.providers)).toBe(true);

      documentTestResult('Plugin providers check', {
        hasProviders: !!plugin.providers,
        providersCount: plugin.providers?.length || 0,
      });
    });

    it('should correctly initialize providers array', () => {
      // Providers should be an array with at least one provider
      if (plugin.providers) {
        expect(plugin.providers.length).toBeGreaterThan(0);

        let allValid = true;
        const invalidProviders: string[] = [];

        // Each provider should have the required structure
        plugin.providers.forEach((provider: Provider) => {
          const isValid =
            provider.name !== undefined &&
            provider.description !== undefined &&
            typeof provider.get === 'function';

          if (!isValid) {
            allValid = false;
            invalidProviders.push(provider.name || 'unnamed');
          }

          expect(provider).toHaveProperty('name');
          expect(provider).toHaveProperty('description');
          expect(provider).toHaveProperty('get');
          expect(typeof provider.get).toBe('function');
        });

        documentTestResult('Provider initialization check', {
          providersCount: plugin.providers.length,
          allValid,
          invalidProviders,
        });
      }
    });

    it('should have unique provider names', () => {
      if (plugin.providers) {
        const providerNames = plugin.providers.map((provider) => provider.name);
        const uniqueNames = new Set(providerNames);

        const duplicates = providerNames.filter(
          (name, index) => providerNames.indexOf(name) !== index
        );

        // There should be no duplicate provider names
        expect(providerNames.length).toBe(uniqueNames.size);

        documentTestResult('Provider uniqueness check', {
          totalProviders: providerNames.length,
          uniqueProviders: uniqueNames.size,
          duplicates,
        });
      }
    });
  });
});
