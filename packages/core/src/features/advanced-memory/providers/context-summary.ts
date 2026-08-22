/**
 * The `SUMMARIZED_CONTEXT` provider of the advanced-memory capability: injects
 * the room's current rolling session summary (text, message range, date, and
 * topics) into prompt context. Reads the complete summary from `MemoryService`
 * via `runtime.getService("memory")`; contributes nothing when no service or
 * summary exists.
 */
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

export const contextSummaryProvider: Provider = {
	name: "SUMMARIZED_CONTEXT",
	description: "Provides summarized context from previous conversations",
	position: 96,
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
			const { roomId } = message;

			if (!memoryService) {
				return {
					data: {},
					values: { sessionSummaries: "", sessionSummariesWithTopics: "" },
					text: "",
				};
			}

			const currentSummary =
				await memoryService.getCurrentSessionSummary(roomId);
			if (!currentSummary) {
				logAdvancedMemoryTrajectory({
					runtime,
					message,
					providerName: "SUMMARIZED_CONTEXT",
					purpose: "session_summary",
					data: {
						summaryPresent: false,
						messageCount: 0,
						topicCount: 0,
					},
					query: {
						roomId,
					},
				});
				return {
					data: {},
					values: { sessionSummaries: "", sessionSummariesWithTopics: "" },
					text: "",
				};
			}

			const messageRange = `${currentSummary.messageCount} messages`;
			const timeRange = new Date(currentSummary.startTime).toLocaleDateString();

			const summary = currentSummary.summary;
			const topics = currentSummary.topics ?? [];

			let summaryOnly = `**Previous Conversation** (${messageRange}, ${timeRange})\n`;
			summaryOnly += summary;

			let summaryWithTopics = summaryOnly;
			if (topics.length > 0) {
				summaryWithTopics += `\n*Topics: ${topics.join(", ")}*`;
			}

			const sessionSummaries = addHeader("# Conversation Summary", summaryOnly);
			const sessionSummariesWithTopics = addHeader(
				"# Conversation Summary",
				summaryWithTopics,
			);
			logAdvancedMemoryTrajectory({
				runtime,
				message,
				providerName: "SUMMARIZED_CONTEXT",
				purpose: "session_summary",
				data: {
					summaryPresent: true,
					messageCount: currentSummary.messageCount,
					topicCount: currentSummary.topics?.length ?? 0,
				},
				query: {
					roomId: message.roomId,
				},
			});

			return {
				data: {
					summaryText: summary,
					messageCount: currentSummary.messageCount,
					topics: topics.join(", "),
				},
				values: { sessionSummaries, sessionSummariesWithTopics },
				text: sessionSummariesWithTopics,
			};
		} catch (error) {
			const err = error instanceof Error ? error.message : String(error);
			// error-policy:J4 session summaries become explicitly unavailable; a
			// failed memory read is not an empty session history.
			runtime.reportError("ContextSummaryProvider.get", error, {
				roomId: message.roomId,
			});
			return {
				data: {
					available: false,
					error: err,
				},
				values: { sessionSummariesAvailable: false },
				text: "Session summaries are unavailable.",
			};
		}
	},
};
