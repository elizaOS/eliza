import type { Action } from "../../../../types/index.ts";

/**
 * Parent umbrella action for the todo system.
 * Declares subActions so the sub-planner dispatches to the correct
 * child action (CREATE_TODO, COMPLETE_TODO, LIST_TODOS, EDIT_TODO, DELETE_TODO).
 * The parent has no handler of its own — the sub-planner is invoked instead.
 */
export const todoAction: Action = {
	name: "TODO",
	contexts: ["todos", "agent_internal"],
	description:
		"Manage the current user's todo list. Can create, complete, list, edit, or delete todo items. The sub-planner chooses the appropriate sub-action.",
	similes: ["TODOS", "TASK", "TASKS"],

	subActions: [
		"CREATE_TODO",
		"COMPLETE_TODO",
		"LIST_TODOS",
		"EDIT_TODO",
		"DELETE_TODO",
	],

	validate: async (): Promise<boolean> => true,

	// Handler is bypassed when subActions is present — sub-planner takes over.
	handler: async () => {
		return { success: true, text: "todo sub-planner invoked" };
	},

	parameters: [],
	examples: [],
};

export default todoAction;
