import type { Plugin, IAgentRuntime } from '@elizaos/core';

import { TradeChainService } from './services/srv_chain';
import { TradeDataProviderService } from './services/srv_dataprovider';
import { TradeStrategyService } from './services/srv_strategy';
import { JupiterService } from './services/srv_jupiter';

// Strategies
import { llmStrategy } from './strategies/strategy_llm';
import { copyStrategy } from './strategies/strategy_copy';

import { registerTasks } from './tasks';

export const jupiterPlugin: Plugin = {
  name: 'jupiterOS',
  description: 'jupiter plugin',
  actions: [],
  evaluators: [],
  providers: [],
  services: [TradeChainService, TradeDataProviderService, TradeStrategyService, JupiterService],
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

export default jupiterPlugin;
