import type { Plugin } from '@elizaos/core';
import { messageClassifierProvider } from './providers/message-classifier';
import {
  analyzeInputAction,
  processAnalysisAction,
  executeFinalAction,
  createPlanAction,
} from './actions/chain-example';
import { PlanningService } from './services/planning-service';
import { testSuites } from './__tests__/e2e';
import realmBenchmarkScenarios from './scenarios/realm-benchmark-scenario';
import { planningWorkflowScenario } from './scenarios/planning-workflow-scenario';

export * from './types';
export * from './services/planning-service';

export const planningPlugin: Plugin = {
  name: '@elizaos/plugin-planning',
  description: 'Comprehensive planning and execution plugin with unified planning service',

  providers: [messageClassifierProvider],

  actions: [analyzeInputAction, processAnalysisAction, executeFinalAction, createPlanAction],

  services: [PlanningService],
  evaluators: [],
  tests: testSuites,
  scenarios: [planningWorkflowScenario, ...realmBenchmarkScenarios],
};

// Maintain backwards compatibility
export const strategyPlugin = planningPlugin;

export default planningPlugin;
