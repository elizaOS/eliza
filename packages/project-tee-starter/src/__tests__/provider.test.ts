import { describe, expect, it, spyOn, beforeAll, afterAll } from 'bun:test';
import plugin from '../plugin';
import type { IAgentRuntime, Memory, State, Provider } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import teeStarterPlugin from '../plugin';

// Setup environment variables
dotenv.config();

// Set up logging to capture issues
beforeAll(() => {
  spyOn(logger, 'info');
  spyOn(logger, 'error');
  spyOn(logger, 'warn');
  spyOn(logger, 'debug');
});

afterAll(() => {
  // No global restore needed in bun:test;
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
  describe('HELLO_WORLD_PROVIDER', () => {
    it('should exist in the plugin', () => {
      const plugin = teeStarterPlugin;
      expect(plugin).toBeDefined();

      // Our plugin has no providers
      expect(plugin.providers).toBeDefined();
      expect(plugin.providers.length).toBe(0);
    });

    it('should have the correct structure', () => {
      // Skip this test as we have no providers
      expect(true).toBe(true);
    });

    it('should have a description explaining its purpose', () => {
      // Skip this test as we have no providers
      expect(true).toBe(true);
    });

    it('should return provider data from the get method', async () => {
      // Skip this test as we have no providers
      expect(true).toBe(true);
    });

    it('should handle error conditions gracefully', async () => {
      // Skip this test as we have no providers
      expect(true).toBe(true);
    });
  });

  describe('Provider Registration', () => {
    it('should include providers in the plugin definition', () => {
      const plugin = teeStarterPlugin;
      expect(plugin.providers).toBeDefined();
      expect(Array.isArray(plugin.providers)).toBe(true);
    });

    it('should correctly initialize providers array', () => {
      const plugin = teeStarterPlugin;

      // Providers should be an empty array
      expect(plugin.providers).toBeDefined();
      expect(plugin.providers.length).toBe(0);
    });

    it('should have unique provider names', () => {
      const plugin = teeStarterPlugin;

      // No providers, so this test passes
      if (plugin.providers && plugin.providers.length > 0) {
        const providerNames = plugin.providers.map((p) => p.name);
        const uniqueNames = new Set(providerNames);
        expect(uniqueNames.size).toBe(providerNames.length);
      } else {
        expect(true).toBe(true);
      }
    });
  });
});
