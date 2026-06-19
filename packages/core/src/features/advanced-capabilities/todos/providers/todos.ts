import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../../../../types/index.ts";
import { logger } from "../../../../types/index.ts";
import type { UUID } from "../../../../types/primitives.ts";
import { getTodosService } from "../services/todoService.ts";

function formatDue(dueAt: number): string {
	return new Date(dueAt).toISOString().slice(0, 10);
}

export const todosProvider: Provider = {
	name: "todos",
	description:
		"Current open todos for the active user. Surfaces tasks created via the TODO action.",
	dynamic: true,
	contexts: ["todos", "agent_internal"],
	cacheStable: false,
	cacheScope: "turn",

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		try {
			const agentId = runtime.agentId as UUID;
			const userId =
				typeof message.entityId === "string"
					? (message.entityId as UUID)
					: agentId;

			const service = getTodosService(runtime);
			const todos = await service.list(agentId, userId, { status: "open" });

			if (todos.length === 0) {
				return {
					text: "todos: none",
					data: { todos: [], count: 0 },
					values: { todoCount: 0 },
				};
			}

			const lines = ["todos:"];
			for (const todo of todos) {
				const due = todo.dueAt ? ` | due=${formatDue(todo.dueAt)}` : "";
				lines.push(
					`- id=${todo.id} | "${todo.title}" | open | createdAt=${todo.createdAt}${due}`,
				);
			}

			return {
				text: lines.join("\n"),
				data: { todos, count: todos.length },
				values: { todoCount: todos.length },
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error("[TodosProvider] Error:", errorMessage);
			return {
				text: "todos: unavailable",
				data: { todos: [], count: 0, error: errorMessage },
				values: { todoCount: 0 },
			};
		}
	},
};

export default todosProvider;
