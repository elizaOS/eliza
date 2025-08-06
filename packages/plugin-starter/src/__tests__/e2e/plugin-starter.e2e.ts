import {
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type TestSuite,
} from '@elizaos/core';

/**
 * E2E (End-to-End) Test Suite for ElizaOS Plugins
 * ================================================
 *
 * This file contains end-to-end tests that run within a real ElizaOS runtime environment.
 * Unlike unit tests that test individual components in isolation, e2e tests validate
 * the entire plugin behavior in a production-like environment.
 *
 * NOTE: The tests are properly structured and included in the plugin build.
 * If the test runner is not detecting these tests, it may be looking at the wrong
 * plugin name or there may be a test runner configuration issue. The tests are
 * exported correctly through src/tests.ts and included in the plugin's tests array.
 *
 * HOW E2E TESTS WORK:
 * -------------------
 * 1. Tests are executed by the ElizaOS test runner using `elizaos test e2e`
 * 2. Each test receives a real runtime instance with the plugin loaded
 * 3. Tests can interact with the runtime just like in production
 * 4. Tests throw errors to indicate failure (no assertion library needed)
 *
 * WRITING NEW E2E TESTS:
 * ----------------------
 * 1. Add a new test object to the `tests` array below
 * 2. Each test must have:
 *    - `name`: A unique identifier for the test
 *    - `fn`: An async function that receives the runtime and performs the test
 *
 * Example structure:
 * ```typescript
 * {
 *   name: 'my_new_test',
 *   fn: async (runtime: IAgentRuntime) => {
 *     // Your test logic here
 *     if (someCondition !== expected) {
 *       throw new Error('Test failed: reason');
 *     }
 *   }
 * }
 * ```
 *
 * BEST PRACTICES:
 * ---------------
 * - Test real user scenarios, not implementation details
 * - Use descriptive test names that explain what's being tested
 * - Include clear error messages that help diagnose failures
 * - Test both success and failure paths
 * - Clean up any resources created during tests
 *
 * AVAILABLE RUNTIME METHODS:
 * --------------------------
 * - runtime.getService(type): Get a service instance
 * - runtime.character: Access character configuration
 * - runtime.models: Access AI models
 * - runtime.db: Access database methods
 * - runtime.actions: Access registered actions
 * - runtime.providers: Access registered providers
 *
 * For more details, see the ElizaOS documentation.
 */

// Define minimal interfaces for the types we need
type UUID = `${string}-${string}-${string}-${string}-${string}`;

interface Memory {
  entityId: UUID;
  roomId: UUID;
  content: {
    text: string;
    source: string;
    actions?: string[];
  };
}

interface State {
  values: Record<string, any>;
  data: Record<string, any>;
  text: string;
}

export const StarterPluginTestSuite: TestSuite = {
  name: 'plugin_starter_test_suite',
  tests: [
    /**
     * Basic Plugin Verification Test
     * ------------------------------
     * This test verifies that the plugin is properly loaded and initialized
     * within the runtime environment.
     */
    {
      name: 'example_test',
      fn: async (runtime: IAgentRuntime) => {
        // Test the character name
        if (runtime.character.name !== 'Eliza') {
          throw new Error(
            `Expected character name to be "Eliza" but got "${runtime.character.name}"`
          );
        }
        // Verify the plugin is loaded properly
        const service = runtime.getService('starter');
        if (!service) {
          throw new Error('Starter service not found');
        }
      },
    },

    /**
     * Action Registration Test
     * ------------------------
     * Verifies that custom actions are properly registered with the runtime.
     * This is important to ensure actions are available for the agent to use.
     */
    {
      name: 'should_have_hello_world_action',
      fn: async (runtime: IAgentRuntime) => {
        // Access actions through runtime.actions instead of getPlugin
        const actionExists = runtime.actions?.some((a) => a.name === 'HELLO_WORLD');
        if (!actionExists) {
          throw new Error('Hello world action not found in runtime actions');
        }
      },
    },

    /**
     * Hello World Action Response Test
     * ---------------------------------
     * This test demonstrates a complete scenario where:
     * 1. The agent is asked to say "hello"
     * 2. The HELLO_WORLD action is triggered
     * 3. The agent responds with text containing "hello world"
     *
     * This is a key pattern for testing agent behaviors - you simulate
     * a user message and verify the agent's response.
     */
    {
      name: 'hello_world_action_test',
      fn: async (runtime: IAgentRuntime) => {
        // Create a test message asking the agent to say hello
        const testMessage: Memory = {
          entityId: '12345678-1234-1234-1234-123456789012' as UUID,
          roomId: '12345678-1234-1234-1234-123456789012' as UUID,
          content: {
            text: 'Can you say hello?',
            source: 'test',
            actions: ['HELLO_WORLD'], // Specify which action we expect to trigger
          },
        };

        // Create a test state (can include context if needed)
        const testState: State = {
          values: {},
          data: {},
          text: '',
        };

        let responseText = '';
        let responseReceived = false;

        // Find the hello world action in runtime.actions
        const helloWorldAction = runtime.actions?.find((a) => a.name === 'HELLO_WORLD');
        if (!helloWorldAction) {
          throw new Error('Hello world action not found in runtime actions');
        }

        // Create a callback that captures the agent's response
        // This simulates how the runtime would handle the action's response
        const callback: HandlerCallback = async (response: Content) => {
          responseReceived = true;
          responseText = response.text || '';

          // Verify the response includes the expected action
          if (!response.actions?.includes('HELLO_WORLD')) {
            throw new Error('Response did not include HELLO_WORLD action');
          }

          // Return Promise<Memory[]> as required by the HandlerCallback interface
          return Promise.resolve([]);
        };

        // Execute the action - this simulates the runtime calling the action
        await helloWorldAction.handler(runtime, testMessage, testState, {}, callback);

        // Verify we received a response
        if (!responseReceived) {
          throw new Error('Hello world action did not produce a response');
        }

        // Verify the response contains "hello world" (case-insensitive)
        if (!responseText.toLowerCase().includes('hello world')) {
          throw new Error(`Expected response to contain "hello world" but got: "${responseText}"`);
        }

        // Success! The agent responded with "hello world" as expected
      },
    },

    /**
     * Provider Functionality Test
     * ---------------------------
     * Tests that providers can supply data to the agent when needed.
     * Providers are used to fetch external data or compute values.
     */
    {
      name: 'hello_world_provider_test',
      fn: async (runtime: IAgentRuntime) => {
        // Create a test message
        const testMessage: Memory = {
          entityId: '12345678-1234-1234-1234-123456789012' as UUID,
          roomId: '12345678-1234-1234-1234-123456789012' as UUID,
          content: {
            text: 'What can you provide?',
            source: 'test',
          },
        };

        // Create a test state
        const testState: State = {
          values: {},
          data: {},
          text: '',
        };

        // Find the hello world provider in runtime.providers
        const helloWorldProvider = runtime.providers?.find(
          (p) => p.name === 'HELLO_WORLD_PROVIDER'
        );
        if (!helloWorldProvider) {
          throw new Error('Hello world provider not found in runtime providers');
        }

        // Test the provider
        const result = await helloWorldProvider.get(runtime, testMessage, testState);

        if (result.text !== 'I am a provider') {
          throw new Error(`Expected provider to return "I am a provider", got "${result.text}"`);
        }
      },
    },

    /**
     * Service Lifecycle Test
     * ----------------------
     * Verifies that services can be started, accessed, and stopped properly.
     * Services run background tasks or manage long-lived resources.
     */
    {
      name: 'starter_service_test',
      fn: async (runtime: IAgentRuntime) => {
        // Get the service from the runtime
        const service = runtime.getService('starter');
        if (!service) {
          throw new Error('Starter service not found');
        }

        // Check service capability description
        if (
          service.capabilityDescription !==
          'This is a starter service which is attached to the agent through the starter plugin.'
        ) {
          throw new Error('Incorrect service capability description');
        }

        // Test service stop method
        await service.stop();
      },
    },

    /**
     * ADD YOUR CUSTOM TESTS HERE
     * --------------------------
     * To add a new test:
     *
     * 1. Copy this template:
     * ```typescript
     * {
     *   name: 'your_test_name',
     *   fn: async (runtime: IAgentRuntime) => {
     *     // Setup: Create any test data needed
     *
     *     // Action: Perform the operation you want to test
     *
     *     // Assert: Check the results
     *     if (result !== expected) {
     *       throw new Error(`Expected ${expected} but got ${result}`);
     *     }
     *   }
     * }
     * ```
     *
     * 2. Common test patterns:
     *    - Test action responses to specific prompts
     *    - Verify provider data under different conditions
     *    - Check service behavior during lifecycle events
     *    - Validate plugin configuration handling
     *    - Test error cases and edge conditions
     *
     * 3. Tips:
     *    - Use meaningful variable names
     *    - Include helpful error messages
     *    - Test one thing per test
     *    - Consider both success and failure scenarios
     */
  ],
};

// Export a default instance of the test suite for the E2E test runner
export default StarterPluginTestSuite;
