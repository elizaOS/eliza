import type { IAgentRuntime, Plugin } from '@elizaos/core';
import routes from './apis';
import { registerTasks } from './tasks';
import { logger } from '@elizaos/core';
import BuySignal from './providers/buy-signal';
import SellSignal from './providers/sell-signal';

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
            logger.info('test in degen-intel working');
          },
        },
      ],
    },
  ],
  init: async (_, runtime: IAgentRuntime) => {
    await registerTasks(runtime);

    // Initialize signal generators
    const buySignal = new BuySignal(runtime);
    const sellSignal = new SellSignal(runtime);

    // Register periodic tasks to generate signals
    setInterval(
      async () => {
        try {
          logger.info('Generating buy signal...');
          await buySignal.generateSignal();
        } catch (error) {
          logger.error('Error generating buy signal:', error);
        }
      },
      5 * 60 * 1000
    ); // Every 5 minutes

    setInterval(
      async () => {
        try {
          logger.info('Generating sell signal...');
          await sellSignal.generateSignal();
        } catch (error) {
          logger.error('Error generating sell signal:', error);
        }
      },
      5 * 60 * 1000
    ); // Every 5 minutes
  },
};
