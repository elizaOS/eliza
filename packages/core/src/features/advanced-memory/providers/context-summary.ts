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

const MAX_SUMMARY_TEXT_LENGTH = 3000;
const MAX_SUMMARY_TOPICS = 12;

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

			const trimmedSummary =
				currentSummary.summary.length > MAX_SUMMARY_TEXT_LENGTH
					? `${currentSummary.summary.slice(0, MAX_SUMMARY_TEXT_LENGTH)}...`
					: currentSummary.summary;
			const limitedTopics =
				currentSummary.topics?.slice(0, MAX_SUMMARY_TOPICS) ?? [];

			let summaryOnly = `**Previous Conversation** (${messageRange}, ${timeRange})\n`;
			summaryOnly += trimmedSummary;

			let summaryWithTopics = summaryOnly;
			if (limitedTopics.length > 0) {
				summaryWithTopics += `\n*Topics: ${limitedTopics.join(", ")}*`;
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
					roomId,
				},
			});

			return {
				data: {
					summaryText: trimmedSummary,
					messageCount: currentSummary.messageCount,
					topics: limitedTopics.join(", "),
					truncated: currentSummary.summary.length > MAX_SUMMARY_TEXT_LENGTH,
				},
				values: { sessionSummaries, sessionSummariesWithTopics },
				text: sessionSummariesWithTopics,
			};
		} catch (error) {
			const err = error instanceof Error ? error.message : String(error);
			logger.error(
				{ src: "provider:memory", err },
				"Error in contextSummaryProvider",
			);
			return {
				data: {
					error: err,
				},
				values: { sessionSummaries: "", sessionSummariesWithTopics: "" },
				text: "",
			};
		}
	},
};
