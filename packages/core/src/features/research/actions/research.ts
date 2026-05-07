import type { Action } from "../../../types/index.ts";

/**
 * Parent umbrella action for the research system.
 * Declares subActions so the sub-planner dispatches to the correct
 * child action. The parent has no handler of its own — the sub-planner
 * is invoked instead.
 */
export const researchAction: Action = {
	name: "RESEARCH",
	contexts: ["research", "agent_internal"],
	description:
		"Manage the current user's research threads. Can create, continue, read, list, edit, or delete research inquiries. The sub-planner chooses the appropriate sub-action.",
	similes: ["RESEARCH_THREAD", "INQUIRY", "INVESTIGATE"],

	subActions: [
		"CREATE_RESEARCH",
		"CONTINUE_RESEARCH",
		"READ_RESEARCH",
		"LIST_RESEARCH",
		"EDIT_RESEARCH",
		"DELETE_RESEARCH",
	],

	validate: async (): Promise<boolean> => true,

	// Handler is bypassed when subActions is present — sub-planner takes over.
	handler: async () => {
		return { success: true, text: "research sub-planner invoked" };
	},

	parameters: [],
	examples: [],
};

export default researchAction;
