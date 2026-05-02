import type { Plugin } from '@elizaos/core';
import { positionProvider } from './providers/orca/positionProvider';
import { managePositionActionRetriggerEvaluator } from './evaluators/orca/repositionEvaluator';
import { managePositions } from './actions/orca/managePositions';

export const orcaPlugin: Plugin = {
  name: 'Orca LP Plugin',
  description: 'Orca LP plugin',
  evaluators: [managePositionActionRetriggerEvaluator],
  providers: [positionProvider],
  actions: [managePositions],
  services: [],
};

export default orcaPlugin;
