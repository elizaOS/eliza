import type { Action, IAgentRuntime } from "../../../types/index.ts";
import { getResearchService } from "../services/researchService.ts";

/**
 * Parent umbrella action for the research system.
 * Declares subActions so the sub-planner dispatches to the correct
 * child action. The parent has no handler of its own — the sub-planner
 * is invoked instead.
 */
export const researchAction: Action = {
	name: "RESEARCH",
	contexts: ["research", "agent_internal"],
	roleGate: { minRole: "USER" },
	description:
		"Route research-thread requests for the current user to the create, continue, read, list, edit, or delete research operation.",
	similes: ["RESEARCH_THREAD", "INQUIRY", "INVESTIGATE"],

	subActions: [
		"CREATE_RESEARCH",
		"CONTINUE_RESEARCH",
		"READ_RESEARCH",
		"LIST_RESEARCH",
		"EDIT_RESEARCH",
		"DELETE_RESEARCH",
	],

	subPlanner: {
		name: "research_subplanner",
		description:
			"Selects and sequences CREATE_RESEARCH, CONTINUE_RESEARCH, READ_RESEARCH, LIST_RESEARCH, EDIT_RESEARCH, and DELETE_RESEARCH for multi-step research requests.",
	},

	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		return Boolean(getResearchService(runtime));
	},

	// Handler is bypassed when subActions is present.
	handler: async () => {
		return {
			success: true,
			text: "Research request routed to the matching research operation.",
			data: { routed: true, subActions: researchAction.subActions ?? [] },
		};
	},

	parameters: [],
	examples: [],
};

export default researchAction;
