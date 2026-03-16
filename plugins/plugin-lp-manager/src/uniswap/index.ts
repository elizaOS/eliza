import type { Plugin, IAgentRuntime } from '@elizaos/core';
import { UniswapV3LpService } from './services/UniswapV3LpService.ts';

export const uniswapPlugin: Plugin = {
  name: '@elizaos/plugin-lp-manager/uniswap',
  description: 'Uniswap V3 liquidity pool management plugin',
  services: [UniswapV3LpService],
  actions: [],
  evaluators: [],
  providers: [],
  init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
    console.info('Uniswap V3 Plugin initialized');
  },
};

export { UniswapV3LpService };
export * from './types.ts';

export default uniswapPlugin;
