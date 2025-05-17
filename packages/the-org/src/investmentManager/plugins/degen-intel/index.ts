import type { IAgentRuntime, Plugin } from '@elizaos/core';
import routes from './apis';
import { registerTasks } from './tasks';
import { logger } from '@elizaos/core';

import { sentimentProvider } from './providers/sentiment';
import { cmcMarketProvider } from './providers/cmc_market';
import { birdeyeTrendingProvider } from './providers/birdeye_trending';
import { birdeyeTradePortfolioProvider } from './providers/birdeye_wallet';
// INTEL_SYNC_WALLET provider? or solana handles this?

// create a new plugin
export const degenIntelPlugin: Plugin = {
  name: 'degen-intel',
  description: 'Degen Intel plugin',
  routes,
  providers: [],
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

    const plugins = runtime.plugins.map((p) => p.name);
    let notUsed = true;

    // check for cmc key, if have then register provider
    if (runtime.getSetting('COINMARKETCAP_API_KEY')) {
      runtime.registerContextProvider(cmcMarketProvider);
      notUsed = false;
    }

    // check for birdeeye key, if have then register provider
    if (runtime.getSetting('BIRDEYE_API_KEY')) {
      runtime.registerContextProvider(birdeyeTrendingProvider);
      runtime.registerContextProvider(birdeyeTradePortfolioProvider);
      notUsed = false;
    }

    // twitter for sentiment
    if (plugins.indexOf('twitter') !== -1) {
      runtime.registerContextProvider(sentimentProvider);
      notUsed = false;
    }

    if (notUsed) {
      logger.warn(
        'degen-intel plugin is included but not providing any value (COINMARKETCAP_API_KEY/BIRDEYE_API_KEY or twitter are suggested)'
      );
    }
  },
};
