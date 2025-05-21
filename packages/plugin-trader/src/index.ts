import type { Plugin, IAgentRuntime } from '@elizaos/core';

import { TradeChainService } from './services/chain';
import { TradeDataProviderService } from './services/dataprovider';
import { TradeStrategyService } from './services/strategy';

// Strategies
import { llmStrategy } from './strategies/llm';
import { copyStrategy } from './strategies/copy';

import { registerTasks } from './tasks';

export const traderPlugin: Plugin = {
  name: 'spartanOS',
  description: 'trader plugin',
  actions: [],
  evaluators: [],
  providers: [],
  services: [TradeChainService, TradeDataProviderService, TradeStrategyService],
  init: async (_, runtime: IAgentRuntime) => {
    console.log('trader init');
    // register strategies
    llmStrategy(runtime); // is async
    copyStrategy(runtime); // is async
    // register tasks
    registerTasks(runtime); // is async
    console.log('trader init done');
  },
};

export default traderPlugin;
