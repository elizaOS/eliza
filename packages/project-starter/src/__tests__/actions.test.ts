import { describe, expect, it, spyOn, beforeAll, afterAll } from 'bun:test';
import plugin from '../plugin';
import { logger } from '@elizaos/core';
import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import {
  runCoreActionTests,
  documentTestResult,
  createMockRuntime,
  createMockMessage,
  createMockState,
} from './utils/core-test-utils';

// Setup environment variables
dotenv.config();

// Spy on logger to capture logs for documentation
beforeAll(() => {
  spyOn(logger, 'info');
  spyOn(logger, 'error');
  spyOn(logger, 'warn');
});

afterAll(() => {
  // No global restore needed in bun:test;
});

describe('Actions', () => {
  // Find the HELLO_WORLD action from the plugin
  const helloWorldAction = plugin.actions?.find((action) => action.name === 'HELLO_WORLD');

  // Run core tests on all plugin actions
  it('should pass core action tests', () => {
    if (plugin.actions) {
      const coreTestResults = runCoreActionTests(plugin.actions);
      expect(coreTestResults).toBeDefined();
      expect(coreTestResults.formattedNames).toBeDefined();
      expect(coreTestResults.formattedActions).toBeDefined();
      expect(coreTestResults.composedExamples).toBeDefined();

      // Document the core test results
      documentTestResult('Core Action Tests', coreTestResults);
    }
  });

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
        const runtime = createMockRuntime();
        const mockMessage = createMockMessage('Hello!');
        const mockState = createMockState();

        let result = false;
        let error: Error | null = null;

        try {
          result = await helloWorldAction.validate(runtime, mockMessage, mockState);
          expect(result).toBe(true);
        } catch (e) {
          error = e as Error;
          logger.error({ error: e }, 'Validate function error:');
        }

        documentTestResult('HELLO_WORLD action validate', result, error);
      }
    });

    it('should call back with hello world response from handler', async () => {
      if (helloWorldAction) {
        const runtime = createMockRuntime();
        const mockMessage = createMockMessage('Hello!');
        const mockState = createMockState();

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
          logger.error({ error: e }, 'Handler function error:');
        }

        documentTestResult('HELLO_WORLD action handler', callbackResponse, error);
      }
    });
  });
});
