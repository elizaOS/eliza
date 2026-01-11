import type { Plugin } from '@elizaos/core';
import { messageClassifierProvider } from './providers/message-classifier';
import {
  analyzeInputAction,
  processAnalysisAction,
  executeFinalAction,
  createPlanAction,
} from './actions/chain-example';
import { PlanningService } from './services/planning-service';

export * from './types';
export * from './services/planning-service';
export * from './providers/message-classifier';
export * from './actions/chain-example';

export const planningPlugin: Plugin = {
  name: '@elizaos/plugin-planning',
  description: 'Comprehensive planning and execution plugin with unified planning service',

  providers: [messageClassifierProvider],

  actions: [analyzeInputAction, processAnalysisAction, executeFinalAction, createPlanAction],

  services: [PlanningService],
  evaluators: [],
};

// Maintain backwards compatibility
export const strategyPlugin = planningPlugin;

export default planningPlugin;


