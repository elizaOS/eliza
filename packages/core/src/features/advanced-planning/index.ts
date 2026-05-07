import type { Plugin } from "../../types/index.ts";
import { createPlanAction } from "./actions/create-plan.ts";
import { PlanningService } from "./services/planning-service.ts";

export function createAdvancedPlanningPlugin(): Plugin {
	return {
		name: "advanced-planning",
		description: "Built-in advanced planning and execution capabilities",
		providers: [],
		actions: [createPlanAction],
		services: [PlanningService],
		evaluators: [],
	};
}

export { PlanningService } from "./services/planning-service.ts";
export * from "./types.ts";
