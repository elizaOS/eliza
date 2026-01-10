import { character } from '../dist/index.js';
import { v4 as uuidv4 } from 'uuid';

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
  description = 'E2E tests for the starter project';

  tests = [
    {
      name: 'Character configuration test',
      fn: async (runtime: any) => {
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
          throw new Error(`Failed to register plugin: ${error.message}`);
        }
      },
    },
    {
      name: 'Hello world action test',
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
            const helloWorldAction = runtime.actions.find((a) => a.name === 'HELLO_WORLD');
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
          throw new Error(`Hello world action test failed: ${error.message}`);
        }
      },
    },
    {
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
            (p) => p.name === 'HELLO_WORLD_PROVIDER'
          );

          if (!helloWorldProvider) {
            throw new Error('HELLO_WORLD_PROVIDER not found in runtime providers');
          }

          const result = await helloWorldProvider.get(runtime, message, state);

          if (result.text !== 'I am a provider') {
            throw new Error(`Expected provider to return "I am a provider", got "${result.text}"`);
          }
        } catch (error) {
          throw new Error(`Hello world provider test failed: ${error.message}`);
        }
      },
    },
    {
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
          throw new Error(`Starter service test failed: ${error.message}`);
        }
      },
    },
  ];
}

// Export a default instance of the test suite for the E2E test runner
export default new StarterTestSuite();
