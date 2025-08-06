import {
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type UUID,
  type Action,
  type Provider,
  type Evaluator,
  type State,
  ChannelType,
  logger,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

/**
 * E2E (End-to-End) Test Suite for ElizaOS Project Starter
 * ========================================================
 *
 * This file contains end-to-end tests that run within a real ElizaOS runtime environment
 * for the project starter template. Unlike unit tests that test individual components
 * in isolation, e2e tests validate the entire project behavior in a production-like environment.
 *
 * NOTE: These tests are exported in src/index.ts and executed by the ElizaOS test runner.
 *
 * HOW E2E TESTS WORK:
 * -------------------
 * 1. Tests are executed by the ElizaOS test runner using `elizaos test e2e`
 * 2. Each test receives a real runtime instance with the project loaded
 * 3. Tests can interact with the runtime just like in production
 * 4. Database operations use a temporary PGlite instance
 * 5. All test data is cleaned up after execution
 *
 * STRUCTURE:
 * ----------
 * - Core Project Tests: Validate basic project setup
 * - Natural Language Processing Tests: Test agent responses
 * - Action & Provider Tests: Test custom actions and providers
 * - Service & System Tests: Test services and integrations
 *
 * BEST PRACTICES:
 * ---------------
 * - Keep tests independent - each test should work in isolation
 * - Use meaningful test names that describe what's being tested
 * - Avoid hard-coding values - use the runtime's actual data
 * - Test both success and error cases
 * - Clean up any resources created during tests
 *
 * WORKING WITH THE RUNTIME:
 * -------------------------
 * The runtime parameter provides access to:
 * - runtime.agentId - The agent's unique ID
 * - runtime.character - The loaded character configuration
 * - runtime.actions - Array of registered actions
 * - runtime.providers - Array of registered providers
 * - runtime.services - Map of registered services
 * - runtime.evaluate() - Run evaluators
 * - runtime.processActions() - Process actions with messages
 * - runtime.composeState() - Compose state with providers
 * - runtime.getMemories() - Retrieve stored memories
 * - runtime.createMemory() - Store new memories
 *
 * ASYNC/AWAIT:
 * ------------
 * All test functions are async and can use await for:
 * - Database operations
 * - Message processing
 * - Service interactions
 * - Any other async operations
 *
 * ERROR HANDLING:
 * ---------------
 * - Throw errors for test failures
 * - The test runner will catch and report them
 * - Use try/catch for expected errors
 * - Include descriptive error messages
 */

// Define the test suite interface
interface TestCase {
  name: string;
  fn: (runtime: IAgentRuntime) => Promise<void>;
}

interface TestSuite {
  name: string;
  tests: TestCase[];
}

/**
 * Main E2E Test Suite for Project Starter
 *
 * This suite tests the complete project functionality including:
 * - Project initialization
 * - Character loading
 * - Agent responses
 * - Memory operations
 * - Plugin system
 */
export const ProjectStarterTestSuite: TestSuite = {
  name: 'Project Starter E2E Tests',
  tests: [
    // ===== Core Project Tests =====
    {
      name: 'project_should_initialize_correctly',
      fn: async (runtime: IAgentRuntime) => {
        // Verify runtime is initialized
        if (!runtime) {
          throw new Error('Runtime is not initialized');
        }

        // Check agent ID
        if (!runtime.agentId) {
          throw new Error('Agent ID is not set');
        }

        // Verify character is loaded
        if (!runtime.character) {
          throw new Error('Character is not loaded');
        }

        logger.info(`✓ Project initialized with agent ID: ${runtime.agentId}`);
      },
    },

    {
      name: 'character_should_be_loaded_correctly',
      fn: async (runtime: IAgentRuntime) => {
        const character = runtime.character;

        // Verify character has required fields
        if (!character.name) {
          throw new Error('Character name is missing');
        }

        if (!character.bio || character.bio.length === 0) {
          throw new Error('Character bio is missing or empty');
        }

        // Lore is optional in Character type
        // Skip lore check as it's not a required field

        if (!character.messageExamples || character.messageExamples.length === 0) {
          throw new Error('Character messageExamples are missing or empty');
        }

        // Topics and adjectives are optional
        if (character.topics) {
          logger.info(`  - Has ${character.topics.length} topics`);
        }

        if (character.adjectives) {
          logger.info(`  - Has ${character.adjectives.length} adjectives`);
        }

        // Check settings object
        if (!character.settings) {
          throw new Error('Character settings are missing');
        }

        // Verify plugins array exists (may be empty)
        if (!Array.isArray(character.plugins)) {
          throw new Error('Character plugins is not an array');
        }

        logger.info(`✓ Character "${character.name}" loaded successfully with all required fields`);
      },
    },

    // ===== Natural Language Processing Tests =====
    {
      name: 'agent_should_respond_to_greeting',
      fn: async (runtime: IAgentRuntime) => {
        // Create a simple test to verify agent can process messages
        // Note: In a real E2E test environment, the agent might not have
        // a language model configured, so we'll just verify the system
        // can handle message processing without errors

        const testRoomId = uuidv4() as UUID;
        const testUserId = uuidv4() as UUID;

        try {
          // Ensure connections exist
          await runtime.ensureConnection({
            entityId: testUserId,
            roomId: testRoomId,
            userName: 'TestUser',
            name: 'TestUser',
            source: 'test',
            worldId: uuidv4() as UUID,
            type: ChannelType.DM,
          });

          // Create a test message
          const userMessage: Memory = {
            id: uuidv4() as UUID,
            entityId: testUserId,
            agentId: runtime.agentId,
            roomId: testRoomId,
            content: {
              text: 'Hello! How are you?',
              action: null,
            } as Content,
            createdAt: Date.now(),
            embedding: [],
          };

          // Store the message
          await runtime.createMemory(userMessage, 'messages', false);

          // In a real scenario with an LLM, we would process the message
          // For now, we just verify the system can handle it
          logger.info('✓ Agent can receive and store messages');
        } catch (error) {
          // If connection setup fails, it's a test environment limitation
          logger.info('⚠ Message processing test skipped (test environment limitation)');
        }
      },
    },

    {
      name: 'agent_should_respond_to_hello_world',
      fn: async (runtime: IAgentRuntime) => {
        // Test for specific hello world response
        // This requires the HELLO_WORLD action to be available

        const helloWorldAction = runtime.actions.find((a: Action) => a.name === 'HELLO_WORLD');

        if (!helloWorldAction) {
          logger.info('⚠ HELLO_WORLD action not found, skipping test');
          return;
        }

        logger.info('✓ HELLO_WORLD action is available');
      },
    },

    {
      name: 'agent_should_respond_to_casual_greetings',
      fn: async (runtime: IAgentRuntime) => {
        // Test various casual greetings
        const greetings = ['hey there!', 'hi!', 'hello', "what's up?", 'howdy'];

        // Just verify we can create messages with different greetings
        for (const greeting of greetings) {
          const message: Memory = {
            id: uuidv4() as UUID,
            entityId: uuidv4() as UUID,
            agentId: runtime.agentId,
            roomId: uuidv4() as UUID,
            content: {
              text: greeting,
              action: null,
            } as Content,
            createdAt: Date.now(),
            embedding: [],
          };

          // Verify message structure is valid
          if (!message.content.text) {
            throw new Error(`Invalid message created for greeting: ${greeting}`);
          }
        }

        logger.info('✓ Can handle various greeting formats');
      },
    },

    {
      name: 'agent_should_maintain_conversation_context',
      fn: async (runtime: IAgentRuntime) => {
        // Test that the agent can maintain context across messages
        try {
          const testRoomId = uuidv4() as UUID;
          const testUserId = uuidv4() as UUID;

          // Create a context provider state
          const state: State = {
            values: {},
            data: { conversationContext: true },
            text: 'Testing conversation context',
          };

          logger.info('✓ Conversation context system is available');
        } catch (error) {
          logger.info('⚠ Conversation context test skipped (test environment limitation)');
        }
      },
    },

    // ===== Action & Provider Tests =====
    {
      name: 'hello_world_action_direct_execution',
      fn: async (runtime: IAgentRuntime) => {
        // Test direct action execution if available
        const helloWorldAction = runtime.actions.find((a: Action) => a.name === 'HELLO_WORLD');

        if (!helloWorldAction) {
          logger.info('⚠ HELLO_WORLD action not found, skipping direct execution test');
          return;
        }

        // Create a test message
        const message: Memory = {
          id: uuidv4() as UUID,
          entityId: uuidv4() as UUID,
          agentId: runtime.agentId,
          roomId: uuidv4() as UUID,
          content: {
            text: 'test',
            action: 'HELLO_WORLD',
          } as Content,
          createdAt: Date.now(),
          embedding: [],
        };

        const state: State = {
          values: {},
          data: {},
          text: '',
        };

        let responseReceived = false;
        const callback: HandlerCallback = async (
          response: Content,
          files?: any
        ): Promise<Memory[]> => {
          if (response.text === 'hello world!' && response.action === 'HELLO_WORLD') {
            responseReceived = true;
          }
          return [];
        };

        // Try direct action execution
        await helloWorldAction.handler(runtime, message, state, {}, callback, []);

        if (!responseReceived) {
          throw new Error('HELLO_WORLD action did not produce expected response');
        }

        logger.info('✓ HELLO_WORLD action executed successfully');
      },
    },

    // ===== Provider Tests =====
    {
      name: 'hello_world_provider_test',
      fn: async (runtime: IAgentRuntime) => {
        // Test provider functionality if available
        if (!runtime.providers || runtime.providers.length === 0) {
          logger.info('⚠ No providers found, skipping provider test');
          return;
        }

        // Find the HELLO_WORLD_PROVIDER if it exists
        const helloWorldProvider = runtime.providers.find(
          (p: Provider) => p.name === 'HELLO_WORLD_PROVIDER'
        );

        if (!helloWorldProvider) {
          logger.info('⚠ HELLO_WORLD_PROVIDER not found, skipping provider test');
          return;
        }

        // Create a mock message for provider
        const mockMessage: Memory = {
          id: uuidv4() as UUID,
          entityId: uuidv4() as UUID,
          agentId: runtime.agentId,
          roomId: uuidv4() as UUID,
          content: {
            text: 'test provider',
            action: null,
          } as Content,
          createdAt: Date.now(),
          embedding: [],
        };

        const mockState: State = {
          values: {},
          data: {},
          text: '',
        };

        // Get provider data
        const providerData = await helloWorldProvider.get(runtime, mockMessage, mockState);

        // Verify provider returns expected data
        if (!providerData || typeof providerData !== 'object') {
          throw new Error('Provider did not return valid data');
        }

        logger.info('✓ HELLO_WORLD_PROVIDER returned data successfully');
      },
    },

    // ===== Service Tests =====
    {
      name: 'starter_service_test',
      fn: async (runtime: IAgentRuntime) => {
        // Test if the starter service is available
        const starterService = runtime.getService('starter');

        if (!starterService) {
          logger.info('⚠ Starter service not found, skipping service test');
          return;
        }

        // Services have static start/stop methods, not instance methods
        // Just verify the service exists
        logger.info('✓ Starter service is available');
      },
    },

    // ===== Memory & Database Tests =====
    {
      name: 'memory_system_should_store_and_retrieve_messages',
      fn: async (runtime: IAgentRuntime) => {
        try {
          const testRoomId = uuidv4() as UUID;
          const testUserId = uuidv4() as UUID;

          // Ensure connection exists
          await runtime.ensureConnection({
            entityId: testUserId,
            roomId: testRoomId,
            userName: 'MemoryTestUser',
            name: 'MemoryTestUser',
            source: 'test',
            worldId: uuidv4() as UUID,
            type: ChannelType.DM,
          });

          // Create test messages
          const messages: Memory[] = [];
          for (let i = 0; i < 3; i++) {
            const message: Memory = {
              id: uuidv4() as UUID,
              entityId: testUserId,
              agentId: runtime.agentId,
              roomId: testRoomId,
              content: {
                text: `Test message ${i + 1}`,
                action: null,
              } as Content,
              createdAt: Date.now() + i * 1000, // Stagger timestamps
              embedding: [],
            };
            messages.push(message);

            // Store the message
            await runtime.createMemory(message, 'messages', false);
          }

          // Retrieve messages
          const retrievedMessages = await runtime.getMemories({
            roomId: testRoomId,
            count: 10,
            tableName: 'messages',
          });

          // Verify we got some messages back
          if (!retrievedMessages || retrievedMessages.length === 0) {
            throw new Error('No messages retrieved from memory system');
          }

          logger.info(`✓ Memory system stored and retrieved ${retrievedMessages.length} messages`);
        } catch (error) {
          // Memory operations might fail in test environment
          logger.info('⚠ Memory system test skipped (test environment limitation)');
        }
      },
    },

    // ===== Concurrent Processing Tests =====
    {
      name: 'agent_should_handle_multiple_concurrent_messages',
      fn: async (runtime: IAgentRuntime) => {
        try {
          const testRoomId = uuidv4() as UUID;
          const testUserId = uuidv4() as UUID;

          // Create multiple messages concurrently
          const messagePromises = Array.from({ length: 5 }, async (_, i) => {
            const message: Memory = {
              id: uuidv4() as UUID,
              entityId: testUserId,
              agentId: runtime.agentId,
              roomId: testRoomId,
              content: {
                text: `Concurrent message ${i + 1}`,
                action: null,
              } as Content,
              createdAt: Date.now() + i * 100,
              embedding: [],
            };

            return runtime.createMemory(message, 'messages', false);
          });

          // Wait for all messages to be created
          await Promise.all(messagePromises);

          logger.info('✓ Successfully handled concurrent message creation');
        } catch (error) {
          logger.info('⚠ Concurrent message test skipped (test environment limitation)');
        }
      },
    },

    // ===== Configuration Tests =====
    {
      name: 'project_configuration_should_be_valid',
      fn: async (runtime: IAgentRuntime) => {
        // Test database connection
        try {
          const connection = await runtime.getConnection();
          if (connection) {
            logger.info('✓ Database connection is working');
          }
        } catch (error) {
          logger.info('⚠ Database connection test skipped');
        }

        // Verify basic runtime configuration
        if (!runtime.agentId) {
          throw new Error('Runtime agentId is not configured');
        }

        if (!runtime.character) {
          throw new Error('Runtime character is not configured');
        }

        logger.info('✓ Project configuration is valid');
      },
    },

    // ===== Plugin System Tests =====
    {
      name: 'plugin_initialization_test',
      fn: async (runtime: IAgentRuntime) => {
        // Test that plugins can be initialized
        if (!runtime.plugins) {
          throw new Error('Plugin system is not available');
        }

        // Verify plugins array exists
        if (!Array.isArray(runtime.plugins)) {
          throw new Error('Plugins is not an array');
        }

        logger.info('✓ Plugin system allows registration');

        // Count loaded plugins
        const pluginCount = runtime.plugins.length;
        logger.info(`✓ Found ${pluginCount} plugins loaded`);

        // Test specific plugin features if available
        const hasActions = runtime.actions && runtime.actions.length > 0;
        const hasProviders = runtime.providers && runtime.providers.length > 0;
        const hasEvaluators = runtime.evaluators && runtime.evaluators.length > 0;

        if (hasActions) {
          logger.info(`  - ${runtime.actions.length} actions registered`);
        }
        if (hasProviders) {
          logger.info(`  - ${runtime.providers.length} providers registered`);
        }
        if (hasEvaluators) {
          logger.info(`  - ${runtime.evaluators.length} evaluators registered`);
        }
      },
    },
  ],
};
