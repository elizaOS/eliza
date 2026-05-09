import type { Action, IAgentRuntime } from "../../../../types/index.ts";
import { getTodosService } from "../services/todoService.ts";

/**
 * Parent umbrella action for the todo system.
 * Declares subActions so the sub-planner dispatches to the correct
 * child action (CREATE_TODO, COMPLETE_TODO, LIST_TODOS, EDIT_TODO, DELETE_TODO).
 * The parent has no handler of its own — the sub-planner is invoked instead.
 */
export const todoAction: Action = {
	name: "TODO",
	contexts: ["todos", "agent_internal"],
	roleGate: { minRole: "USER" },
	description:
		"Route todo-list requests for the current user to the create, complete, list, edit, or delete todo operation.",
	similes: ["TODOS", "TASK", "TASKS"],

	subActions: [
		"CREATE_TODO",
		"COMPLETE_TODO",
		"LIST_TODOS",
		"EDIT_TODO",
		"DELETE_TODO",
	],

	subPlanner: {
		name: "todo_subplanner",
		description:
			"Selects and sequences CREATE_TODO, COMPLETE_TODO, LIST_TODOS, EDIT_TODO, and DELETE_TODO for multi-step todo requests.",
	},

	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		return Boolean(getTodosService(runtime));
	},

	// Handler is bypassed when subActions is present.
	handler: async () => {
		return {
			success: true,
			text: "Todo request routed to the matching todo operation.",
			data: { routed: true, subActions: todoAction.subActions ?? [] },
		};
	},

	parameters: [],
	examples: [],
};

export default todoAction;
