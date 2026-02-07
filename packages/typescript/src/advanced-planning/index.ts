import type { Plugin } from "../types/index.ts";
import {
  analyzeInputAction,
  createPlanAction,
  executeFinalAction,
  processAnalysisAction,
} from "./actions/chain-example.ts";
import { messageClassifierProvider } from "./providers/message-classifier.ts";
import { PlanningService } from "./services/planning-service.ts";

export function createAdvancedPlanningPlugin(): Plugin {
  return {
    name: "advanced-planning",
    description: "Built-in advanced planning and execution capabilities",
    providers: [messageClassifierProvider],
    actions: [
      analyzeInputAction,
      processAnalysisAction,
      executeFinalAction,
      createPlanAction,
    ],
    services: [PlanningService],
    evaluators: [],
  };
}

export { PlanningService } from "./services/planning-service.ts";
export * from "./types.ts";
