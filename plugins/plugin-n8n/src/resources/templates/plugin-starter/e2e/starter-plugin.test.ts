import { starterPlugin } from '../dist/index.js';
import { type Content, type HandlerCallback } from '@elizaos/core';

// Define a minimal TestSuite interface that matches what's needed
interface TestSuite {
  name: string;
  description?: string;
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

export const StarterPluginTestSuite: TestSuite = {
  name: 'plugin_starter_test_suite',
  description: 'E2E tests for the starter plugin',

  tests: [
    {
      name: 'example_test',
      fn: async (runtime) => {
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
    {
      name: 'should_have_hello_world_action',
      fn: async (runtime) => {
        // Check if the hello world action is registered
        const actionExists = starterPlugin.actions?.some((a) => a.name === 'HELLO_WORLD');
        if (!actionExists) {
          throw new Error('Hello world action not found in plugin');
        }
      },
    },
    {
      name: 'hello_world_action_test',
      fn: async (runtime) => {
        // Create a test message
        const testMessage: Memory = {
          entityId: '12345678-1234-1234-1234-123456789012' as UUID,
          roomId: '12345678-1234-1234-1234-123456789012' as UUID,
          content: {
            text: 'Can you say hello?',
            source: 'test',
            actions: ['HELLO_WORLD'],
          },
        };

        // Create a test state
        const testState: State = {
          values: {},
          data: {},
          text: '',
        };

        let responseReceived = false;

        // Find the hello world action
        const helloWorldAction = starterPlugin.actions?.find((a) => a.name === 'HELLO_WORLD');
        if (!helloWorldAction) {
          throw new Error('Hello world action not found');
        }

        // Create a callback that meets the HandlerCallback interface
        const callback: HandlerCallback = async (response: Content) => {
          if (response.text && response.actions?.includes('HELLO_WORLD')) {
            responseReceived = true;
          }
          // Return Promise<Memory[]> as required by the HandlerCallback interface
          return Promise.resolve([]);
        };

        // Test the action directly
        await helloWorldAction.handler(runtime, testMessage, testState, {}, callback, []);

        if (!responseReceived) {
          throw new Error('Hello world action did not produce expected response');
        }
      },
    },
    {
      name: 'hello_world_provider_test',
      fn: async (runtime) => {
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

        // Find the hello world provider
        const helloWorldProvider = starterPlugin.providers?.find(
          (p) => p.name === 'HELLO_WORLD_PROVIDER'
        );
        if (!helloWorldProvider) {
          throw new Error('Hello world provider not found');
        }

        // Test the provider
        const result = await helloWorldProvider.get(runtime, testMessage, testState);

        if (result.text !== 'I am a provider') {
          throw new Error(`Expected provider to return "I am a provider", got "${result.text}"`);
        }
      },
    },
    {
      name: 'starter_service_test',
      fn: async (runtime) => {
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
  ],
};

// Export a default instance of the test suite for the E2E test runner
export default StarterPluginTestSuite;
