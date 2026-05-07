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

export const deleteTodoAction: Action = {
	name: "DELETE_TODO",
	contexts: ["todos", "agent_internal"],
	description: "Delete (soft-delete) a todo item.",
	similes: ["REMOVE_TODO", "DISCARD_TODO"],

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
			const msg = "Could not delete todo: an id is required.";
			if (callback) {
				await callback({
					text: msg,
					actions: ["DELETE_TODO_FAILED"],
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
			const removed = await service.delete(agentId, userId, id as UUID);

			if (!removed) {
				const notFoundMsg = `Todo not found: ${id}`;
				if (callback) {
					await callback({
						text: notFoundMsg,
						actions: ["DELETE_TODO_FAILED"],
						source: message.content.source,
					});
				}
				return { success: false, text: notFoundMsg };
			}

			const successMsg = `Deleted todo ${id}.`;
			if (callback) {
				await callback({
					text: successMsg,
					actions: ["DELETE_TODO_SUCCESS"],
					source: message.content.source,
				});
			}
			return {
				success: true,
				text: successMsg,
				data: { id },
			};
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error("[DeleteTodo] Error:", errorMsg);
			if (callback) {
				await callback({
					text: `Failed to delete todo: ${errorMsg}`,
					actions: ["DELETE_TODO_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: `Failed to delete todo: ${errorMsg}` };
		}
	},

	parameters: [
		{
			name: "id",
			description: "ID of the todo to delete.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
	],
	examples: [],
};

export default deleteTodoAction;
