import { character } from '../src/index';
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
        if (character.name !== 'Mr. TEE') {
          throw new Error(`Expected character name to be 'Mr. TEE', got '${character.name}'`);
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
            init: async () => { },
            config: {},
          });
        } catch (error) {
          throw new Error(`Failed to register plugin: ${error.message}`);
        }
      },
    },
  ];
}

// Export a default instance of the test suite for the E2E test runner
export default new StarterTestSuite();
