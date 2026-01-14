import type { Plugin, IAgentRuntime } from '@elizaos/core';
import { positionProvider } from './providers/positionProvider.ts';
import { managePositionActionRetriggerEvaluator } from './evaluators/repositionEvaluator.ts';
import { managePositions } from './actions/managePositions.ts';
import { OrcaService } from './services/srv_orca.ts';

export const orcaPlugin: Plugin = {
  name: '@elizaos/plugin-lp-manager/orca',
  description: 'Orca Whirlpool LP management plugin for Solana',
  evaluators: [managePositionActionRetriggerEvaluator],
  providers: [positionProvider],
  actions: [managePositions],
  services: [OrcaService],
  init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
    console.info('Orca Plugin initialized');
  },
};

export { OrcaService };
export * from './types.ts';

export default orcaPlugin;
