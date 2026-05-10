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

function optionalNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function extractTitle(
	message: Memory,
	options?: HandlerOptions,
): string | null {
	const params = readParams(options);
	const raw = params.title ?? message.content.title ?? message.content.text;
	return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export const createTodoAction: Action = {
	name: "CREATE_TODO",
	contexts: ["todos", "agent_internal"],
	roleGate: { minRole: "USER" },
	description:
		"Create a todo item for the current user with a required title plus optional notes and due date.",
	similes: ["ADD_TODO", "NEW_TODO", "MAKE_TODO"],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		return extractTitle(message, options) !== null;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State | undefined,
		options: HandlerOptions | undefined,
		callback?: HandlerCallback,
	) => {
		const title = extractTitle(message, options);
		if (!title) {
			const msg =
				"Could not create todo: a title is required. Please provide a title.";
			if (callback) {
				await callback({
					text: msg,
					actions: ["CREATE_TODO_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: msg };
		}

		const params = readParams(options);
		const notes =
			typeof params.notes === "string" && params.notes.trim()
				? params.notes.trim()
				: undefined;
		const dueAt = optionalNumber(params.dueAt);

		try {
			const agentId = runtime.agentId as UUID;
			const userId =
				typeof message.entityId === "string"
					? (message.entityId as UUID)
					: agentId;

			const service = getTodosService(runtime);
			const todo = await service.create(agentId, userId, {
				title,
				notes,
				dueAt,
			});

			const successMsg = `Created todo "${todo.title}" (id: ${todo.id}).`;
			if (callback) {
				await callback({
					text: successMsg,
					actions: ["CREATE_TODO_SUCCESS"],
					source: message.content.source,
				});
			}
			return {
				success: true,
				text: successMsg,
				data: { id: todo.id, title: todo.title },
			};
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error("[CreateTodo] Error:", errorMsg);
			if (callback) {
				await callback({
					text: `Failed to create todo: ${errorMsg}`,
					actions: ["CREATE_TODO_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: `Failed to create todo: ${errorMsg}` };
		}
	},

	parameters: [
		{
			name: "title",
			description: "Short title for the todo item.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
		{
			name: "notes",
			description: "Optional longer description or notes.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "dueAt",
			description: "Optional due date as a Unix timestamp (milliseconds).",
			required: false,
			schema: { type: "number" as const },
		},
	],
	examples: [
		[
			{
				name: "{{name1}}",
				content: { text: "Create a todo for buying groceries this weekend.", source: "chat" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Created todo \"Buy groceries\".",
					actions: ["CREATE_TODO"],
					thought:
						"Plain todo creation with a title; no due date specified, so dueAt is omitted.",
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: { text: "Add a todo: finish the design doc by Friday.", source: "chat" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Created todo \"Finish design doc\" with a Friday due date.",
					actions: ["CREATE_TODO"],
					thought:
						"Title plus a deadline maps to CREATE_TODO with title and dueAt computed from 'Friday'.",
				},
			},
		],
	],
};

export default createTodoAction;
