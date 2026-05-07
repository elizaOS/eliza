import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../../../types/index.ts";
import { logger } from "../../../types/index.ts";
import type { UUID } from "../../../types/primitives.ts";
import { getResearchService } from "../services/researchService.ts";

export const researchProvider: Provider = {
	name: "research",
	description:
		"Open research threads for the active user. Surfaces active inquiries created via the RESEARCH action.",
	dynamic: true,
	contexts: ["research", "agent_internal"],
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

			const service = getResearchService(runtime);
			const threads = await service.list(agentId, userId, { status: "open" });

			if (threads.length === 0) {
				return {
					text: "research: none",
					data: { threads: [], count: 0 },
					values: { researchCount: 0 },
				};
			}

			const lines = ["research:"];
			for (const r of threads) {
				lines.push(
					`- id=${r.id} | "${r.title}" | ${r.status} | findings=${r.findings.length} | updatedAt=${r.updatedAt}`,
				);
			}

			return {
				text: lines.join("\n"),
				data: { threads, count: threads.length },
				values: { researchCount: threads.length },
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error("[ResearchProvider] Error:", errorMessage);
			return {
				text: "research: unavailable",
				data: { threads: [], count: 0, error: errorMessage },
				values: { researchCount: 0 },
			};
		}
	},
};

export default researchProvider;
