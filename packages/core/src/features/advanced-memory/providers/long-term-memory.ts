import { logger } from "../../../logger.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../../../types/index.ts";
import { addHeader } from "../../../utils.ts";
import type { MemoryService } from "../services/memory-service.ts";
import { logAdvancedMemoryTrajectory } from "../trajectory.ts";

const MAX_LONG_TERM_MEMORY_TEXT_LENGTH = 5000;
const MAX_LONG_TERM_MEMORY_CATEGORIES = 10;

export const longTermMemoryProvider: Provider = {
	name: "LONG_TERM_MEMORY",
	description: "Persistent facts and preferences about the user",
	position: 50,
	contexts: ["general"],
	contextGate: { anyOf: ["general"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		try {
			const memoryService = runtime.getService(
				"memory",
			) as MemoryService | null;
			if (!memoryService) {
				return {
					data: { memoryCount: 0 },
					values: { longTermMemories: "" },
					text: "",
				};
			}

			const { entityId } = message;
			if (entityId === runtime.agentId) {
				return {
					data: { memoryCount: 0 },
					values: { longTermMemories: "" },
					text: "",
				};
			}

			const memories = await memoryService.getLongTermMemories(
				entityId,
				undefined,
				25,
			);
			if (memories.length === 0) {
				logAdvancedMemoryTrajectory({
					runtime,
					message,
					providerName: "LONG_TERM_MEMORY",
					purpose: "long_term_memory",
					data: {
						memoryCount: 0,
						categoryCount: 0,
					},
					query: {
						entityId,
					},
				});
				return {
					data: { memoryCount: 0 },
					values: { longTermMemories: "" },
					text: "",
				};
			}

			const formattedMemories =
				await memoryService.getFormattedLongTermMemories(entityId);
			const trimmedFormattedMemories =
				formattedMemories.length > MAX_LONG_TERM_MEMORY_TEXT_LENGTH
					? `${formattedMemories.slice(0, MAX_LONG_TERM_MEMORY_TEXT_LENGTH)}...`
					: formattedMemories;
			const text = addHeader(
				"# What I Know About You",
				trimmedFormattedMemories,
			);

			const categoryCounts = new Map<string, number>();
			for (const memory of memories) {
				const count = categoryCounts.get(memory.category) || 0;
				categoryCounts.set(memory.category, count + 1);
			}

			const categoryList = Array.from(categoryCounts.entries())
				.slice(0, MAX_LONG_TERM_MEMORY_CATEGORIES)
				.map(([cat, count]) => `${cat}: ${count}`)
				.join(", ");
			logAdvancedMemoryTrajectory({
				runtime,
				message,
				providerName: "LONG_TERM_MEMORY",
				purpose: "long_term_memory",
				data: {
					memoryCount: memories.length,
					categoryCount: categoryCounts.size,
				},
				query: {
					entityId,
				},
			});

			return {
				data: {
					memoryCount: memories.length,
					categories: categoryList,
					truncated:
						formattedMemories.length > MAX_LONG_TERM_MEMORY_TEXT_LENGTH,
				},
				values: {
					longTermMemories: text,
					memoryCategories: categoryList,
				},
				text,
			};
		} catch (error) {
			const err = error instanceof Error ? error.message : String(error);
			logger.error(
				{ src: "provider:memory", err },
				"Error in longTermMemoryProvider",
			);
			return {
				data: {
					memoryCount: 0,
					error: err,
				},
				values: { longTermMemories: "" },
				text: "",
			};
		}
	},
};
