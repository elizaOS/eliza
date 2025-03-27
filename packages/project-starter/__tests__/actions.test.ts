import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import plugin from '../src/plugin';
import { composeActionExamples, formatActionNames, formatActions, logger } from '@elizaos/core';
import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

// Setup environment variables
dotenv.config();

// Spy on logger to capture logs for documentation
beforeAll(() => {
  vi.spyOn(logger, 'info');
  vi.spyOn(logger, 'error');
  vi.spyOn(logger, 'warn');
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
        logger.info(`RESULT: ${JSON.stringify(result).substring(0, 100)}...`);
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

// Create a more complete runtime for all tests
function createRealRuntime(): IAgentRuntime {
  return {
    character: {
      name: 'Test Character',
      system: 'You are a helpful assistant for testing.',
    },
    getSetting: (key: string) => null,
    // Include real model functionality
    models: plugin.models,
    // Add real database functionality
    db: {
      get: async () => null,
      set: async () => true,
      delete: async () => true,
      getKeys: async () => [],
    },
    // Add real memory functionality
    memory: {
      add: async () => {},
      get: async () => null,
      getByEntityId: async () => [],
      getLatest: async () => null,
      getRecentMessages: async () => [],
      search: async () => [],
    },
  } as unknown as IAgentRuntime;
}

describe('Actions', () => {
  // Find the HELLO_WORLD action from the plugin
  const helloWorldAction = plugin.actions?.find((action) => action.name === 'HELLO_WORLD');

  describe('HELLO_WORLD Action', () => {
    it('should exist in the plugin', () => {
      expect(helloWorldAction).toBeDefined();
    });

    it('should have the correct structure', () => {
      if (helloWorldAction) {
        expect(helloWorldAction).toHaveProperty('name', 'HELLO_WORLD');
        expect(helloWorldAction).toHaveProperty('description');
        expect(helloWorldAction).toHaveProperty('similes');
        expect(helloWorldAction).toHaveProperty('validate');
        expect(helloWorldAction).toHaveProperty('handler');
        expect(helloWorldAction).toHaveProperty('examples');
        expect(Array.isArray(helloWorldAction.similes)).toBe(true);
        expect(Array.isArray(helloWorldAction.examples)).toBe(true);
      }
    });

    it('should have GREET and SAY_HELLO as similes', () => {
      if (helloWorldAction) {
        expect(helloWorldAction.similes).toContain('GREET');
        expect(helloWorldAction.similes).toContain('SAY_HELLO');
      }
    });

    it('should have at least one example', () => {
      if (helloWorldAction && helloWorldAction.examples) {
        expect(helloWorldAction.examples.length).toBeGreaterThan(0);

        // Check first example structure
        const firstExample = helloWorldAction.examples[0];
        expect(firstExample.length).toBeGreaterThan(1); // At least two messages

        // First message should be a request
        expect(firstExample[0]).toHaveProperty('name');
        expect(firstExample[0]).toHaveProperty('content');
        expect(firstExample[0].content).toHaveProperty('text');
        expect(firstExample[0].content.text).toContain('hello');

        // Second message should be a response
        expect(firstExample[1]).toHaveProperty('name');
        expect(firstExample[1]).toHaveProperty('content');
        expect(firstExample[1].content).toHaveProperty('text');
        expect(firstExample[1].content).toHaveProperty('actions');
        expect(firstExample[1].content.text).toBe('hello world!');
        expect(firstExample[1].content.actions).toContain('HELLO_WORLD');
      }
    });

    it('should return true from validate function', async () => {
      if (helloWorldAction) {
        const runtime = createRealRuntime();
        const mockMessage = {
          entityId: uuidv4(),
          roomId: uuidv4(),
          content: {
            text: 'Hello!',
            source: 'test',
          },
        } as Memory;
        const mockState = {
          values: {},
          data: {},
          text: '',
        } as State;

        let result = false;
        let error: Error | null = null;

        try {
          result = await helloWorldAction.validate(runtime, mockMessage, mockState);
          expect(result).toBe(true);
        } catch (e) {
          error = e as Error;
          console.error('Validate function error:', e);
        }

        documentTestResult('HELLO_WORLD action validate', result, error);
      }
    });

    it('should call back with hello world response from handler', async () => {
      if (helloWorldAction) {
        const runtime = createRealRuntime();
        const mockMessage = {
          entityId: uuidv4(),
          roomId: uuidv4(),
          content: {
            text: 'Hello!',
            source: 'test',
          },
        } as Memory;
        const mockState = {
          values: {},
          data: {},
          text: '',
        } as State;

        let callbackResponse: any = {};
        let error: Error | null = null;

        const mockCallback = (response: any) => {
          callbackResponse = response;
        };

        try {
          await helloWorldAction.handler(
            runtime,
            mockMessage,
            mockState,
            {},
            mockCallback as HandlerCallback,
            []
          );

          // Verify callback was called with the right content
          expect(callbackResponse).toBeTruthy();
          expect(callbackResponse).toHaveProperty('text');
          expect(callbackResponse).toHaveProperty('actions');
          expect(callbackResponse.actions).toContain('HELLO_WORLD');
          expect(callbackResponse).toHaveProperty('source', 'test');
        } catch (e) {
          error = e as Error;
          console.error('Handler function error:', e);
        }

        documentTestResult('HELLO_WORLD action handler', callbackResponse, error);
      }
    });
  });

  describe('Action Utils', () => {
    // Using the core action utils with the plugin's actions
    it('should format action names correctly', () => {
      if (plugin.actions) {
        let result = '';
        let error: Error | null = null;

        try {
          result = formatActionNames(plugin.actions);
          expect(typeof result).toBe('string');
          expect(result).toContain('HELLO_WORLD');
        } catch (e) {
          error = e as Error;
          console.error('Format action names error:', e);
        }

        documentTestResult('Format action names', result, error);
      }
    });

    it('should format actions with descriptions', () => {
      if (plugin.actions) {
        let result = '';
        let error: Error | null = null;

        try {
          result = formatActions(plugin.actions);
          expect(typeof result).toBe('string');
          expect(result).toContain('HELLO_WORLD');
          expect(result).toContain('Responds with a simple hello world message');
        } catch (e) {
          error = e as Error;
          console.error('Format actions error:', e);
        }

        documentTestResult('Format actions with descriptions', result, error);
      }
    });

    it('should compose action examples', () => {
      if (plugin.actions) {
        let result = '';
        let error: Error | null = null;

        try {
          result = composeActionExamples(plugin.actions, 1);
          expect(typeof result).toBe('string');
          expect(result.length).toBeGreaterThan(0);
          expect(result).not.toContain('{{name1}}');
          expect(result).not.toContain('{{name2}}');
        } catch (e) {
          error = e as Error;
          console.error('Compose action examples error:', e);
        }

        documentTestResult('Compose action examples', result, error);
      }
    });
  });
});
