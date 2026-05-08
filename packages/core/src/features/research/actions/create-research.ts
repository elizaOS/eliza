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

/**
 * Integration point: This action stores a placeholder finding.
 * To wire in real web-search results, the sub-planner should:
 *   1. Run WEB_SEARCH with the query.
 *   2. Call CONTINUE_RESEARCH with the search result as the summary.
 * Or the orchestrator can post-process and update the finding directly
 * via ResearchService.edit / appendFinding after the web search completes.
 */

function readParams(options?: HandlerOptions): Record<string, unknown> {
	return options?.parameters && typeof options.parameters === "object"
		? (options.parameters as Record<string, unknown>)
		: {};
}

function extractTitle(
	message: Memory,
	options?: HandlerOptions,
): string | null {
	const params = readParams(options);
	const raw = params.title ?? message.content.title ?? message.content.text;
	return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function extractQuery(
	message: Memory,
	options?: HandlerOptions,
): string | null {
	const params = readParams(options);
	const raw = params.query ?? message.content.query ?? message.content.text;
	return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export const createResearchAction: Action = {
	name: "CREATE_RESEARCH",
	contexts: ["research", "agent_internal"],
	roleGate: { minRole: "USER" },
	description:
		"Start a new research thread. Requires a title and an initial query. Returns the new research id.",
	similes: ["START_RESEARCH", "NEW_RESEARCH", "BEGIN_RESEARCH"],

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
				"Could not create research: a title is required. Please provide a title.";
			if (callback) {
				await callback({
					text: msg,
					actions: ["CREATE_RESEARCH_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: msg };
		}

		const query = extractQuery(message, options) ?? title;

		try {
			const agentId = runtime.agentId as UUID;
			const userId =
				typeof message.entityId === "string"
					? (message.entityId as UUID)
					: agentId;

			const service = getResearchService(runtime);
			const research = await service.create(agentId, userId, { title, query });

			const successMsg = `Created research "${research.title}" (id: ${research.id}).`;
			if (callback) {
				await callback({
					text: successMsg,
					actions: ["CREATE_RESEARCH_SUCCESS"],
					source: message.content.source,
				});
			}
			return {
				success: true,
				text: successMsg,
				data: {
					id: research.id,
					title: research.title,
					status: research.status,
					findingsCount: research.findings.length,
				},
			};
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error("[CreateResearch] Error:", errorMsg);
			if (callback) {
				await callback({
					text: `Failed to create research: ${errorMsg}`,
					actions: ["CREATE_RESEARCH_FAILED"],
					source: message.content.source,
				});
			}
			return {
				success: false,
				text: `Failed to create research: ${errorMsg}`,
			};
		}
	},

	parameters: [
		{
			name: "title",
			description: "Short title for the research thread.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
		{
			name: "query",
			description: "Initial query or question to investigate.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
	],
	examples: [],
};

export default createResearchAction;
