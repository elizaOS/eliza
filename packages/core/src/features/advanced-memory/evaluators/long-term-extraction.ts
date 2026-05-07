import { requireEvaluatorSpec } from "../../../generated/spec-helpers.ts";
import { logger } from "../../../logger.ts";
import {
	type Evaluator,
	type IAgentRuntime,
	type Memory,
	ModelType,
	type TextGenerationModelType,
} from "../../../types/index.ts";
import {
	getErrorMessage,
	isTransientModelError,
} from "../../../utils/model-errors.ts";
import {
	composePromptFromState,
	parseJSONObjectFromText,
} from "../../../utils.ts";
import { toEvaluationExamples } from "../../evaluator-doc-examples.ts";
import { longTermExtractionTemplate } from "../prompts.ts";
import type { MemoryService } from "../services/memory-service.ts";
import { logAdvancedMemoryTrajectory } from "../trajectory.ts";
import { LongTermMemoryCategory, type MemoryExtraction } from "../types.ts";

const spec = requireEvaluatorSpec("LONG_TERM_MEMORY_EXTRACTION");
const validMemoryCategories = new Set(Object.values(LongTermMemoryCategory));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMemoryExtractionResponse(text: string): MemoryExtraction[] {
	const parsed = parseJSONObjectFromText(text) as Record<
		string,
		unknown
	> | null;
	if (parsed) {
		const rawMemories = parsed.memories;
		const candidateEntries = Array.isArray(rawMemories)
			? rawMemories
			: isRecord(rawMemories) && "memory" in rawMemories
				? Array.isArray(rawMemories.memory)
					? rawMemories.memory
					: [rawMemories.memory]
				: [];

		const memories = candidateEntries
			.filter(isRecord)
			.map((entry) => {
				const category =
					typeof entry.category === "string"
						? (entry.category.trim() as LongTermMemoryCategory)
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

		if (memories.length > 0) {
			return memories;
		}
	}

	const memoryMatches = text.matchAll(
		/<memory>[\s\S]*?<category>(.*?)<\/category>[\s\S]*?<content>(.*?)<\/content>[\s\S]*?<confidence>(.*?)<\/confidence>[\s\S]*?<\/memory>/g,
	);

	const extractions: MemoryExtraction[] = [];

	for (const match of memoryMatches) {
		const category = match[1].trim() as LongTermMemoryCategory;
		const content = match[2].trim();
		const confidence = Number.parseFloat(match[3].trim());

		if (!validMemoryCategories.has(category)) {
			logger.warn(
				{ src: "evaluator:memory" },
				`Invalid memory category: ${category}`,
			);
			continue;
		}

		if (content && !Number.isNaN(confidence)) {
			extractions.push({ category, content, confidence });
		}
	}

	return extractions;
}

export const longTermExtractionEvaluator: Evaluator = {
	name: spec.name,
	description: spec.description,
	similes: spec.similes ? [...spec.similes] : [],
	alwaysRun: spec.alwaysRun ?? true,
	examples: toEvaluationExamples(spec.examples),

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<boolean> => {
		if (message.entityId === runtime.agentId) return false;
		if (!message.content?.text) return false;

		const memoryService = runtime.getService("memory") as MemoryService | null;
		if (!memoryService) return false;

		const config = memoryService.getConfig();
		if (!config.longTermExtractionEnabled) {
			logger.debug(
				{ src: "evaluator:memory" },
				"Long-term memory extraction is disabled",
			);
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
	},

	handler: async (runtime: IAgentRuntime, message: Memory) => {
		const memoryService = runtime.getService("memory") as MemoryService;
		if (!memoryService) {
			logger.error({ src: "evaluator:memory" }, "MemoryService not found");
			return undefined;
		}

		const config = memoryService.getConfig();
		const { entityId, roomId } = message;

		try {
			logger.info(
				{ src: "evaluator:memory" },
				`Extracting long-term memories for entity ${entityId}`,
			);

			const recentMessages = await runtime.getMemories({
				tableName: "messages",
				roomId,
				limit: 20,
				unique: false,
			});

			const agentName = runtime.character.name ?? "Agent";
			const formattedMessages = recentMessages
				.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
				.map((msg) => {
					const sender = msg.entityId === runtime.agentId ? agentName : "User";
					return `${sender}: ${msg.content.text || "[non-text message]"}`;
				})
				.join("\n");

			const existingMemories = await memoryService.getLongTermMemories(
				entityId,
				undefined,
				30,
			);
			let formattedExisting = "None yet";
			if (existingMemories.length > 0) {
				const lines: string[] = [];
				for (const memory of existingMemories) {
					lines.push(
						`[${memory.category}] ${memory.content} (confidence: ${memory.confidence})`,
					);
				}
				formattedExisting = lines.join("\n");
			}

			const state = await runtime.composeState(message);
			const prompt = composePromptFromState({
				state: {
					...state,
					recentMessages: formattedMessages,
					existingMemories: formattedExisting,
				},
				template: longTermExtractionTemplate,
			});

			const modelType = (config.summaryModelType ??
				ModelType.TEXT_NANO) as TextGenerationModelType;
			const response = await runtime.useModel(modelType, { prompt });
			const extractions = parseMemoryExtractionResponse(response);

			logger.info(
				{ src: "evaluator:memory" },
				`Extracted ${extractions.length} long-term memories`,
			);

			const minConfidence = Math.max(config.longTermConfidenceThreshold, 0.85);
			const extractedAt = new Date().toISOString();
			let storedCount = 0;
			await Promise.all(
				extractions.map(async (extraction) => {
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
						storedCount += 1;

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
					recentMessageCount: recentMessages.length,
					existingMemoryCount: existingMemories.length,
					extractedMemoryCount: extractions.length,
					storedMemoryCount: storedCount,
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
		} catch (error) {
			const err = getErrorMessage(error);
			if (isTransientModelError(error)) {
				logger.warn(
					{ src: "evaluator:memory", err },
					"Skipped long-term memory extraction due to transient model availability issue",
				);
			} else {
				logger.error(
					{ src: "evaluator:memory", err },
					"Error during long-term memory extraction",
				);
			}
		}
		return undefined;
	},
};
