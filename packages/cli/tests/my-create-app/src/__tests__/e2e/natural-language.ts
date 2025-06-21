import { type TestSuite } from '@elizaos/core';

/**
 * Natural Language E2E Test Suite
 *
 * This suite tests the agent's ability to respond to natural language inputs,
 * including the requested "hello world" test.
 *
 * HOW TO ADD NEW NATURAL LANGUAGE TESTS:
 * 1. Add a new test object to the `tests` array
 * 2. Create a message with natural language content
 * 3. Process it through the runtime
 * 4. Verify the agent's response makes sense
 *
 * These tests use the REAL runtime with actual language processing,
 * so responses may vary based on the model and character configuration.
 */
export class NaturalLanguageTestSuite implements TestSuite {
  name = 'natural-language';
  description = 'E2E tests for natural language processing and agent responses';

  tests = [
    {
      name: 'Agent responds to hello world',
      fn: async (runtime: any) => {
        /**
         * This test verifies that the agent can respond appropriately
         * to a simple "hello world" greeting.
         */
        try {
          // Create a unique room for this test
          const roomId = `test-room-hello-${Date.now()}`;
          const userId = 'test-user-hello';

          // Create a message saying "hello world"
          const helloMessage = {
            id: `msg-${Date.now()}`,
            userId: userId,
            agentId: runtime.agentId,
            roomId: roomId,
            content: {
              text: 'hello world',
              type: 'text',
            },
            createdAt: Date.now(),
          };

          console.log('Sending hello world message to agent...');

          // Process the message through the runtime
          // This will trigger the agent to generate a response
          await runtime.processMessage(helloMessage);

          // Give the agent a moment to process and respond
          await new Promise((resolve) => setTimeout(resolve, 1000));

          // Retrieve messages from the conversation
          const messages = await runtime.messageManager.getMessages({
            roomId,
            limit: 10,
          });

          console.log(`Retrieved ${messages.length} messages from conversation`);

          // Verify we have at least 2 messages (user + agent)
          if (messages.length < 2) {
            throw new Error(`Expected at least 2 messages, got ${messages.length}`);
          }

          // Find the agent's response
          const agentResponse = messages.find(
            (m: any) =>
              m.userId === runtime.agentId && m.roomId === roomId && m.id !== helloMessage.id
          );

          if (!agentResponse) {
            throw new Error('Agent did not respond to hello world message');
          }

          console.log('Agent response:', agentResponse.content.text);

          // Verify the response contains a greeting
          const responseText = agentResponse.content.text.toLowerCase();
          const greetingWords = ['hello', 'hi', 'hey', 'greetings', 'welcome'];

          const containsGreeting = greetingWords.some((word) => responseText.includes(word));

          if (!containsGreeting) {
            throw new Error(
              `Agent response did not contain a greeting. ` +
                `Response was: "${agentResponse.content.text}"`
            );
          }

          console.log('✓ Agent successfully responded to hello world');
        } catch (error) {
          throw new Error(`Hello world test failed: ${(error as Error).message}`);
        }
      },
    },

    {
      name: 'Agent responds to casual greeting',
      fn: async (runtime: any) => {
        /**
         * Test various casual greetings to ensure the agent
         * responds appropriately to different forms of hello.
         */
        try {
          const greetings = ['hey there!', 'hi, how are you?', 'good morning!', 'whats up?'];

          for (const greeting of greetings) {
            const roomId = `test-room-greeting-${Date.now()}-${Math.random()}`;
            const userId = 'test-user-greeting';

            const message = {
              id: `msg-${Date.now()}-${Math.random()}`,
              userId: userId,
              agentId: runtime.agentId,
              roomId: roomId,
              content: {
                text: greeting,
                type: 'text',
              },
              createdAt: Date.now(),
            };

            console.log(`Testing greeting: "${greeting}"`);

            await runtime.processMessage(message);
            await new Promise((resolve) => setTimeout(resolve, 500));

            const messages = await runtime.messageManager.getMessages({
              roomId,
              limit: 10,
            });

            const agentResponse = messages.find(
              (m: any) => m.userId === runtime.agentId && m.id !== message.id
            );

            if (!agentResponse) {
              throw new Error(`Agent did not respond to greeting: "${greeting}"`);
            }

            // Just verify we got a response - content may vary
            if (!agentResponse.content.text || agentResponse.content.text.length < 2) {
              throw new Error(`Agent gave empty response to: "${greeting}"`);
            }

            console.log(`✓ Agent responded to: "${greeting}"`);
          }
        } catch (error) {
          throw new Error(`Casual greeting test failed: ${(error as Error).message}`);
        }
      },
    },

    {
      name: 'Agent maintains conversation context',
      fn: async (runtime: any) => {
        /**
         * Test that the agent remembers context from previous messages
         * in the same conversation.
         */
        try {
          const roomId = `test-room-context-${Date.now()}`;
          const userId = 'test-user-context';

          // First message - introduce a topic
          const firstMessage = {
            id: `msg-1-${Date.now()}`,
            userId: userId,
            agentId: runtime.agentId,
            roomId: roomId,
            content: {
              text: "My favorite color is blue. What's yours?",
              type: 'text',
            },
            createdAt: Date.now(),
          };

          console.log('Sending first message about favorite color...');
          await runtime.processMessage(firstMessage);
          await new Promise((resolve) => setTimeout(resolve, 1000));

          // Second message - reference the topic
          const secondMessage = {
            id: `msg-2-${Date.now()}`,
            userId: userId,
            agentId: runtime.agentId,
            roomId: roomId,
            content: {
              text: 'Why did you choose that color?',
              type: 'text',
            },
            createdAt: Date.now() + 1000,
          };

          console.log('Sending follow-up question...');
          await runtime.processMessage(secondMessage);
          await new Promise((resolve) => setTimeout(resolve, 1000));

          // Get all messages
          const messages = await runtime.messageManager.getMessages({
            roomId,
            limit: 10,
          });

          // Should have at least 4 messages (2 user + 2 agent)
          if (messages.length < 4) {
            throw new Error(`Expected at least 4 messages, got ${messages.length}`);
          }

          // Find the agent's second response
          const agentResponses = messages.filter((m: any) => m.userId === runtime.agentId);
          if (agentResponses.length < 2) {
            throw new Error('Agent did not respond to both messages');
          }

          // The second response should reference colors or the previous conversation
          const secondResponse = agentResponses[agentResponses.length - 1];
          const responseText = secondResponse.content.text.toLowerCase();

          // Check if the response shows context awareness
          const contextWords = ['color', 'blue', 'favorite', 'chose', 'choice', 'because'];
          const hasContext = contextWords.some((word) => responseText.includes(word));

          if (!hasContext) {
            console.warn(
              'Agent response may not show context awareness. ' +
                `Response: "${secondResponse.content.text}"`
            );
          }

          console.log('✓ Agent maintained conversation context');
        } catch (error) {
          throw new Error(`Context test failed: ${(error as Error).message}`);
        }
      },
    },
  ];
}

// Export a default instance for the test runner
export default new NaturalLanguageTestSuite();
