import type { Plugin } from "../../types/index.ts";
import { planAction } from "./actions/plan.ts";
import { PlanningService } from "./services/planning-service.ts";

export function createAdvancedPlanningPlugin(): Plugin {
	return {
		name: "advanced-planning",
		description: "Built-in advanced planning and execution capabilities",
		providers: [],
		actions: [planAction],
		services: [PlanningService],
	};
}

export { PlanningService } from "./services/planning-service.ts";
export * from "./types.ts";
