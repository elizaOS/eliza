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
	const raw =
		params.id ?? message.content.id ?? message.content.researchId;
	return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export const deleteResearchAction: Action = {
	name: "DELETE_RESEARCH",
	contexts: ["research", "agent_internal"],
	description: "Permanently delete a research thread and all its findings.",
	similes: ["REMOVE_RESEARCH", "DISCARD_RESEARCH"],

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
			const msg = "Could not delete research: an id is required.";
			if (callback) {
				await callback({
					text: msg,
					actions: ["DELETE_RESEARCH_FAILED"],
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
			const removed = await service.delete(agentId, userId, id as UUID);

			if (!removed) {
				const notFoundMsg = `Research not found: ${id}`;
				if (callback) {
					await callback({
						text: notFoundMsg,
						actions: ["DELETE_RESEARCH_FAILED"],
						source: message.content.source,
					});
				}
				return { success: false, text: notFoundMsg };
			}

			const successMsg = `Deleted research ${id}.`;
			if (callback) {
				await callback({
					text: successMsg,
					actions: ["DELETE_RESEARCH_SUCCESS"],
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
			logger.error("[DeleteResearch] Error:", errorMsg);
			if (callback) {
				await callback({
					text: `Failed to delete research: ${errorMsg}`,
					actions: ["DELETE_RESEARCH_FAILED"],
					source: message.content.source,
				});
			}
			return {
				success: false,
				text: `Failed to delete research: ${errorMsg}`,
			};
		}
	},

	parameters: [
		{
			name: "id",
			description: "ID of the research thread to delete.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
	],
	examples: [],
};

export default deleteResearchAction;
