/**
 * The `LONG_TERM_MEMORY` provider of the advanced-memory capability: injects the
 * persistent facts and preferences stored about the current user into prompt
 * context, rendered as "What I Know About You" with a per-category count. Reads
 * the memories from `MemoryService` via `runtime.getService("memory")`, formats
 * the already-fetched rows (rather than re-querying, to keep the count and text
 * in agreement), and bounds the rendered text length; contributes nothing for
 * the agent's own entity or when no service/memories exist.
 */
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../../../types/index.ts";
import { addHeader } from "../../../utils.ts";
import {
	formatLongTermMemories,
	type MemoryService,
} from "../services/memory-service.ts";
import { logAdvancedMemoryTrajectory } from "../trajectory.ts";

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

			const memories = await memoryService.getLongTermMemories(entityId);
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

			// Format from the already-fetched memories rather than re-querying
			// (getFormattedLongTermMemories would trigger a second identity-cluster
			// fan-out, with a mismatched limit). This keeps memoryCount and the
			// rendered text in agreement.
			const formattedMemories = formatLongTermMemories(memories);
			const text = addHeader("# What I Know About You", formattedMemories);

			const categoryCounts = new Map<string, number>();
			for (const memory of memories) {
				const count = categoryCounts.get(memory.category) || 0;
				categoryCounts.set(memory.category, count + 1);
			}

			const categoryList = Array.from(categoryCounts.entries())
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
					truncated: false,
				},
				values: {
					longTermMemories: text,
					memoryCategories: categoryList,
				},
				text,
			};
		} catch (error) {
			const err = error instanceof Error ? error.message : String(error);
			// error-policy:J4 long-term memory becomes explicitly unavailable; a
			// failed query is not a legitimate zero-memory result.
			runtime.reportError("LongTermMemoryProvider.get", error, {
				roomId: message.roomId,
			});
			return {
				data: {
					available: false,
					error: err,
				},
				values: { longTermMemoryAvailable: false },
				text: "Long-term memory is unavailable.",
			};
		}
	},
};
