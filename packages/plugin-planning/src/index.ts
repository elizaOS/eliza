import { Plugin } from '@elizaos/core';
import { messageClassifierProvider } from './providers/message-classifier';
import {
  analyzeInputAction,
  processAnalysisAction,
  executeFinalAction,
  createPlanAction,
} from './actions/chain-example';

export * from './types';

export const strategyPlugin: Plugin = {
  name: '@elizaos/plugin-strategy',
  description: 'Strategy planning and execution plugin with action chaining support',

  providers: [messageClassifierProvider],

  actions: [analyzeInputAction, processAnalysisAction, executeFinalAction, createPlanAction],

  services: [],
  evaluators: [],
};

export default strategyPlugin;
