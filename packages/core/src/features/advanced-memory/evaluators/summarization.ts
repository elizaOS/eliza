import { requireEvaluatorSpec } from "../../../generated/spec-helpers.ts";
import { logger } from "../../../logger.ts";
import {
	type Action,
	ActionMode,
	type IAgentRuntime,
	type Memory,
	ModelType,
	type TextGenerationModelType,
	type UUID,
} from "../../../types/index.ts";
import {
	composePromptFromState,
	parseJSONObjectFromText,
} from "../../../utils.ts";
import {
	initialSummarizationTemplate,
	updateSummarizationTemplate,
} from "../prompts.ts";
import type { MemoryService } from "../services/memory-service.ts";
import { logAdvancedMemoryTrajectory } from "../trajectory.ts";
import type { SummaryResult } from "../types.ts";

// Get text content from centralized specs
const spec = requireEvaluatorSpec("MEMORY_SUMMARIZATION");

function isDialogueMessage(msg: Memory): boolean {
	return (
		!(
			(msg.content?.type as string) === "action_result" &&
			(msg.metadata?.type as string) === "action_result"
		) &&
		((msg.metadata?.type as string) === "agent_response_message" ||
			(msg.metadata?.type as string) === "user_message")
	);
}

async function getDialogueMessageCount(
	runtime: IAgentRuntime,
	roomId: UUID,
): Promise<number> {
	const messages = await runtime.getMemories({
		tableName: "messages",
		roomId,
		limit: 100,
		unique: false,
	});

	let count = 0;
	for (const msg of messages) {
		if (isDialogueMessage(msg)) {
			count += 1;
		}
	}
	return count;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
			.filter(Boolean);
	}

	if (typeof value === "string") {
		return value
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean);
	}

	if (isRecord(value) && "point" in value) {
		return toStringArray(value.point);
	}

	return [];
}

function parseSummaryResponse(text: string): SummaryResult {
	const parsed = parseJSONObjectFromText(text) as Record<
		string,
		unknown
	> | null;
	if (parsed) {
		const summary =
			typeof parsed.text === "string" && parsed.text.trim().length > 0
				? parsed.text.trim()
				: "Summary not available";
		const topics = toStringArray(parsed.topics);
		const keyPoints = toStringArray(parsed.keyPoints);

		if (
			summary !== "Summary not available" ||
			topics.length > 0 ||
			keyPoints.length > 0
		) {
			return { summary, topics, keyPoints };
		}
	}

	return {
		summary: "Summary not available",
		topics: [],
		keyPoints: [],
	};
}

export const summarizationAction: Action = {
	name: spec.name,
	description: spec.description,
	similes: spec.similes ? [...spec.similes] : [],
	mode: ActionMode.ALWAYS_AFTER,
	modePriority: 400,
	examples: [],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<boolean> => {
		if (!message.content?.text) return false;

		const memoryService = runtime.getService("memory") as MemoryService | null;
		if (!memoryService) return false;

		const config = memoryService.getConfig();
		const currentDialogueCount = await getDialogueMessageCount(
			runtime,
			message.roomId,
		);
		const existingSummary = await memoryService.getCurrentSessionSummary(
			message.roomId,
		);

		if (!existingSummary) {
			return currentDialogueCount >= config.shortTermSummarizationThreshold;
		}
		const newDialogueCount =
			currentDialogueCount - existingSummary.lastMessageOffset;
		return newDialogueCount >= config.shortTermSummarizationInterval;
	},

	handler: async (runtime: IAgentRuntime, message: Memory) => {
		const memoryService = runtime.getService("memory") as MemoryService;
		if (!memoryService) {
			logger.error({ src: "evaluator:memory" }, "MemoryService not found");
			return undefined;
		}

		const config = memoryService.getConfig();
		const { roomId } = message;

		try {
			logger.info(
				{ src: "evaluator:memory" },
				`Starting summarization for room ${roomId}`,
			);

			const existingSummary =
				await memoryService.getCurrentSessionSummary(roomId);
			const lastOffset = existingSummary?.lastMessageOffset || 0;

			const allMessages = await runtime.getMemories({
				tableName: "messages",
				roomId,
				limit: 1000,
				unique: false,
			});

			const allDialogueMessages = allMessages.filter(isDialogueMessage);

			const totalDialogueCount = allDialogueMessages.length;
			const newDialogueCount = totalDialogueCount - lastOffset;

			if (newDialogueCount === 0) {
				logger.debug(
					{ src: "evaluator:memory" },
					"No new dialogue messages to summarize",
				);
				return undefined;
			}

			const maxNewMessages = config.summaryMaxNewMessages || 50;
			const messagesToProcess = Math.min(newDialogueCount, maxNewMessages);

			if (newDialogueCount > maxNewMessages) {
				logger.warn(
					{ src: "evaluator:memory" },
					`Capping new dialogue messages at ${maxNewMessages} (${newDialogueCount} available)`,
				);
			}

			const sortedDialogueMessages = allDialogueMessages.sort(
				(a, b) => (a.createdAt || 0) - (b.createdAt || 0),
			);

			const newDialogueMessages = sortedDialogueMessages.slice(
				lastOffset,
				lastOffset + messagesToProcess,
			);
			if (newDialogueMessages.length === 0) {
				logger.debug(
					{ src: "evaluator:memory" },
					"No new dialogue messages retrieved after filtering",
				);
				return undefined;
			}

			const formattedMessages = newDialogueMessages
				.map((msg) => {
					const sender =
						msg.entityId === runtime.agentId ? runtime.character.name : "User";
					return `${sender}: ${msg.content.text || "[non-text message]"}`;
				})
				.join("\n");

			const state = await runtime.composeState(message);
			let prompt: string;
			let template: string;

			if (existingSummary) {
				template = updateSummarizationTemplate;
				prompt = composePromptFromState({
					state: {
						...state,
						existingSummary: existingSummary.summary,
						existingTopics: existingSummary.topics?.join(", ") || "None",
						newMessages: formattedMessages,
					},
					template,
				});
			} else {
				const initialMessages = sortedDialogueMessages
					.map((msg) => {
						const sender =
							msg.entityId === runtime.agentId
								? runtime.character.name
								: "User";
						return `${sender}: ${msg.content.text || "[non-text message]"}`;
					})
					.join("\n");

				template = initialSummarizationTemplate;
				prompt = composePromptFromState({
					state: { ...state, recentMessages: initialMessages },
					template,
				});
			}

			const modelType = (config.summaryModelType ??
				ModelType.TEXT_NANO) as TextGenerationModelType;
			const response = await runtime.useModel(modelType, {
				prompt,
				maxTokens: config.summaryMaxTokens || 2500,
			});

			const summaryResult = parseSummaryResponse(response);
			logAdvancedMemoryTrajectory({
				runtime,
				message,
				providerName: "MEMORY_SUMMARIZATION",
				purpose: "evaluate",
				data: {
					hasExistingSummary: !!existingSummary,
					processedDialogueMessages: newDialogueMessages.length,
					totalDialogueMessages: totalDialogueCount,
					topicCount: summaryResult.topics.length,
					keyPointCount: summaryResult.keyPoints.length,
				},
				query: {
					modelType: String(modelType),
					roomId,
				},
			});

			logger.info(
				{ src: "evaluator:memory" },
				`${existingSummary ? "Updated" : "Generated"} summary: ${summaryResult.summary.substring(0, 100)}...`,
			);

			const newOffset = lastOffset + newDialogueMessages.length;
			const firstMessage = newDialogueMessages[0];
			const lastMessage = newDialogueMessages[newDialogueMessages.length - 1];

			const startTime = existingSummary
				? existingSummary.startTime
				: firstMessage?.createdAt && firstMessage.createdAt > 0
					? new Date(firstMessage.createdAt)
					: new Date();
			const endTime =
				lastMessage?.createdAt && lastMessage.createdAt > 0
					? new Date(lastMessage.createdAt)
					: new Date();

			if (existingSummary) {
				await memoryService.updateSessionSummary(existingSummary.id, roomId, {
					summary: summaryResult.summary,
					messageCount:
						existingSummary.messageCount + newDialogueMessages.length,
					lastMessageOffset: newOffset,
					endTime,
					topics: summaryResult.topics,
					metadata: { keyPoints: summaryResult.keyPoints },
				});

				logger.info(
					{ src: "evaluator:memory" },
					`Updated summary for room ${roomId}: ${newDialogueMessages.length} messages processed`,
				);
			} else {
				await memoryService.storeSessionSummary({
					agentId: runtime.agentId,
					roomId,
					entityId:
						message.entityId !== runtime.agentId ? message.entityId : undefined,
					summary: summaryResult.summary,
					messageCount: totalDialogueCount,
					lastMessageOffset: totalDialogueCount,
					startTime,
					endTime,
					topics: summaryResult.topics,
					metadata: { keyPoints: summaryResult.keyPoints },
				});

				logger.info(
					{ src: "evaluator:memory" },
					`Created summary for room ${roomId}: ${totalDialogueCount} messages summarized`,
				);
			}
		} catch (error) {
			const err = error instanceof Error ? error.message : String(error);
			logger.error(
				{ src: "evaluator:memory", err },
				"Error during summarization",
			);
		}
		return undefined;
	},
};
