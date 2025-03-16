import type { Plugin } from '@elizaos/core';
import { DegenTradingService } from './tradingService';

export const degenTraderPlugin: Plugin = {
  name: 'Degen Trader Plugin',
  description: 'Autonomous trading agent plugin',
  evaluators: [],
  providers: [],
  actions: [],
  services: [DegenTradingService],
};

export default degenTraderPlugin;
