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
import type { ListTodosOptions } from "../types.ts";

function readParams(options?: HandlerOptions): Record<string, unknown> {
	return options?.parameters && typeof options.parameters === "object"
		? (options.parameters as Record<string, unknown>)
		: {};
}

function resolveStatusFilter(value: unknown): "open" | "completed" | "all" {
	if (value === "completed" || value === "all") return value;
	return "open";
}

function optionalPositiveInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Math.floor(Number(value));
		return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
	}
	return undefined;
}

function formatDue(dueAt: number): string {
	return new Date(dueAt).toISOString().slice(0, 10);
}

export const listTodosAction: Action = {
	name: "LIST_TODOS",
	contexts: ["todos", "agent_internal"],
	roleGate: { minRole: "USER" },
	description:
		"List todo items for the current user, optionally filtered by status and limited by count.",
	similes: ["SHOW_TODOS", "GET_TODOS", "MY_TODOS"],

	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		return Boolean(getTodosService(runtime));
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State | undefined,
		options: HandlerOptions | undefined,
		callback?: HandlerCallback,
	) => {
		try {
			const params = readParams(options);
			const listOpts: ListTodosOptions = {
				status: resolveStatusFilter(params.status),
				limit: optionalPositiveInt(params.limit),
			};

			const agentId = runtime.agentId as UUID;
			const userId =
				typeof message.entityId === "string"
					? (message.entityId as UUID)
					: agentId;

			const service = getTodosService(runtime);
			const todos = await service.list(agentId, userId, listOpts);

			if (todos.length === 0) {
				const emptyMsg = `No ${listOpts.status === "all" ? "" : `${listOpts.status} `}todos found.`;
				if (callback) {
					await callback({
						text: emptyMsg,
						actions: ["LIST_TODOS_SUCCESS"],
						source: message.content.source,
					});
				}
				return {
					success: true,
					text: emptyMsg,
					data: { todos: [], count: 0 },
				};
			}

			const lines = todos.map((t) => {
				const due = t.dueAt ? ` (due: ${formatDue(t.dueAt)})` : "";
				const status = t.status !== "open" ? ` [${t.status}]` : "";
				return `- ${t.id}: "${t.title}"${status}${due}`;
			});
			const successMsg = `${todos.length} todo(s):\n${lines.join("\n")}`;

			if (callback) {
				await callback({
					text: successMsg,
					actions: ["LIST_TODOS_SUCCESS"],
					source: message.content.source,
				});
			}
			return {
				success: true,
				text: successMsg,
				data: { todos, count: todos.length },
			};
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error("[ListTodos] Error:", errorMsg);
			if (callback) {
				await callback({
					text: `Failed to list todos: ${errorMsg}`,
					actions: ["LIST_TODOS_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: `Failed to list todos: ${errorMsg}` };
		}
	},

	parameters: [
		{
			name: "status",
			description: "Filter by status: 'open' (default), 'completed', or 'all'.",
			required: false,
			schema: {
				type: "string" as const,
				enum: ["open", "completed", "all"],
			},
		},
		{
			name: "limit",
			description: "Maximum number of todos to return.",
			required: false,
			schema: { type: "number" as const, minimum: 1 },
		},
	],
	examples: [],
};

export default listTodosAction;
