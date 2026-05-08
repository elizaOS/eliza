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
 * Integration point: Appends a placeholder finding to the research thread.
 * To wire in real web-search results, the orchestrator should run WEB_SEARCH
 * first and pass the result summary + sources as additional parameters,
 * or call ResearchService directly with the enriched finding data.
 */

function readParams(options?: HandlerOptions): Record<string, unknown> {
	return options?.parameters && typeof options.parameters === "object"
		? (options.parameters as Record<string, unknown>)
		: {};
}

function extractId(message: Memory, options?: HandlerOptions): string | null {
	const params = readParams(options);
	const raw = params.id ?? message.content.id ?? message.content.researchId;
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

export const continueResearchAction: Action = {
	name: "CONTINUE_RESEARCH",
	contexts: ["research", "agent_internal"],
	roleGate: { minRole: "USER" },
	description:
		"Append a new finding to an existing research thread. Requires the research id and a follow-up query.",
	similes: ["APPEND_RESEARCH", "ADD_RESEARCH_FINDING", "EXTEND_RESEARCH"],

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
			const msg = "Could not continue research: an id is required.";
			if (callback) {
				await callback({
					text: msg,
					actions: ["CONTINUE_RESEARCH_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: msg };
		}

		const query = extractQuery(message, options);
		if (!query) {
			const msg = "Could not continue research: a query is required.";
			if (callback) {
				await callback({
					text: msg,
					actions: ["CONTINUE_RESEARCH_FAILED"],
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

			const service = getResearchService(runtime);
			const research = await service.continue(
				agentId,
				userId,
				id as UUID,
				query,
			);

			const successMsg = `Continued research "${research.title}" (id: ${research.id}). Findings: ${research.findings.length}.`;
			if (callback) {
				await callback({
					text: successMsg,
					actions: ["CONTINUE_RESEARCH_SUCCESS"],
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
			logger.error("[ContinueResearch] Error:", errorMsg);
			if (callback) {
				await callback({
					text: `Failed to continue research: ${errorMsg}`,
					actions: ["CONTINUE_RESEARCH_FAILED"],
					source: message.content.source,
				});
			}
			return {
				success: false,
				text: `Failed to continue research: ${errorMsg}`,
			};
		}
	},

	parameters: [
		{
			name: "id",
			description: "ID of the research thread to continue.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
		{
			name: "query",
			description: "Follow-up query or question for the next exploration step.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
	],
	examples: [],
};

export default continueResearchAction;
