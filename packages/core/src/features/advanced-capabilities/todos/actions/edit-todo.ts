import type {
	Action,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../../types/index.ts";
import { logger } from "../../../../types/index.ts";
import type { UUID } from "../../../../types/primitives.ts";
import { getTodosService } from "../services/todoService.ts";
import type { EditTodoInput, TodoStatus } from "../types.ts";

function readParams(options?: HandlerOptions): Record<string, unknown> {
	return options?.parameters && typeof options.parameters === "object"
		? (options.parameters as Record<string, unknown>)
		: {};
}

function extractId(message: Memory, options?: HandlerOptions): string | null {
	const params = readParams(options);
	const raw = params.id ?? message.content.id ?? message.content.todoId;
	return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function optionalNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function resolveStatus(value: unknown): TodoStatus | undefined {
	if (value === "open" || value === "completed" || value === "deleted") {
		return value;
	}
	return undefined;
}

export const editTodoAction: Action = {
	name: "EDIT_TODO",
	contexts: ["todos", "agent_internal"],
	roleGate: { minRole: "USER" },
	description:
		"Edit one existing todo item by id, updating its title, notes, due date, or status.",
	similes: ["UPDATE_TODO", "MODIFY_TODO", "CHANGE_TODO"],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		return extractId(message, options) !== null;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State | undefined,
		options: HandlerOptions | undefined,
		callback?: HandlerCallback,
	) => {
		const id = extractId(message, options);
		if (!id) {
			const msg = "Could not edit todo: an id is required.";
			if (callback) {
				await callback({
					text: msg,
					actions: ["EDIT_TODO_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: msg };
		}

		const params = readParams(options);
		const patch: EditTodoInput = {};

		if (typeof params.title === "string" && params.title.trim()) {
			patch.title = params.title.trim();
		}
		if (typeof params.notes === "string") {
			patch.notes = params.notes.trim();
		}
		const dueAt = optionalNumber(params.dueAt);
		if (dueAt !== undefined) {
			patch.dueAt = dueAt;
		}
		const status = resolveStatus(params.status);
		if (status !== undefined) {
			patch.status = status;
		}

		if (Object.keys(patch).length === 0) {
			const msg =
				"No changes provided. Supply at least one of: title, notes, dueAt, status.";
			if (callback) {
				await callback({
					text: msg,
					actions: ["EDIT_TODO_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: msg };
		}

		try {
			const agentId = runtime.agentId as UUID;
			const userId =
				typeof message.entityId === "string"
					? (message.entityId as UUID)
					: agentId;

			const service = getTodosService(runtime);
			const todo = await service.edit(agentId, userId, id as UUID, patch);

			const successMsg = `Updated todo "${todo.title}" (id: ${todo.id}).`;
			if (callback) {
				await callback({
					text: successMsg,
					actions: ["EDIT_TODO_SUCCESS"],
					source: message.content.source,
				});
			}
			return {
				success: true,
				text: successMsg,
				data: { id: todo.id, title: todo.title, status: todo.status },
			};
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error("[EditTodo] Error:", errorMsg);
			if (callback) {
				await callback({
					text: `Failed to edit todo: ${errorMsg}`,
					actions: ["EDIT_TODO_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: `Failed to edit todo: ${errorMsg}` };
		}
	},

	parameters: [
		{
			name: "id",
			description: "ID of the todo to edit.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
		{
			name: "title",
			description: "New title.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "notes",
			description: "New notes.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "dueAt",
			description: "New due date as a Unix timestamp (milliseconds).",
			required: false,
			schema: { type: "number" as const },
		},
		{
			name: "status",
			description: "New status.",
			required: false,
			schema: {
				type: "string" as const,
				enum: ["open", "completed", "deleted"],
			},
		},
	],
	examples: [],
};

export default editTodoAction;
