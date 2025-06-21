import { type TestSuite } from '@elizaos/core';

/**
 * Project E2E Test Suite
 *
 * This file demonstrates how to write end-to-end (E2E) tests for ElizaOS projects.
 * E2E tests are run using the `elizaos test` command, which provides a REAL runtime
 * environment with actual database, services, and plugin initialization.
 *
 * Key differences from unit tests:
 * - E2E tests receive a fully initialized IAgentRuntime instance
 * - The runtime has a real database (in-memory PGLite for testing)
 * - All plugins and services are actually initialized and running
 * - You can test real agent interactions and behaviors
 *
 * HOW TO ADD NEW E2E TESTS:
 * 1. Add a new test object to the `tests` array below
 * 2. Each test should have a descriptive `name` and async `fn` function
 * 3. The test function receives a real runtime instance as its parameter
 * 4. Use the runtime to simulate real agent interactions
 * 5. Throw an error if the test fails (assertions that fail should throw)
 *
 * IMPORTANT: These tests run in a real environment, so:
 * - Don't use mocks or stubs - everything is real
 * - Tests may be slower than unit tests due to real operations
 * - Each test should be independent and not rely on previous test state
 */
export class ProjectTestSuite implements TestSuite {
  name = 'project';
  description = 'E2E tests for project-specific features';

  tests = [
    {
      name: 'Project runtime environment test',
      fn: async (runtime: any) => {
        /**
         * This test verifies that the project's runtime environment is set up correctly.
         * It's a basic smoke test to ensure the character and core systems are loaded.
         */
        try {
          // Verify character is loaded
          if (!runtime.character) {
            throw new Error('Character not loaded in runtime');
          }

          // Verify expected character properties
          const character = runtime.character;
          if (!character.name) {
            throw new Error('Character name is missing');
          }

          // Verify the character has the expected name
          if (character.name !== 'Eliza') {
            throw new Error(`Expected character name 'Eliza', got '${character.name}'`);
          }

          // Verify character has required configuration
          if (!character.system) {
            throw new Error('Character system prompt is missing');
          }

          if (!Array.isArray(character.bio)) {
            throw new Error('Character bio should be an array');
          }

          if (!Array.isArray(character.messageExamples)) {
            throw new Error('Character message examples should be an array');
          }

          // Verify plugins are loaded (if specified in character)
          if (character.plugins && !Array.isArray(character.plugins)) {
            throw new Error('Character plugins should be an array');
          }

          // Test passed - no need to return anything
          // The test framework considers it successful if no error is thrown
        } catch (error) {
          // Re-throw with more context for debugging
          throw new Error(`Project runtime environment test failed: ${(error as Error).message}`);
        }
      },
    },

    /**
     * Example: How to add a new test that checks if services are initialized
     * Uncomment and modify this template for your own tests
     */
    /*
    {
      name: 'Services initialization test',
      fn: async (runtime: any) => {
        // Example: Check if a specific service is available
        const myService = runtime.getService('my-service-name');
        if (!myService) {
          throw new Error('Expected service not found');
        }
        
        // Example: Test service functionality
        const result = await myService.doSomething();
        if (!result) {
          throw new Error('Service did not return expected result');
        }
      },
    },
    */

    /**
     * Example: How to test agent message processing
     * This shows how to simulate a conversation with the agent
     */
    /*
    {
      name: 'Agent conversation test',
      fn: async (runtime: any) => {
        // Create a test room/conversation
        const roomId = `test-room-${Date.now()}`;
        
        // Simulate sending a message to the agent
        const userMessage = {
          userId: 'test-user',
          roomId: roomId,
          content: { text: 'Hello agent!' },
          // Add other required message properties
        };
        
        // Process the message through the runtime
        await runtime.processMessage(userMessage);
        
        // Retrieve messages from the conversation
        const messages = await runtime.messageManager.getMessages({ roomId });
        
        // Verify the agent responded
        if (messages.length < 2) {
          throw new Error('Agent did not respond to message');
        }
        
        // Check the agent's response
        const agentResponse = messages.find(m => m.userId === runtime.agentId);
        if (!agentResponse) {
          throw new Error('Could not find agent response');
        }
        
        // Verify response content
        if (!agentResponse.content.text.toLowerCase().includes('hello')) {
          throw new Error('Agent response did not contain expected greeting');
        }
      },
    },
    */
  ];
}

// Export a default instance of the test suite for the E2E test runner
// The test runner will automatically discover and run this suite
export default new ProjectTestSuite();
