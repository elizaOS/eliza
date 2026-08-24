/**
 * The long-term-memory evaluator extracts every high-confidence, durable fact
 * about the user from the complete retained conversation. Conversation
 * summaries are deliberately absent: retained dialogue stays canonical instead
 * of being replaced by a lossy rolling projection.
 */
import { logger } from "../../../logger.ts";
import { EvaluatorPriority } from "../../../services/evaluator-priorities.ts";
import type {
	Evaluator,
	IAgentRuntime,
	JSONSchema,
	Memory,
	RegisteredEvaluator,
} from "../../../types/index.ts";
import { isSyntheticConversationArtifactMemory } from "../../../utils/synthetic-conversation-artifact.ts";
import { isObjectRecord as isRecord } from "../../../utils/type-guards.ts";
import type { MemoryService } from "../services/memory-service.ts";
import { logAdvancedMemoryTrajectory } from "../trajectory.ts";

function createdAtSortKey(memory: Memory): number {
	const value = memory.createdAt;
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function compareMemoryByCreatedAtAsc(a: Memory, b: Memory): number {
	const aSafe = createdAtSortKey(a);
	const bSafe = createdAtSortKey(b);
	if (aSafe !== bSafe) return aSafe - bSafe;
	return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

import { LongTermMemoryCategory, type MemoryExtraction } from "../types.ts";

const MEMORY_CATEGORIES = Object.values(LongTermMemoryCategory);

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

export interface LongTermMemoryOutput {
	memories: MemoryExtraction[];
}

export interface LongTermMemoryPrepared {
	memoryService: MemoryService;
	recentMessages: Memory[];
	existingMemories: string;
	currentMessageCount: number;
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
					: msg.content.senderName || msg.entityId || "User";
			return `${sender}: ${msg.content.text || "[non-text message]"}`;
		})
		.join("\n");
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

async function prepareLongTermMemory(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<LongTermMemoryPrepared> {
	const memoryService = runtime.getService("memory") as MemoryService | null;
	if (!memoryService) throw new Error("MemoryService not found");
	const currentMessageCount = await runtime.countMemories({
		roomIds: [message.roomId],
		unique: false,
		tableName: "messages",
	});
	const [recentRaw, existingLongTerm] = await Promise.all([
		runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			limit: Math.max(1, currentMessageCount),
			unique: false,
		}),
		message.entityId
			? memoryService.getLongTermMemories(message.entityId)
			: Promise.resolve([]),
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
		recentMessages: recentRaw
			.filter((memory) => !isSyntheticConversationArtifactMemory(memory))
			.sort(compareMemoryByCreatedAtAsc),
		existingMemories,
		currentMessageCount,
	};
}

export const __testCompareMemoryByCreatedAtAsc = compareMemoryByCreatedAtAsc;

export const longTermMemoryEvaluator: Evaluator<
	LongTermMemoryOutput,
	LongTermMemoryPrepared
> = {
	name: "longTermMemory",
	description:
		"Extracts high-confidence persistent memories about the user from conversation context.",
	priority: EvaluatorPriority.MEMORY_LONG_TERM,
	schema: longTermMemorySchema,
	async shouldRun({ runtime, message }) {
		if (!message.content.text || !message.roomId || !message.entityId) {
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
		return `Extract every high-confidence persistent user memory. Categories: episodic, semantic, procedural. Keep only specific, concrete, user-unique info likely useful in 3+ months, confidence >=0.85, not already present. Skip one-time tasks, current bugs, exploratory questions, temporary context, pleasantries, generic patterns, and synthetic historical artifacts.

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

export const memoryItems: RegisteredEvaluator[] = [longTermMemoryEvaluator];
