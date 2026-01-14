import type { Plugin, IAgentRuntime } from '@elizaos/core';
import { AerodromeLpService } from './services/AerodromeLpService.ts';

export const aerodromePlugin: Plugin = {
  name: '@elizaos/plugin-lp-manager/aerodrome',
  description: 'Aerodrome DEX liquidity pool management plugin for Base chain',
  services: [AerodromeLpService],
  actions: [],
  evaluators: [],
  providers: [],
  init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
    console.info('Aerodrome Plugin initialized');
  },
};

export { AerodromeLpService };
export * from './types.ts';

export default aerodromePlugin;
