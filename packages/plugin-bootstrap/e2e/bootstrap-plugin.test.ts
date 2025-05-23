import { bootstrapPlugin } from '../src/index';
import {
  createMockRuntime,
  createMockMemory,
  createMockState,
  setupActionTest,
} from '../__tests__/test-utils';
import type { TestSuite } from '@elizaos/core';

export class BootstrapPluginTestSuite implements TestSuite {
  name = 'bootstrap_plugin_e2e';
  description = 'E2E tests for bootstrap plugin primitives';

  tests = [
    {
      name: 'loads expected primitives',
      fn: async () => {
        const expectedActions = [
          'REPLY',
          'FOLLOW_ROOM',
          'UNFOLLOW_ROOM',
          'IGNORE',
          'NONE',
          'MUTE_ROOM',
          'UNMUTE_ROOM',
          'SEND_MESSAGE',
          'UPDATE_ENTITY',
          'CHOOSE_OPTION',
          'UPDATE_ROLE',
          'UPDATE_SETTINGS',
        ];
        for (const name of expectedActions) {
          if (!bootstrapPlugin.actions?.some((a) => a.name === name)) {
            throw new Error(`Missing action ${name}`);
          }
        }

        const expectedProviders = [
          'EVALUATORS',
          'ANXIETY',
          'TIME',
          'ENTITIES',
          'RELATIONSHIPS',
          'CHOICE',
          'FACTS',
          'ROLES',
          'SETTINGS',
          'CAPABILITIES',
          'ATTACHMENTS',
          'PROVIDERS',
          'ACTIONS',
          'CHARACTER',
          'RECENT_MESSAGES',
          'WORLD',
          'SHOULD_RESPOND',
        ];
        for (const name of expectedProviders) {
          if (!bootstrapPlugin.providers?.some((p) => p.name === name)) {
            throw new Error(`Missing provider ${name}`);
          }
        }

        if (!bootstrapPlugin.evaluators?.some((e) => e.name === 'REFLECTION')) {
          throw new Error('Reflection evaluator missing');
        }
      },
    },
    {
      name: 'time provider returns time text',
      fn: async () => {
        const runtime = createMockRuntime();
        const message = createMockMemory();
        const provider = bootstrapPlugin.providers?.find((p) => p.name === 'TIME');
        if (!provider) throw new Error('TIME provider not found');
        const result = await provider.get(runtime as any, message as any, {} as any);
        if (!result.text) {
          throw new Error('TIME provider returned empty text');
        }
      },
    },
    {
      name: 'reply action produces a response',
      fn: async () => {
        const { mockRuntime, mockMessage, mockState, callbackFn } = setupActionTest();
        const action = bootstrapPlugin.actions?.find((a) => a.name === 'REPLY');
        if (!action) throw new Error('REPLY action not found');
        await action.handler(
          mockRuntime as any,
          mockMessage as any,
          mockState as any,
          {},
          callbackFn,
          []
        );
        if (!callbackFn.mock.calls.length) {
          throw new Error('Reply action did not invoke callback');
        }
      },
    },
    {
      name: 'reflection evaluator runs',
      fn: async () => {
        const evaluator = bootstrapPlugin.evaluators?.find((e) => e.name === 'REFLECTION');
        if (!evaluator) throw new Error('Reflection evaluator not found');
        const { mockRuntime, mockMessage, mockState } = setupActionTest();
        await evaluator.handler(mockRuntime as any, mockMessage as any, mockState as any);
      },
    },
  ];
}

export default new BootstrapPluginTestSuite();
