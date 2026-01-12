import type { Plugin } from "@elizaos/core";
import {
  analyzeInputAction,
  createPlanAction,
  executeFinalAction,
  processAnalysisAction,
} from "./actions/chain-example";
import { messageClassifierProvider } from "./providers/message-classifier";
import { PlanningService } from "./services/planning-service";

export const planningPlugin: Plugin = {
  name: "@elizaos/plugin-planning",
  description: "Planning and execution plugin",

  providers: [messageClassifierProvider],

  actions: [analyzeInputAction, processAnalysisAction, executeFinalAction, createPlanAction],

  services: [PlanningService],
  evaluators: [],
};

export const strategyPlugin = planningPlugin;

export default planningPlugin;
