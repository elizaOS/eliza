import type { Plugin } from '@elizaos/core';
import { positionProvider } from './providers/positionProvider';
import { managePositionActionRetriggerEvaluator } from './evaluators/repositionEvaluator';
import { managePositions } from './actions/managePositions';

export const orcaPlugin: Plugin = {
  name: 'Orca LP Plugin',
  description: 'Orca LP plugin',
  evaluators: [managePositionActionRetriggerEvaluator],
  providers: [positionProvider],
  actions: [managePositions],
  services: [],
};

export default orcaPlugin;
