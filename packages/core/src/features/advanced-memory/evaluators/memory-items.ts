import { logger } from "../../../logger.ts";
import type {
	Evaluator,
	IAgentRuntime,
	JSONSchema,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import type { Plugin } from "../../../types/plugin.ts";
import type { MemoryService } from "../services/memory-service.ts";
import { logAdvancedMemoryTrajectory } from "../trajectory.ts";
import { LongTermMemoryCategory, type MemoryExtraction } from "../types.ts";

const MEMORY_CATEGORIES = Object.values(LongTermMemoryCategory);

const summarySchema: JSONSchema = {
	type: "object",
	properties: {
		text: { type: "string" },
		topics: { type: "array", items: { type: "string" } },
		keyPoints: { type: "array", items: { type: "string" } },
	},
	required: ["text", "topics", "keyPoints"],
	additionalProperties: false,
};

const longTermMemorySchema: JSONSchema = {
	type: "object",
	properties: {
		memories: {
			type: "array",
			items: {
				type: "object",
				properties: {
					category: { type: "string", enum: MEMORY_CATEGORIES },
					content: { type: "string" },
					confidence: { type: "number" },
				},
				required: ["category", "content", "confidence"],
				additionalProperties: false,
			},
		},
	},
	required: ["memories"],
	additionalProperties: false,
};

interface SummaryOutput {
	text: string;
	topics: string[];
	keyPoints: string[];
}

interface LongTermMemoryOutput {
	memories: MemoryExtraction[];
}

interface SummaryPrepared {
	memoryService: MemoryService;
	allDialogueMessages: Memory[];
	summarizationMessages: Memory[];
	existingSummary: Awaited<
		ReturnType<MemoryService["getCurrentSessionSummary"]>
	>;
	lastOffset: number;
	totalDialogueCount: number;
	canSummarize: boolean;
}

interface LongTermMemoryPrepared {
	memoryService: MemoryService;
	recentMessages: Memory[];
	existingMemories: string;
	currentMessageCount: number;
}

const SUMMARY_PLACEHOLDER = "Summary not available";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
		.filter(Boolean);
}

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
	return messages.filter(isDialogueMessage).length;
}

async function shouldSummarize(
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

async function shouldExtractLongTerm(
	runtime: IAgentRuntime,
	message: Memory,
	memoryService: MemoryService,
): Promise<boolean> {
	if (!message.entityId || message.entityId === runtime.agentId) return false;
	const config = memoryService.getConfig();
	if (!config.longTermExtractionEnabled) return false;
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

function formatMessages(runtime: IAgentRuntime, msgs: Memory[]): string {
	return msgs
		.map((msg) => {
			const sender =
				msg.entityId === runtime.agentId
					? (runtime.character.name ?? "Agent")
					: msg.content?.senderName || msg.entityId || "User";
			return `${sender}: ${msg.content.text || "[non-text message]"}`;
		})
		.join("\n");
}

function parseSummaryOutput(output: unknown): SummaryOutput | null {
	if (!isRecord(output)) return null;
	const text = typeof output.text === "string" ? output.text.trim() : "";
	return {
		text: text || SUMMARY_PLACEHOLDER,
		topics: toStringArray(output.topics),
		keyPoints: toStringArray(output.keyPoints),
	};
}

function parseLongTermOutput(output: unknown): LongTermMemoryOutput | null {
	if (!isRecord(output) || !Array.isArray(output.memories)) return null;
	const memories: MemoryExtraction[] = [];
	for (const entry of output.memories) {
		if (!isRecord(entry)) continue;
		const category =
			typeof entry.category === "string"
				? (entry.category.trim().toLowerCase() as LongTermMemoryCategory)
				: null;
		if (!category || !MEMORY_CATEGORIES.some((item) => item === category)) {
			continue;
		}
		const content =
			typeof entry.content === "string" ? entry.content.trim() : "";
		const confidence =
			typeof entry.confidence === "number" ? entry.confidence : Number.NaN;
		if (!content || Number.isNaN(confidence)) continue;
		memories.push({ category, content, confidence });
	}
	return { memories };
}

async function prepareSummary(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<SummaryPrepared> {
	const memoryService = runtime.getService("memory") as MemoryService | null;
	if (!memoryService) throw new Error("MemoryService not found");
	const config = memoryService.getConfig();
	const allMessages = await runtime.getMemories({
		tableName: "messages",
		roomId: message.roomId,
		limit: 1000,
		unique: false,
	});
	const allDialogueMessages = allMessages
		.filter(isDialogueMessage)
		.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
	const existingSummary = await memoryService.getCurrentSessionSummary(
		message.roomId,
	);
	const lastOffset = existingSummary?.lastMessageOffset || 0;
	const totalDialogueCount = allDialogueMessages.length;
	const newDialogueCount = totalDialogueCount - lastOffset;
	const maxNewMessages = config.summaryMaxNewMessages || 50;
	const messagesToProcess = Math.min(newDialogueCount, maxNewMessages);
	const summarizationMessages =
		newDialogueCount > 0
			? allDialogueMessages.slice(lastOffset, lastOffset + messagesToProcess)
			: [];
	return {
		memoryService,
		allDialogueMessages,
		summarizationMessages,
		existingSummary,
		lastOffset,
		totalDialogueCount,
		canSummarize: summarizationMessages.length > 0,
	};
}

async function prepareLongTermMemory(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<LongTermMemoryPrepared> {
	const memoryService = runtime.getService("memory") as MemoryService | null;
	if (!memoryService) throw new Error("MemoryService not found");
	const [recentRaw, existingLongTerm, currentMessageCount] = await Promise.all([
		runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			limit: 20,
			unique: false,
		}),
		message.entityId
			? memoryService.getLongTermMemories(message.entityId, undefined, 30)
			: Promise.resolve([]),
		runtime.countMemories({
			roomIds: [message.roomId],
			unique: false,
			tableName: "messages",
		}),
	]);
	const existingMemories =
		existingLongTerm.length > 0
			? existingLongTerm
					.map(
						(memory) =>
							`[${memory.category}] ${memory.content} (confidence: ${memory.confidence})`,
					)
					.join("\n")
			: "None yet";
	return {
		memoryService,
		recentMessages: recentRaw.sort(
			(a, b) => (a.createdAt || 0) - (b.createdAt || 0),
		),
		existingMemories,
		currentMessageCount,
	};
}

export const summaryEvaluator: Evaluator<SummaryOutput, SummaryPrepared> = {
	name: "summary",
	description: "Rolls forward the room's compact conversation summary.",
	priority: 300,
	schema: summarySchema,
	async shouldRun({ runtime, message }) {
		if (!message.content?.text || !message.roomId) return false;
		const memoryService = runtime.getService("memory") as MemoryService | null;
		if (!memoryService) return false;
		return shouldSummarize(runtime, message, memoryService);
	},
	async prepare({ runtime, message }) {
		return prepareSummary(runtime, message);
	},
	prompt({ runtime, prepared }) {
		const recentMessages = prepared.existingSummary
			? prepared.summarizationMessages
			: prepared.allDialogueMessages;
		return `Update the rolling conversation summary.

Existing summary:
${prepared.existingSummary?.summary ?? "None"}

Existing topics:
${prepared.existingSummary?.topics?.join(", ") || "None"}

Recent messages to merge:
${formatMessages(runtime, recentMessages)}

Rules:
- Capture main topics, key information, decisions, and questions.
- Merge new messages into the existing summary when present.
- Keep the text concise enough to remain useful as future context.
- If there is nothing useful, return text as an empty string with empty arrays.`;
	},
	parse: parseSummaryOutput,
	processors: [
		{
			name: "storeSummary",
			async process({ runtime, message, prepared, output }) {
				if (!prepared.canSummarize) return undefined;
				const summaryText = output.text;
				if (
					!summaryText ||
					summaryText === SUMMARY_PLACEHOLDER ||
					summaryText.trim().length === 0
				) {
					return undefined;
				}
				const firstMessage = prepared.summarizationMessages[0];
				const lastMessage =
					prepared.summarizationMessages[
						prepared.summarizationMessages.length - 1
					];
				const startTime = prepared.existingSummary
					? prepared.existingSummary.startTime
					: firstMessage?.createdAt && firstMessage.createdAt > 0
						? new Date(firstMessage.createdAt)
						: new Date();
				const endTime =
					lastMessage?.createdAt && lastMessage.createdAt > 0
						? new Date(lastMessage.createdAt)
						: new Date();
				const newOffset =
					prepared.lastOffset + prepared.summarizationMessages.length;

				if (prepared.existingSummary) {
					await prepared.memoryService.updateSessionSummary(
						prepared.existingSummary.id,
						message.roomId,
						{
							summary: summaryText,
							messageCount:
								prepared.existingSummary.messageCount +
								prepared.summarizationMessages.length,
							lastMessageOffset: newOffset,
							endTime,
							topics: output.topics,
							metadata: { keyPoints: output.keyPoints },
						},
					);
				} else {
					await prepared.memoryService.storeSessionSummary({
						agentId: runtime.agentId,
						roomId: message.roomId,
						entityId:
							message.entityId !== runtime.agentId
								? message.entityId
								: undefined,
						summary: summaryText,
						messageCount: prepared.totalDialogueCount,
						lastMessageOffset: prepared.totalDialogueCount,
						startTime,
						endTime,
						topics: output.topics,
						metadata: { keyPoints: output.keyPoints },
					});
				}

				logAdvancedMemoryTrajectory({
					runtime,
					message,
					providerName: "MEMORY_SUMMARIZATION",
					purpose: "evaluate",
					data: {
						hasExistingSummary: !!prepared.existingSummary,
						processedDialogueMessages: prepared.summarizationMessages.length,
						totalDialogueMessages: prepared.totalDialogueCount,
						topicCount: output.topics.length,
						keyPointCount: output.keyPoints.length,
					},
					query: { roomId: message.roomId },
				});

				return {
					success: true,
					values: {
						summarized: true,
						summaryMessagesProcessed: prepared.summarizationMessages.length,
					},
				};
			},
		},
	],
};

export const longTermMemoryEvaluator: Evaluator<
	LongTermMemoryOutput,
	LongTermMemoryPrepared
> = {
	name: "longTermMemory",
	description:
		"Extracts high-confidence persistent memories about the user from conversation context.",
	priority: 310,
	schema: longTermMemorySchema,
	async shouldRun({ runtime, message }) {
		if (!message.content?.text || !message.roomId || !message.entityId) {
			return false;
		}
		const memoryService = runtime.getService("memory") as MemoryService | null;
		if (!memoryService) return false;
		return shouldExtractLongTerm(runtime, message, memoryService);
	},
	async prepare({ runtime, message }) {
		return prepareLongTermMemory(runtime, message);
	},
	prompt({ runtime, prepared }) {
		return `Extract only high-confidence persistent memories about the user.

Memory categories:
- episodic: personal experiences and specific events with temporal or spatial context.
- semantic: stable facts, roles, expertise, primary tools, or identity.
- procedural: repeatable workflows, methods, or skills the user uses.

Quality gates:
- Will matter in three or more months.
- Specific, concrete, and unique to this user.
- Confidence must be at least 0.85.
- Adds new information not already present.
- Maximum three memories.

Do not extract one-time tasks, current bugs, exploratory questions, temporary context, pleasantries, or generic patterns.

Existing long-term memories:
${prepared.existingMemories}

Recent messages:
${formatMessages(runtime, prepared.recentMessages)}`;
	},
	parse: parseLongTermOutput,
	processors: [
		{
			name: "storeLongTermMemory",
			async process({ runtime, message, prepared, output }) {
				const config = prepared.memoryService.getConfig();
				const minConfidence = Math.max(
					config.longTermConfidenceThreshold,
					0.85,
				);
				const extractedAt = new Date().toISOString();
				let longTermStored = 0;
				for (const extraction of output.memories) {
					if (extraction.confidence < minConfidence) continue;
					await prepared.memoryService.storeLongTermMemory({
						agentId: runtime.agentId,
						entityId: message.entityId,
						category: extraction.category,
						content: extraction.content,
						confidence: extraction.confidence,
						source: "conversation",
						metadata: {
							roomId: message.roomId,
							extractedAt,
						},
					});
					longTermStored += 1;
				}
				await prepared.memoryService.setLastExtractionCheckpoint(
					message.entityId,
					message.roomId,
					prepared.currentMessageCount,
				);
				logAdvancedMemoryTrajectory({
					runtime,
					message,
					providerName: "LONG_TERM_MEMORY_EXTRACTION",
					purpose: "evaluate",
					data: {
						extractedMemoryCount: output.memories.length,
						storedMemoryCount: longTermStored,
					},
					query: {
						entityId: message.entityId,
						roomId: message.roomId,
					},
				});
				logger.debug(
					{ src: "evaluator:memory", longTermStored },
					"Stored long-term memories from evaluator service",
				);
				return {
					success: true,
					values: { longTermStored },
				};
			},
		},
	],
};

export const memoryItems: NonNullable<Plugin["evaluators"]> = [
	summaryEvaluator,
	longTermMemoryEvaluator,
];
