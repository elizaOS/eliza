import { vi } from 'vitest';
import { composeActionExamples, formatActionNames, formatActions } from '@elizaos/core';
import type { Action, Content, IAgentRuntime, Memory, State } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

/**
 * Utility functions for reusing core package tests in project-starter tests
 */

/**
 * Runs core package action tests against the provided actions
 * @param actions The actions to test
 */
export const runCoreActionTests = (actions: Action[]) => {
  // Validate action structure (similar to core tests)
  for (const action of actions) {
    if (!action.name) {
      throw new Error('Action missing name property');
    }
    if (!action.description) {
      throw new Error(`Action ${action.name} missing description property`);
    }
    if (!action.examples || !Array.isArray(action.examples)) {
      throw new Error(`Action ${action.name} missing examples array`);
    }
    if (!action.similes || !Array.isArray(action.similes)) {
      throw new Error(`Action ${action.name} missing similes array`);
    }
    if (typeof action.handler !== 'function') {
      throw new Error(`Action ${action.name} missing handler function`);
    }
    if (typeof action.validate !== 'function') {
      throw new Error(`Action ${action.name} missing validate function`);
    }
  }

  // Validate example structure
  for (const action of actions) {
    for (const example of action.examples ?? []) {
      for (const message of example) {
        if (!message.name) {
          throw new Error(`Example message in action ${action.name} missing name property`);
        }
        if (!message.content) {
          throw new Error(`Example message in action ${action.name} missing content property`);
        }
        if (!message.content.text) {
          throw new Error(`Example message in action ${action.name} missing content.text property`);
        }
      }
    }
  }

  // Validate uniqueness of action names
  const names = actions.map((action) => action.name);
  const uniqueNames = new Set(names);
  if (names.length !== uniqueNames.size) {
    throw new Error('Duplicate action names found');
  }

  // Test action formatting
  const formattedNames = formatActionNames(actions);
  if (!formattedNames && actions.length > 0) {
    throw new Error('formatActionNames failed to produce output');
  }

  const formattedActions = formatActions(actions);
  if (!formattedActions && actions.length > 0) {
    throw new Error('formatActions failed to produce output');
  }

  const composedExamples = composeActionExamples(actions, 1);
  if (!composedExamples && actions.length > 0) {
    throw new Error('composeActionExamples failed to produce output');
  }

  return {
    formattedNames,
    formattedActions,
    composedExamples,
  };
};

/**
 * Creates a mock runtime for testing
 */
export const createMockRuntime = (): IAgentRuntime => {
  return {
    character: {
      name: 'Test Character',
      system: 'You are a helpful assistant for testing.',
    },
    getSetting: (key: string) => null,
    // Include real model functionality
    models: {},
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
    actions: [],
    providers: [],
    getService: vi.fn(),
    processActions: vi.fn(),
  } as any as IAgentRuntime;
};

/**
 * Documents test results for logging and debugging
 */
export const documentTestResult = (testName: string, result: any, error: Error | null = null) => {
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
};

/**
 * Creates a mock message for testing
 */
export const createMockMessage = (text: string): Memory => {
  return {
    entityId: uuidv4(),
    roomId: uuidv4(),
    content: {
      text,
      source: 'test',
    },
  } as Memory;
};

/**
 * Creates a mock state for testing
 */
export const createMockState = (): State => {
  return {
    values: {},
    data: {},
    text: '',
  };
};
