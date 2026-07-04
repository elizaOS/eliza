/**
 * Barrel and plugin factory for the advanced-planning capability:
 * `createAdvancedPlanningPlugin` registers the PLAN action and PlanningService,
 * and disposes the service on unload. Also re-exports the capability's public
 * types.
 */
import type { IAgentRuntime, Plugin } from "../../types/index.ts";
import { planAction } from "./actions/plan.ts";
import { PlanningService } from "./services/planning-service.ts";

export function createAdvancedPlanningPlugin(): Plugin {
	return {
		name: "advanced-planning",
		description: "Built-in advanced planning and execution capabilities",
		providers: [],
		actions: [planAction],
		services: [PlanningService],
		async dispose(runtime: IAgentRuntime) {
			const svc = runtime.getService<PlanningService>(
				PlanningService.serviceType,
			);
			await svc?.stop();
		},
	};
}

export { PlanningService } from "./services/planning-service.ts";
export * from "./types.ts";
