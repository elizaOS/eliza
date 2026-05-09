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

export const readResearchAction: Action = {
	name: "READ_RESEARCH",
	contexts: ["research", "agent_internal"],
	description: "Fetch a single research thread by id, including all findings.",
	similes: ["GET_RESEARCH", "SHOW_RESEARCH", "FETCH_RESEARCH"],

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
			const msg = "Could not read research: an id is required.";
			if (callback) {
				await callback({
					text: msg,
					actions: ["READ_RESEARCH_FAILED"],
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
			const research = await service.get(agentId, userId, id as UUID);

			if (!research) {
				const notFoundMsg = `Research not found: ${id}`;
				if (callback) {
					await callback({
						text: notFoundMsg,
						actions: ["READ_RESEARCH_FAILED"],
						source: message.content.source,
					});
				}
				return { success: false, text: notFoundMsg };
			}

			const findingLines = research.findings.map((f, i) => {
				const sources =
					f.sources && f.sources.length > 0
						? `\n    sources: ${f.sources.map((s) => s.url).join(", ")}`
						: "";
				return `  ${i + 1}. [${new Date(f.capturedAt).toISOString()}] "${f.query}"\n    ${f.summary}${sources}`;
			});

			const successMsg = [
				`Research "${research.title}" (id: ${research.id})`,
				`  status: ${research.status}`,
				`  findings (${research.findings.length}):`,
				...findingLines,
			].join("\n");

			if (callback) {
				await callback({
					text: successMsg,
					actions: ["READ_RESEARCH_SUCCESS"],
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
			logger.error("[ReadResearch] Error:", errorMsg);
			if (callback) {
				await callback({
					text: `Failed to read research: ${errorMsg}`,
					actions: ["READ_RESEARCH_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: `Failed to read research: ${errorMsg}` };
		}
	},

	parameters: [
		{
			name: "id",
			description: "ID of the research thread to fetch.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
	],
	examples: [],
};

export default readResearchAction;
