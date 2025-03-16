import type { IAgentRuntime, Plugin } from '@elizaos/core';
import routes from './apis';
import { registerTasks } from './tasks';

// create a new plugin
export const degenIntelPlugin: Plugin = {
  name: 'degen-intel',
  description: 'Degen Intel plugin',
  routes,
  tests: [
    {
      name: 'test suite for degen-intel',
      tests: [
        {
          name: 'test for degen-intel',
          fn: async (runtime: IAgentRuntime) => {
            console.log('test in degen-intel working');
          },
        },
      ],
    },
  ],
  init: async (_, runtime: IAgentRuntime) => {
    await registerTasks(runtime);
  },
};
