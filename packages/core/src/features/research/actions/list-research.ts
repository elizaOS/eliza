import type {
	Action,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { logger } from "../../../types/index.ts";
import type { UUID } from "../../../types/primitives.ts";
import { getResearchService } from "../services/researchService.ts";
import type { ListResearchOptions, ResearchStatus } from "../types.ts";

function readParams(options?: HandlerOptions): Record<string, unknown> {
	return options?.parameters && typeof options.parameters === "object"
		? (options.parameters as Record<string, unknown>)
		: {};
}

function resolveStatusFilter(
	value: unknown,
): ResearchStatus | "all" {
	if (value === "resolved" || value === "archived" || value === "all") {
		return value;
	}
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

export const listResearchAction: Action = {
	name: "LIST_RESEARCH",
	contexts: ["research", "agent_internal"],
	description: "List research threads for the current user.",
	similes: ["SHOW_RESEARCH", "GET_RESEARCH_LIST", "MY_RESEARCH"],

	validate: async (): Promise<boolean> => true,

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State | undefined,
		options: HandlerOptions | undefined,
		callback?: HandlerCallback,
	) => {
		try {
			const params = readParams(options);
			const listOpts: ListResearchOptions = {
				status: resolveStatusFilter(params.status),
				limit: optionalPositiveInt(params.limit),
			};

			const agentId = runtime.agentId as UUID;
			const userId =
				typeof message.entityId === "string"
					? (message.entityId as UUID)
					: agentId;

			const service = getResearchService(runtime);
			const threads = await service.list(agentId, userId, listOpts);

			if (threads.length === 0) {
				const statusLabel = listOpts.status === "all" ? "" : `${listOpts.status} `;
				const emptyMsg = `No ${statusLabel}research threads found.`;
				if (callback) {
					await callback({
						text: emptyMsg,
						actions: ["LIST_RESEARCH_SUCCESS"],
						source: message.content.source,
					});
				}
				return {
					success: true,
					text: emptyMsg,
					data: { threads: [], count: 0 },
				};
			}

			const lines = threads.map((r) => {
				return `- ${r.id}: "${r.title}" [${r.status}] findings=${r.findings.length}`;
			});
			const successMsg = `${threads.length} research thread(s):\n${lines.join("\n")}`;

			if (callback) {
				await callback({
					text: successMsg,
					actions: ["LIST_RESEARCH_SUCCESS"],
					source: message.content.source,
				});
			}
			return {
				success: true,
				text: successMsg,
				data: { threads, count: threads.length },
			};
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error("[ListResearch] Error:", errorMsg);
			if (callback) {
				await callback({
					text: `Failed to list research: ${errorMsg}`,
					actions: ["LIST_RESEARCH_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: `Failed to list research: ${errorMsg}` };
		}
	},

	parameters: [
		{
			name: "status",
			description:
				"Filter by status: 'open' (default), 'resolved', 'archived', or 'all'.",
			required: false,
			schema: {
				type: "string" as const,
				enum: ["open", "resolved", "archived", "all"],
			},
		},
		{
			name: "limit",
			description: "Maximum number of threads to return.",
			required: false,
			schema: { type: "number" as const, minimum: 1 },
		},
	],
	examples: [],
};

export default listResearchAction;
