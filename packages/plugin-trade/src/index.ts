import type { Plugin, IAgentRuntime } from '@elizaos/core';

import { TradeChainService } from './services/srv_chain';
import { TradeDataProviderService } from './services/srv_dataprovider';
import { TradeStrategyService } from './services/srv_strategy';

import { birdeyeStart } from './birdeye';
// Strategies
import { llmStrategy } from './strategies/strategy_llm';

export const traderPlugin: Plugin = {
  name: 'spartanOS',
  description: 'trader plugin',
  actions: [],
  evaluators: [],
  providers: [],
  services: [TradeChainService, TradeDataProviderService, TradeStrategyService],
  init: async (_, runtime: IAgentRuntime) => {
    console.log('trader init');
    birdeyeStart(runtime); // is async
    // register strategies
    llmStrategy(runtime); // is async
    console.log('trader init done');
  },
};

export default traderPlugin;
