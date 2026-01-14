import type { Plugin, IAgentRuntime } from '@elizaos/core';
import { PancakeSwapV3LpService } from './services/PancakeSwapV3LpService.ts';

export const pancakeswapPlugin: Plugin = {
  name: '@elizaos/plugin-lp-manager/pancakeswap',
  description: 'PancakeSwap V3 liquidity pool management plugin',
  services: [PancakeSwapV3LpService],
  actions: [],
  evaluators: [],
  providers: [],
  init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
    console.info('PancakeSwap V3 Plugin initialized');
  },
};

export { PancakeSwapV3LpService };
export * from './types.ts';

export default pancakeswapPlugin;
