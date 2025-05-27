import type { TestSuite, IAgentRuntime } from '@elizaos/core';
import { mrTeeCharacter } from '../src/character';

export class MrTeeProjectTestSuite implements TestSuite {
  name = 'mr-tee-project';
  description = 'E2E tests for Mr. TEE project-specific features';

  tests = [
    {
      name: 'Mr. TEE Project runtime environment test',
      fn: async (runtime: IAgentRuntime) => {
        try {
          if (!runtime.character) {
            throw new Error('Character not loaded in runtime');
          }
          if (runtime.character.name !== mrTeeCharacter.name) {
            throw new Error(
              `Expected character name to be ${mrTeeCharacter.name}, got ${runtime.character.name}`
            );
          }
          if (!runtime.character.system?.includes('Mr. TEE')) {
            throw new Error('Character system prompt does not contain "Mr. TEE"');
          }
          const hasTeePlugin = runtime.character.plugins?.some(
            (p) => typeof p === 'string' && p.includes('tee')
          );
          if (!hasTeePlugin) {
            throw new Error('Character does not have TEE plugin');
          }
        } catch (error) {
          throw new Error(`Mr. TEE Project runtime environment test failed: ${error.message}`);
        }
      },
    },
  ];
}

export default new MrTeeProjectTestSuite();
