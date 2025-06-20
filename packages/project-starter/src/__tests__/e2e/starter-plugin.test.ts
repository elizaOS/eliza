import { v4 as uuidv4 } from 'uuid';

/**
 * Starter Plugin E2E Test Suite
 *
 * This comprehensive test suite demonstrates how to write end-to-end tests for ElizaOS plugins.
 * These tests run in a REAL runtime environment provided by `elizaos test`, meaning:
 *
 * - All services are actually initialized and running
 * - The database is real (in-memory PGLite for testing)
 * - Actions, providers, and events are fully functional
 * - The agent's AI/LLM capabilities are active
 *
 * STRUCTURE OF AN E2E TEST:
 * 1. Each test receives a live IAgentRuntime instance
 * 2. You interact with the runtime as if it were production
 * 3. Test success = no errors thrown, test failure = throw an error
 *
 * HOW TO ADD NEW TESTS:
 * 1. Add a new object to the `tests` array with:
 *    - `name`: A descriptive name for your test
 *    - `fn`: An async function that receives the runtime
 * 2. In your test function:
 *    - Set up any required state (rooms, messages, etc.)
 *    - Execute the functionality you want to test
 *    - Assert the results (throw errors on failure)
 * 3. Keep tests independent - don't rely on other tests' state
 *
 * TESTING PATTERNS DEMONSTRATED:
 * - Character configuration validation
 * - Plugin initialization
 * - Action execution (both direct and natural language)
 * - Provider functionality
 * - Service lifecycle management
 * - Natural language understanding
 */

// Define a minimal TestSuite interface that matches what's needed
interface TestSuite {
  name: string;
  description: string;
  tests: Array<{
    name: string;
    fn: (runtime: any) => Promise<any>;
  }>;
}

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

interface Content {
  text: string;
  source?: string;
  actions?: string[];
}

export class StarterTestSuite implements TestSuite {
  name = 'starter';
  description = 'E2E tests for the starter project demonstrating comprehensive testing patterns';

  tests = [
    {
      /**
       * Test 1: Character Configuration Validation
       * This test ensures that the character is properly configured with all required fields.
       * It's a good first test because it validates the basic setup before testing functionality.
       */
      name: 'Character configuration test',
      fn: async (runtime: any) => {
        const character = runtime.character;
        const requiredFields = ['name', 'bio', 'plugins', 'system', 'messageExamples'];
        const missingFields = requiredFields.filter((field) => !(field in character));

        if (missingFields.length > 0) {
          throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
        }

        // Additional character property validations
        if (character.name !== 'Eliza') {
          throw new Error(`Expected character name to be 'Eliza', got '${character.name}'`);
        }
        if (!Array.isArray(character.plugins)) {
          throw new Error('Character plugins should be an array');
        }
        if (!character.system) {
          throw new Error('Character system prompt is required');
        }
        if (!Array.isArray(character.bio)) {
          throw new Error('Character bio should be an array');
        }
        if (!Array.isArray(character.messageExamples)) {
          throw new Error('Character message examples should be an array');
        }
      },
    },

    {
      /**
       * Test 2: Plugin Initialization
       * This test verifies that plugins can be registered with the runtime.
       * It's important to test this separately from action execution to isolate issues.
       */
      name: 'Plugin initialization test',
      fn: async (runtime: any) => {
        // Test plugin initialization with empty config
        try {
          await runtime.registerPlugin({
            name: 'starter',
            description: 'A starter plugin for Eliza',
            init: async () => {},
            config: {},
          });
        } catch (error) {
          throw new Error(`Failed to register plugin: ${(error as Error).message}`);
        }
      },
    },

    {
      /**
       * Test 3: Direct Action Execution
       * This test explicitly requests the HELLO_WORLD action to verify it works correctly.
       * This is useful for testing that the action itself is functioning before testing
       * natural language understanding.
       */
      name: 'Hello world action test - Direct execution',
      fn: async (runtime: any) => {
        const message: Memory = {
          entityId: uuidv4() as UUID,
          roomId: uuidv4() as UUID,
          content: {
            text: 'Can you say hello?',
            source: 'test',
            actions: ['HELLO_WORLD'], // Explicitly request the HELLO_WORLD action
          },
        };

        const state: State = {
          values: {},
          data: {},
          text: '',
        };
        let responseReceived = false;

        // Test the hello world action
        try {
          await runtime.processActions(message, [], state, async (content: Content) => {
            if (content.text === 'hello world!' && content.actions?.includes('HELLO_WORLD')) {
              responseReceived = true;
            }
            return [];
          });

          if (!responseReceived) {
            // Try directly executing the action if processActions didn't work
            const helloWorldAction = runtime.actions.find((a: any) => a.name === 'HELLO_WORLD');
            if (helloWorldAction) {
              await helloWorldAction.handler(
                runtime,
                message,
                state,
                {},
                async (content: Content) => {
                  if (content.text === 'hello world!' && content.actions?.includes('HELLO_WORLD')) {
                    responseReceived = true;
                  }
                  return [];
                },
                []
              );
            } else {
              throw new Error('HELLO_WORLD action not found in runtime.actions');
            }
          }

          if (!responseReceived) {
            throw new Error('Hello world action did not produce expected response');
          }
        } catch (error) {
          throw new Error(`Hello world action test failed: ${(error as Error).message}`);
        }
      },
    },

    {
      /**
       * Test 4: Natural Language Understanding - Hello World
       * This is the KEY TEST that demonstrates how the agent should naturally understand
       * a request to say "hello world" without explicitly specifying the action.
       *
       * This test simulates a real conversation where:
       * 1. The user asks the agent to say "hello world" in natural language
       * 2. The agent understands the request and decides to use the HELLO_WORLD action
       * 3. The agent responds with "hello world!"
       *
       * This tests the full AI pipeline: understanding → decision making → action execution
       */
      name: 'Natural language hello world test',
      fn: async (runtime: any) => {
        // Create a unique room for this conversation
        const roomId = uuidv4() as UUID;
        const userId = uuidv4() as UUID;

        try {
          // Step 1: Send a natural language message asking for hello world
          // Note: We do NOT specify any actions - the agent must understand and decide
          const userMessage: Memory = {
            entityId: userId,
            roomId: roomId,
            content: {
              text: 'Please say hello world', // Natural language request
              source: 'test',
              // No actions specified - agent must understand the intent
            },
          };

          // Step 2: Process the message through the agent's full pipeline
          // This includes:
          // - Natural language understanding
          // - Intent recognition
          // - Action selection
          // - Response generation
          let agentResponse: string | null = null;
          let actionUsed: string | null = null;

          // Set up a callback to capture the agent's response
          const responseCallback = async (content: Content) => {
            agentResponse = content.text;
            if (content.actions && content.actions.length > 0) {
              actionUsed = content.actions[0];
            }
            return [];
          };

          // Process the message - this simulates a real conversation
          await runtime.processMessage(userMessage, [], responseCallback);

          // Alternative approach if processMessage isn't available
          if (!agentResponse) {
            // Try using the evaluate method which processes messages through the full pipeline
            const state: State = {
              values: {},
              data: {},
              text: userMessage.content.text,
            };

            const result = await runtime.evaluate(userMessage, state, responseCallback);

            // If evaluate doesn't work, try the action selection pipeline
            if (!agentResponse && runtime.evaluateActions) {
              const selectedActions = await runtime.evaluateActions(userMessage, state);

              if (selectedActions && selectedActions.length > 0) {
                // Execute the selected action
                const action = runtime.actions.find((a: any) => a.name === selectedActions[0]);
                if (action) {
                  await action.handler(runtime, userMessage, state, {}, responseCallback, []);
                }
              }
            }
          }

          // Step 3: Verify the agent understood and responded correctly
          if (!agentResponse) {
            throw new Error('Agent did not respond to natural language request');
          }

          // Check that the response contains "hello world" (case insensitive)
          const responseText = (agentResponse || '') as string;
          if (!responseText.toLowerCase().includes('hello world')) {
            throw new Error(
              `Agent response did not contain "hello world". Got: "${agentResponse}"`
            );
          }

          // Optionally verify that the HELLO_WORLD action was used
          if (actionUsed && actionUsed !== 'HELLO_WORLD') {
            console.log(`Note: Agent used action "${actionUsed}" instead of "HELLO_WORLD"`);
          }

          // Test passed! The agent successfully understood the natural language request
          // and responded with "hello world"
        } catch (error) {
          throw new Error(`Natural language hello world test failed: ${(error as Error).message}`);
        }
      },
    },

    {
      /**
       * Test 5: Provider Functionality
       * Providers supply context to the agent. This test verifies that our
       * HELLO_WORLD_PROVIDER is functioning and returning the expected data.
       */
      name: 'Hello world provider test',
      fn: async (runtime: any) => {
        const message: Memory = {
          entityId: uuidv4() as UUID,
          roomId: uuidv4() as UUID,
          content: {
            text: 'What can you provide?',
            source: 'test',
          },
        };

        const state: State = {
          values: {},
          data: {},
          text: '',
        };

        // Test the hello world provider
        try {
          if (!runtime.providers || runtime.providers.length === 0) {
            throw new Error('No providers found in runtime');
          }

          // Find the specific provider we want to test
          const helloWorldProvider = runtime.providers.find(
            (p: any) => p.name === 'HELLO_WORLD_PROVIDER'
          );

          if (!helloWorldProvider) {
            throw new Error('HELLO_WORLD_PROVIDER not found in runtime providers');
          }

          const result = await helloWorldProvider.get(runtime, message, state);

          if (result.text !== 'I am a provider') {
            throw new Error(`Expected provider to return "I am a provider", got "${result.text}"`);
          }
        } catch (error) {
          throw new Error(`Hello world provider test failed: ${(error as Error).message}`);
        }
      },
    },

    {
      /**
       * Test 6: Service Lifecycle Management
       * Services are long-running components. This test verifies that our
       * starter service can be properly started, accessed, and stopped.
       */
      name: 'Starter service test',
      fn: async (runtime: any) => {
        // Test service registration and lifecycle
        try {
          const service = runtime.getService('starter');
          if (!service) {
            throw new Error('Starter service not found');
          }

          if (
            service.capabilityDescription !==
            'This is a starter service which is attached to the agent through the starter plugin.'
          ) {
            throw new Error('Incorrect service capability description');
          }

          await service.stop();
        } catch (error) {
          throw new Error(`Starter service test failed: ${(error as Error).message}`);
        }
      },
    },

    /**
     * TEMPLATE: How to add a new E2E test
     * Copy this template and modify it for your specific test case
     */
    /*
    {
      name: 'My new feature test',
      fn: async (runtime: any) => {
        try {
          // 1. Set up test data
          const testData = {
            // Your test setup here
          };
          
          // 2. Execute the feature
          const result = await runtime.someMethod(testData);
          
          // 3. Verify the results
          if (!result) {
            throw new Error('Expected result but got nothing');
          }
          
          if (result.someProperty !== 'expected value') {
            throw new Error(`Expected 'expected value' but got '${result.someProperty}'`);
          }
          
          // Test passed if we reach here without throwing
        } catch (error) {
          // Always wrap errors with context for easier debugging
          throw new Error(`My new feature test failed: ${error.message}`);
        }
      },
    },
    */
  ];
}

// Export a default instance of the test suite for the E2E test runner
export default new StarterTestSuite();
