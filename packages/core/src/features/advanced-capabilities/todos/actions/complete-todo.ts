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

export const completeTodoAction: Action = {
	name: "COMPLETE_TODO",
	contexts: ["todos", "agent_internal"],
	roleGate: { minRole: "USER" },
	description: "Mark one existing todo item as completed by id.",
	similes: ["DONE_TODO", "FINISH_TODO", "MARK_COMPLETE"],

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
			const msg = "Could not complete todo: an id is required.";
			if (callback) {
				await callback({
					text: msg,
					actions: ["COMPLETE_TODO_FAILED"],
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
			const todo = await service.complete(agentId, userId, id as UUID);

			const successMsg = `Completed todo "${todo.title}" (id: ${todo.id}).`;
			if (callback) {
				await callback({
					text: successMsg,
					actions: ["COMPLETE_TODO_SUCCESS"],
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
			logger.error("[CompleteTodo] Error:", errorMsg);
			if (callback) {
				await callback({
					text: `Failed to complete todo: ${errorMsg}`,
					actions: ["COMPLETE_TODO_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: `Failed to complete todo: ${errorMsg}` };
		}
	},

	parameters: [
		{
			name: "id",
			description: "ID of the todo to mark as completed.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
	],
	examples: [],
};

export default completeTodoAction;
