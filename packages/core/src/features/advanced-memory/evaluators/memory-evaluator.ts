import { logger } from "../../../logger.ts";
import {
	type Action,
	ActionMode,
	type ActionResult,
	type IAgentRuntime,
	type Memory,
	ModelType,
	type TextGenerationModelType,
	type UUID,
} from "../../../types/index.ts";
import {
	getErrorMessage,
	isTransientModelError,
} from "../../../utils/model-errors.ts";
import {
	composePromptFromState,
	parseJSONObjectFromText,
} from "../../../utils.ts";
import type { MemoryService } from "../services/memory-service.ts";
import { logAdvancedMemoryTrajectory } from "../trajectory.ts";
import {
	LongTermMemoryCategory,
	type MemoryExtraction,
	type SummaryResult,
} from "../types.ts";

const validMemoryCategories = new Set(Object.values(LongTermMemoryCategory));

const consolidatedMemoryTemplate = `# Task: Roll Forward Conversation Summary AND Extract Long-Term Memory

You are performing two related memory operations in one pass:

1. **Summarization** — produce a rolling, condensed summary of the conversation.
2. **Long-term memory extraction** — extract ONLY high-confidence persistent facts about the user using cognitive science memory categories.

Run both operations on the same conversation context, but apply each operation's criteria independently. If one operation has nothing meaningful to produce, return an empty/empty-array placeholder for that section.

# Existing Summary (may be empty)
{{existingSummary}}

# Existing Topics (may be empty)
{{existingTopics}}

# Existing Long-Term Memories (may be empty)
{{existingMemories}}

# Recent Messages
{{recentMessages}}

# Summarization Instructions

Generate (or update) a summary that:
1. Captures the main topics discussed.
2. Highlights key information shared.
3. Notes any decisions made or questions asked.
4. Maintains context for future reference.
5. Stays under ~2500 tokens total.

Also extract:
- **topics**: list of main topics discussed.
- **keyPoints**: important facts or decisions.

If an existing summary is provided, merge new messages into it and remove redundant detail to stay under the token limit.

# Long-Term Memory Extraction Instructions (Strict)

## Memory Categories

- **EPISODIC** — personal experiences and specific events with temporal/spatial context (WHO did WHAT, WHEN/WHERE).
- **SEMANTIC** — general facts, concepts, established truths about the user (role, expertise, primary tools).
- **PROCEDURAL** — skills, workflows, methodologies, how-to knowledge (HOW the user does something, repeated 3+ times or explicitly stated as standard practice).

## DO Extract

- Significant completed projects or milestones (EPISODIC).
- Major decisions made with lasting impact (EPISODIC).
- Professional identity (role, title, company) and core expertise (SEMANTIC).
- Primary languages, frameworks, or tools (SEMANTIC, only if not exploratory).
- Consistent workflows demonstrated 3+ times or explicitly stated (PROCEDURAL).

## NEVER Extract

- One-time requests or tasks.
- Casual conversations without lasting significance.
- Exploratory questions.
- Temporary context (current bug, today's task).
- Preferences from a single occurrence.
- Social pleasantries.
- Common patterns everyone has.
- Situational information.
- General knowledge not specific to the user.

## Quality Gates (ALL must pass per memory)

1. **Significance** — will this matter in 3+ months?
2. **Specificity** — concrete and actionable.
3. **Uniqueness** — specific to this user.
4. **Confidence** — must be >= 0.85.
5. **Non-Redundancy** — adds new information not in existing memories.

## Confidence Scoring

- **0.95-1.0** — explicitly stated as core identity AND demonstrated multiple times.
- **0.85-0.94** — explicitly stated OR consistently demonstrated 5+ times.
- **0.75-0.84** — strong pattern (3-4 instances) with supporting context. DO NOT extract at this level.
- **< 0.75** — DO NOT extract.

Default to NOT extracting. Maximum 2-3 extractions per run. If nothing qualifies, return an empty array for \`longTermMemories\`.

# Response Format (PURE JSON, no XML)

Respond with a single JSON object with EXACTLY this shape:

{
  "summary": {
    "text": "<rolling summary text, or empty string if nothing new>",
    "topics": ["topic1", "topic2"],
    "keyPoints": ["point1", "point2"]
  },
  "longTermMemories": [
    { "category": "semantic", "content": "User is a senior TypeScript developer with 8 years of backend experience.", "confidence": 0.95 },
    { "category": "procedural", "content": "User follows TDD workflow.", "confidence": 0.88 }
  ]
}

Valid \`category\` values are exactly: "episodic", "semantic", "procedural". Use lowercase.`;

interface ConsolidatedSummaryPayload {
	text: string;
	topics: string[];
	keyPoints: string[];
}

interface ConsolidatedMemoryOutput {
	summary: ConsolidatedSummaryPayload;
	longTermMemories: MemoryExtraction[];
}

const SUMMARY_PLACEHOLDER = "Summary not available";

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

function parseSummarySection(value: unknown): SummaryResult {
	if (!isRecord(value)) {
		return { summary: SUMMARY_PLACEHOLDER, topics: [], keyPoints: [] };
	}

	const summary =
		typeof value.text === "string" && value.text.trim().length > 0
			? value.text.trim()
			: SUMMARY_PLACEHOLDER;
	const topics = toStringArray(value.topics);
	const keyPoints = toStringArray(value.keyPoints);

	return { summary, topics, keyPoints };
}

function parseLongTermMemoriesSection(value: unknown): MemoryExtraction[] {
	const candidateEntries = Array.isArray(value)
		? value
		: isRecord(value) && "memory" in value
			? Array.isArray(value.memory)
				? value.memory
				: [value.memory]
			: [];

	return candidateEntries
		.filter(isRecord)
		.map((entry) => {
			const category =
				typeof entry.category === "string"
					? (entry.category.trim().toLowerCase() as LongTermMemoryCategory)
					: null;
			const content =
				typeof entry.content === "string" ? entry.content.trim() : "";
			const confidenceRaw = entry.confidence;
			const confidence =
				typeof confidenceRaw === "number"
					? confidenceRaw
					: Number.parseFloat(String(confidenceRaw ?? "").trim());

			if (!category || !validMemoryCategories.has(category)) {
				return null;
			}

			if (!content || Number.isNaN(confidence)) {
				return null;
			}

			return { category, content, confidence };
		})
		.filter((entry): entry is MemoryExtraction => entry !== null);
}

function parseConsolidatedResponse(text: string): ConsolidatedMemoryOutput {
	const parsed = parseJSONObjectFromText(text) as Record<
		string,
		unknown
	> | null;

	if (!parsed) {
		return {
			summary: {
				text: SUMMARY_PLACEHOLDER,
				topics: [],
				keyPoints: [],
			},
			longTermMemories: [],
		};
	}

	const summary = parseSummarySection(parsed.summary);
	const longTermMemories = parseLongTermMemoriesSection(
		parsed.longTermMemories,
	);

	return {
		summary: {
			text: summary.summary,
			topics: summary.topics,
			keyPoints: summary.keyPoints,
		},
		longTermMemories,
	};
}

async function evaluateSummarizationTrigger(
	runtime: IAgentRuntime,
	message: Memory,
	memoryService: MemoryService,
): Promise<boolean> {
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
}

async function evaluateLongTermTrigger(
	runtime: IAgentRuntime,
	message: Memory,
	memoryService: MemoryService,
): Promise<boolean> {
	if (message.entityId === runtime.agentId) return false;

	const config = memoryService.getConfig();
	if (!config.longTermExtractionEnabled) {
		return false;
	}

	const currentMessageCount = await runtime.countMemories({
		roomIds: [message.roomId],
		unique: false,
		tableName: "messages",
	});
	return memoryService.shouldRunExtraction(
		message.entityId,
		message.roomId,
		currentMessageCount,
	);
}

export const consolidatedMemoryAction: Action = {
	name: "MEMORY_CONSOLIDATION",
	description:
		"Rolls forward the conversation summary and extracts long-term entity-tagged memory items in a single LLM pass. Feeds contextSummaryProvider and longTermMemoryProvider.",
	similes: [
		"MEMORY_SUMMARIZATION",
		"LONG_TERM_MEMORY_EXTRACTION",
		"CONTEXT_COMPRESSION",
	],
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

		const [shouldSummarize, shouldExtract] = await Promise.all([
			evaluateSummarizationTrigger(runtime, message, memoryService),
			evaluateLongTermTrigger(runtime, message, memoryService),
		]);

		return shouldSummarize || shouldExtract;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<ActionResult | undefined> => {
		const memoryService = runtime.getService("memory") as MemoryService | null;
		if (!memoryService) {
			logger.error({ src: "evaluator:memory" }, "MemoryService not found");
			return undefined;
		}

		const config = memoryService.getConfig();
		const { entityId, roomId } = message;

		const [shouldSummarize, shouldExtractLongTerm] = await Promise.all([
			evaluateSummarizationTrigger(runtime, message, memoryService),
			evaluateLongTermTrigger(runtime, message, memoryService),
		]);

		if (!shouldSummarize && !shouldExtractLongTerm) {
			return undefined;
		}

		try {
			logger.info(
				{ src: "evaluator:memory" },
				`Running consolidated memory pass for room ${roomId} (summarize=${shouldSummarize}, extractLongTerm=${shouldExtractLongTerm})`,
			);

			const allMessages = await runtime.getMemories({
				tableName: "messages",
				roomId,
				limit: 1000,
				unique: false,
			});

			const allDialogueMessages = allMessages
				.filter(isDialogueMessage)
				.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

			const existingSummary =
				await memoryService.getCurrentSessionSummary(roomId);
			const lastOffset = existingSummary?.lastMessageOffset || 0;
			const totalDialogueCount = allDialogueMessages.length;
			const newDialogueCount = totalDialogueCount - lastOffset;
			const maxNewMessages = config.summaryMaxNewMessages || 50;

			const summarizationMessages = (() => {
				if (!shouldSummarize) return [];
				if (newDialogueCount === 0) return [];
				const messagesToProcess = Math.min(newDialogueCount, maxNewMessages);
				if (newDialogueCount > maxNewMessages) {
					logger.warn(
						{ src: "evaluator:memory" },
						`Capping new dialogue messages at ${maxNewMessages} (${newDialogueCount} available)`,
					);
				}
				return allDialogueMessages.slice(
					lastOffset,
					lastOffset + messagesToProcess,
				);
			})();

			const canActuallySummarize =
				shouldSummarize && summarizationMessages.length > 0;

			const formatMessages = (msgs: Memory[]): string =>
				msgs
					.map((msg) => {
						const sender =
							msg.entityId === runtime.agentId
								? (runtime.character.name ?? "Agent")
								: "User";
						return `${sender}: ${msg.content.text || "[non-text message]"}`;
					})
					.join("\n");

			let recentMessagesForPrompt: string;
			if (canActuallySummarize) {
				if (existingSummary) {
					recentMessagesForPrompt = formatMessages(summarizationMessages);
				} else {
					recentMessagesForPrompt = formatMessages(allDialogueMessages);
				}
			} else {
				const recentRaw = await runtime.getMemories({
					tableName: "messages",
					roomId,
					limit: 20,
					unique: false,
				});
				recentMessagesForPrompt = formatMessages(
					recentRaw.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)),
				);
			}

			let formattedExistingMemories = "None yet";
			if (shouldExtractLongTerm) {
				const existingMemories = await memoryService.getLongTermMemories(
					entityId,
					undefined,
					30,
				);
				if (existingMemories.length > 0) {
					formattedExistingMemories = existingMemories
						.map(
							(memory) =>
								`[${memory.category}] ${memory.content} (confidence: ${memory.confidence})`,
						)
						.join("\n");
				}
			}

			const state = await runtime.composeState(message);
			const prompt = composePromptFromState({
				state: {
					...state,
					existingSummary: existingSummary?.summary ?? "None",
					existingTopics: existingSummary?.topics?.join(", ") || "None",
					existingMemories: formattedExistingMemories,
					recentMessages: recentMessagesForPrompt,
				},
				template: consolidatedMemoryTemplate,
			});

			const modelType = (config.summaryModelType ??
				ModelType.TEXT_NANO) as TextGenerationModelType;

			let response: string;
			try {
				response = await runtime.useModel(modelType, {
					prompt,
					maxTokens: config.summaryMaxTokens || 3000,
				});
			} catch (error) {
				const err = getErrorMessage(error);
				if (isTransientModelError(error)) {
					logger.warn(
						{ src: "evaluator:memory", err },
						"Skipped consolidated memory pass due to transient model availability issue",
					);
					return undefined;
				}
				throw error;
			}

			const consolidated = parseConsolidatedResponse(response);

			let summarized = false;
			let summaryMessagesProcessed = 0;
			if (canActuallySummarize) {
				const summaryText = consolidated.summary.text;
				if (
					summaryText &&
					summaryText !== SUMMARY_PLACEHOLDER &&
					summaryText.trim().length > 0
				) {
					const newOffset = lastOffset + summarizationMessages.length;
					const firstMessage = summarizationMessages[0];
					const lastMessage =
						summarizationMessages[summarizationMessages.length - 1];

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
						await memoryService.updateSessionSummary(
							existingSummary.id,
							roomId,
							{
								summary: summaryText,
								messageCount:
									existingSummary.messageCount + summarizationMessages.length,
								lastMessageOffset: newOffset,
								endTime,
								topics: consolidated.summary.topics,
								metadata: { keyPoints: consolidated.summary.keyPoints },
							},
						);
						logger.info(
							{ src: "evaluator:memory" },
							`Updated summary for room ${roomId}: ${summarizationMessages.length} messages processed`,
						);
					} else {
						await memoryService.storeSessionSummary({
							agentId: runtime.agentId,
							roomId,
							entityId:
								message.entityId !== runtime.agentId
									? message.entityId
									: undefined,
							summary: summaryText,
							messageCount: totalDialogueCount,
							lastMessageOffset: totalDialogueCount,
							startTime,
							endTime,
							topics: consolidated.summary.topics,
							metadata: { keyPoints: consolidated.summary.keyPoints },
						});
						logger.info(
							{ src: "evaluator:memory" },
							`Created summary for room ${roomId}: ${totalDialogueCount} messages summarized`,
						);
					}

					summarized = true;
					summaryMessagesProcessed = summarizationMessages.length;

					logAdvancedMemoryTrajectory({
						runtime,
						message,
						providerName: "MEMORY_SUMMARIZATION",
						purpose: "evaluate",
						data: {
							hasExistingSummary: !!existingSummary,
							processedDialogueMessages: summarizationMessages.length,
							totalDialogueMessages: totalDialogueCount,
							topicCount: consolidated.summary.topics.length,
							keyPointCount: consolidated.summary.keyPoints.length,
						},
						query: {
							modelType: String(modelType),
							roomId,
						},
					});
				} else {
					logger.debug(
						{ src: "evaluator:memory" },
						"Summary placeholder returned; skipping store",
					);
				}
			}

			let longTermStored = 0;
			if (shouldExtractLongTerm) {
				const minConfidence = Math.max(
					config.longTermConfidenceThreshold,
					0.85,
				);
				const extractedAt = new Date().toISOString();

				await Promise.all(
					consolidated.longTermMemories.map(async (extraction) => {
						if (extraction.confidence >= minConfidence) {
							await memoryService.storeLongTermMemory({
								agentId: runtime.agentId,
								entityId,
								category: extraction.category,
								content: extraction.content,
								confidence: extraction.confidence,
								source: "conversation",
								metadata: {
									roomId,
									extractedAt,
								},
							});
							longTermStored += 1;

							logger.info(
								{ src: "evaluator:memory" },
								`Stored long-term memory: [${extraction.category}] ${extraction.content.substring(0, 50)}...`,
							);
						} else {
							logger.debug(
								{ src: "evaluator:memory" },
								`Skipped low-confidence memory: ${extraction.content} (confidence: ${extraction.confidence})`,
							);
						}
					}),
				);

				logAdvancedMemoryTrajectory({
					runtime,
					message,
					providerName: "LONG_TERM_MEMORY_EXTRACTION",
					purpose: "evaluate",
					data: {
						extractedMemoryCount: consolidated.longTermMemories.length,
						storedMemoryCount: longTermStored,
					},
					query: {
						modelType: String(modelType),
						entityId,
						roomId,
					},
				});

				const currentMessageCount = await runtime.countMemories({
					roomIds: [roomId],
					unique: false,
					tableName: "messages",
				});
				await memoryService.setLastExtractionCheckpoint(
					entityId,
					roomId,
					currentMessageCount,
				);
				logger.debug(
					{ src: "evaluator:memory" },
					`Updated checkpoint to ${currentMessageCount} for entity ${entityId}`,
				);
			}

			return {
				success: true,
				values: {
					summarized,
					summaryMessagesProcessed,
					longTermStored,
				},
			};
		} catch (error) {
			const err = getErrorMessage(error);
			logger.error(
				{ src: "evaluator:memory", err },
				"Error during consolidated memory pass",
			);
			return undefined;
		}
	},
};
