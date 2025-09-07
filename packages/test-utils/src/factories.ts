/**
 * @fileoverview Factory functions for creating complete test scenarios
 *
 * This module provides high-level factory functions that combine multiple
 * mock objects to create realistic testing scenarios.
 */

import { mock } from './mocks/mockUtils';
import type {
  IAgentRuntime,
  Memory,
  State,
  Action,
  Provider,
  Evaluator,
  UUID,
  ActionResult,
  HandlerCallback,
} from '@elizaos/core';

import { createMockRuntime } from './mocks/runtime';
import { createMockMemory, createMockConversation } from './mocks/memory';
import { createMockConversationState } from './mocks/state';
import { createMockCharacter } from './mocks/character';

/**
 * Create a complete test environment with runtime, character, and conversation
 *
 * @param options - Configuration options for the test environment
 * @returns Complete test environment
 *
 * @example
 * ```typescript
 * import { createTestEnvironment } from '@elizaos/core/test-utils';
 *
 * const { runtime, character, conversation } = createTestEnvironment({
 *   characterName: 'TestBot',
 *   conversationLength: 5,
 *   roomId: 'test-room-123'
 * });
 * ```
 */
export function createTestEnvironment(
  options: {
    characterName?: string;
    conversationLength?: number;
    roomId?: UUID;
    plugins?: string[];
    runtimeOverrides?: any;
    characterOverrides?: any;
  } = {}
) {
  const {
    characterName = 'TestAgent',
    conversationLength = 5,
    roomId = 'test-room-id' as UUID,
    plugins = [],
    runtimeOverrides = {},
    characterOverrides = {},
  } = options;

  // Create character
  const character = createMockCharacter({
    name: characterName,
    plugins,
    ...characterOverrides,
  });

  // Create runtime with character
  const runtime = createMockRuntime({
    character,
    ...runtimeOverrides,
  });

  // Create conversation history
  const conversation = createMockConversation(conversationLength, roomId);

  // Create state with conversation context
  const state = createMockConversationState(
    conversation.map((m) => m.content.text || ''),
    'TestUser'
  );

  return {
    runtime,
    character,
    conversation,
    state,
    roomId,
  };
}

/**
 * Create a test action with complete mock setup
 *
 * @param name - Action name
 * @param options - Action configuration options
 * @returns Mock action with handlers
 */
export function createTestAction(
  name: string,
  options: {
    description?: string;
    validateResult?: boolean;
    handlerResult?: ActionResult;
    examples?: any[];
  } = {}
): Action {
  const {
    description = `Test action: ${name}`,
    validateResult = true,
    handlerResult = { text: `${name} executed successfully`, success: true },
    examples = [],
  } = options;

  return {
    name,
    similes: [`${name.toLowerCase()}`, `${name.replace('_', ' ').toLowerCase()}`],
    description,
    examples,

    validate: mock().mockResolvedValue(validateResult),

    handler: mock(
      async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: any,
        callback?: HandlerCallback
      ) => {
        // Simulate action execution
        if (callback) {
          await callback({
            text: handlerResult.text || `${name} action executed`,
            thought: `Executing ${name} action`,
            actions: [name],
          });
        }
        return handlerResult;
      }
    ),
  };
}

/**
 * Create a test provider with complete mock setup
 *
 * @param name - Provider name
 * @param options - Provider configuration options
 * @returns Mock provider
 */
export function createTestProvider(
  name: string,
  options: {
    description?: string;
    text?: string;
    values?: Record<string, any>;
    data?: Record<string, any>;
    dynamic?: boolean;
    isPrivate?: boolean;
  } = {}
): Provider {
  const {
    description = `Test provider: ${name}`,
    text = `[${name}]\nProvider context information\n[/${name}]`,
    values = { [`${name.toLowerCase()}Data`]: 'test-value' },
    data = { source: name, timestamp: Date.now() },
    dynamic = false,
    isPrivate = false,
  } = options;

  return {
    name,
    description,
    dynamic,
    private: isPrivate,

    get: mock().mockResolvedValue({
      text,
      values,
      data,
    }),
  };
}

/**
 * Create a test evaluator with complete mock setup
 *
 * @param name - Evaluator name
 * @param options - Evaluator configuration options
 * @returns Mock evaluator
 */
export function createTestEvaluator(
  name: string,
  options: {
    description?: string;
    alwaysRun?: boolean;
    validateResult?: boolean;
    handlerResult?: any;
  } = {}
): Evaluator {
  const {
    description = `Test evaluator: ${name}`,
    alwaysRun = false,
    validateResult = true,
    handlerResult = { success: true },
  } = options;

  return {
    name,
    description,
    alwaysRun,
    examples: [],

    validate: mock().mockResolvedValue(validateResult),

    handler: mock(async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => {
      return handlerResult;
    }),
  };
}

/**
 * Create a complete plugin test scenario
 *
 * @param pluginName - Name of the plugin being tested
 * @param options - Plugin test configuration
 * @returns Complete plugin test scenario
 */
export function createPluginTestScenario(
  pluginName: string,
  options: {
    actions?: string[];
    providers?: string[];
    evaluators?: string[];
    services?: string[];
    conversationSteps?: string[];
  } = {}
) {
  const {
    actions = ['TEST_ACTION'],
    providers = ['TEST_PROVIDER'],
    evaluators = ['TEST_EVALUATOR'],
    conversationSteps = ['Hello', 'How can I test this plugin?'],
  } = options;

  // Create test environment
  const { runtime, character, state, roomId } = createTestEnvironment({
    characterName: `${pluginName}TestAgent`,
    plugins: [pluginName],
  });

  // Create test components
  const testActions = actions.map((name) => createTestAction(name));
  const testProviders = providers.map((name) => createTestProvider(name));
  const testEvaluators = evaluators.map((name) => createTestEvaluator(name));

  // Create conversation for testing
  const conversation = conversationSteps.map((text, index) =>
    createMockMemory({
      content: { text },
      entityId: index % 2 === 0 ? ('user-id' as UUID) : runtime.agentId,
      roomId,
    })
  );

  return {
    runtime,
    character,
    state,
    roomId,
    conversation,
    components: {
      actions: testActions,
      providers: testProviders,
      evaluators: testEvaluators,
    },
    // Helper methods for common test operations
    helpers: {
      executeAction: async (actionName: string, message?: Memory) => {
        const action = testActions.find((a) => a.name === actionName);
        const testMessage = message || conversation[0];
        return action?.handler(runtime, testMessage, state);
      },
      getProviderData: async (providerName: string, message?: Memory) => {
        const provider = testProviders.find((p) => p.name === providerName);
        const testMessage = message || conversation[0];
        return provider?.get(runtime, testMessage, state);
      },
      runEvaluator: async (evaluatorName: string, message?: Memory) => {
        const evaluator = testEvaluators.find((e) => e.name === evaluatorName);
        const testMessage = message || conversation[0];
        return evaluator?.handler(runtime, testMessage, state);
      },
    },
  };
}

/**
 * Create a multi-agent test scenario
 *
 * @param agentCount - Number of agents to create
 * @param options - Multi-agent test configuration
 * @returns Multi-agent test scenario
 */
export function createMultiAgentScenario(
  agentCount: number = 2,
  options: {
    sharedRoomId?: UUID;
    agentNames?: string[];
    conversationSteps?: Array<{ agentIndex: number; message: string }>;
  } = {}
) {
  const {
    sharedRoomId = 'shared-room-id' as UUID,
    agentNames = Array.from({ length: agentCount }, (_, i) => `Agent${i + 1}`),
    conversationSteps = [
      { agentIndex: 0, message: 'Hello from Agent 1' },
      { agentIndex: 1, message: 'Hello from Agent 2' },
    ],
  } = options;

  // Create multiple agents
  const agents = agentNames.map((name, index) => {
    const { runtime, character } = createTestEnvironment({
      characterName: name,
      roomId: sharedRoomId,
    });
    return { runtime, character, index };
  });

  // Create shared conversation
  const conversation = conversationSteps.map((step) =>
    createMockMemory({
      content: { text: step.message },
      entityId: agents[step.agentIndex].runtime.agentId,
      roomId: sharedRoomId,
    })
  );

  return {
    agents,
    sharedRoomId,
    conversation,
    helpers: {
      sendMessage: (agentIndex: number, text: string) => {
        const message = createMockMemory({
          content: { text },
          entityId: agents[agentIndex].runtime.agentId,
          roomId: sharedRoomId,
        });
        conversation.push(message);
        return message;
      },
      getAgentByName: (name: string) => {
        return agents.find((agent) => agent.character.name === name);
      },
    },
  };
}
