import { logger } from "../../../../logger.ts";
import type {
	Action,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
} from "../../../../types/components.ts";
import { ActionMode } from "../../../../types/components.ts";
import type { Memory } from "../../../../types/memory.ts";
import { ModelType } from "../../../../types/model.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { State } from "../../../../types/state.ts";
import { asRecord } from "../../../../utils/type-guards.ts";
import { composePrompt } from "../../../../utils.ts";
import { EXTRACT_EXPERIENCES_TEMPLATE } from "../generated/prompts/typescript/prompts.ts";
import type { ExperienceService } from "../service";
import { type Experience, ExperienceType, OutcomeType } from "../types";
import {
	detectExperienceDomain,
	findDuplicateExperienceByLearning,
	sanitizeExperienceText,
} from "../utils/experienceText.ts";

type ExtractedExperience = {
	type?: string;
	learning?: string;
	context?: string;
	confidence?: number;
	reasoning?: string;
};

const EXISTING_EXPERIENCE_LIMIT = 5;
const EXPERIENCE_EXTRACTION_SCHEMA = {
	type: "object",
	properties: {
		experiences: {
			type: "array",
			items: {
				type: "object",
				properties: {
					type: { type: "string" },
					learning: { type: "string" },
					context: { type: "string" },
					confidence: { type: "number" },
					reasoning: { type: "string" },
				},
				required: ["type", "learning", "context", "confidence", "reasoning"],
			},
			maxItems: 3,
		},
	},
	required: ["experiences"],
};
export const experienceEvaluator: Action = {
	name: "EXPERIENCE_EVALUATOR",
	similes: ["experience recorder", "learning evaluator", "self-reflection"],
	description:
		"Periodically analyzes conversation patterns to extract novel learning experiences",
	mode: ActionMode.ALWAYS_AFTER,
	modePriority: 220,
	examples: [],

	async validate(
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<boolean> {
		if (message.entityId !== runtime.agentId) return false;
		const lastExtractionKey = "experience-extraction:last-message-count";
		const currentCount =
			(await runtime.getCache<string>(lastExtractionKey)) || "0";
		const messageCount = Number.parseInt(currentCount, 10);
		const newMessageCount = messageCount + 1;
		await runtime.setCache(lastExtractionKey, newMessageCount.toString());
		return newMessageCount % 25 === 0;
	},

	async handler(
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
		_callback?: HandlerCallback,
		_responses?: Memory[],
	): Promise<ActionResult | undefined> {
		void _options;
		void _callback;
		void _responses;
		void state;

		const experienceService = runtime.getService(
			"EXPERIENCE",
		) as ExperienceService | null;

		if (!experienceService) {
			logger.warn("[experienceEvaluator] Experience service not available");
			return;
		}

		const recentMessages = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			limit: 10,
			unique: false,
		});

		if (recentMessages.length < 3) {
			logger.debug(
				"[experienceEvaluator] Not enough messages for experience extraction",
			);
			return;
		}

		// Combine recent messages into analysis context
		const conversationContext = recentMessages
			.map((m: Memory) => m.content.text)
			.filter(Boolean)
			.join(" ");
		const provenance = buildExperienceProvenance(message, recentMessages);

		const existingExperiences = await experienceService.findSimilarExperiences(
			conversationContext,
			EXISTING_EXPERIENCE_LIMIT,
		);

		const extractionPrompt = composePrompt({
			state: {
				conversation_context: conversationContext,
				existing_experiences: formatExistingExperiences(existingExperiences),
			},
			template: EXTRACT_EXPERIENCES_TEMPLATE,
		});

		// Use OBJECT_SMALL: extraction is structured but not complex reasoning.
		// Saves 5-10x in token cost vs larger models.
		const runModel = runtime.useModel.bind(runtime);
		const response = await runModel(ModelType.OBJECT_SMALL, {
			prompt: extractionPrompt,
			schema: EXPERIENCE_EXTRACTION_SCHEMA,
		});

		const experiences = parseExtractedExperiences(response);

		const threshold = getNumberSetting(runtime, "AUTO_RECORD_THRESHOLD", 0.6);

		// Record each novel experience
		const experienceTypeMap: Record<string, ExperienceType> = {
			DISCOVERY: ExperienceType.DISCOVERY,
			CORRECTION: ExperienceType.CORRECTION,
			SUCCESS: ExperienceType.SUCCESS,
			LEARNING: ExperienceType.LEARNING,
		};

		let recordedCount = 0;
		let skippedDuplicateCount = 0;

		for (const exp of experiences.slice(0, 3)) {
			// Max 3 experiences per extraction
			const rawLearning = exp.learning?.trim();
			if (
				!rawLearning ||
				typeof exp.confidence !== "number" ||
				exp.confidence < threshold
			) {
				continue;
			}

			const sanitizedLearning = sanitizeContext(rawLearning);
			const duplicate = await findDuplicateExperienceByLearning(
				experienceService,
				sanitizedLearning,
			);
			if (duplicate) {
				skippedDuplicateCount++;
				logger.debug(
					`[experienceEvaluator] Skipping duplicate experience: "${sanitizedLearning.substring(0, 80)}..."`,
				);
				continue;
			}

			const normalizedType =
				typeof exp.type === "string" ? exp.type.toUpperCase() : "";
			const experienceType =
				experienceTypeMap[normalizedType] ?? ExperienceType.LEARNING;
			const experienceTag = experienceType;
			const sanitizedContext = sanitizeContext(
				exp.context || "Conversation analysis",
			);
			const sanitizedReason =
				typeof exp.reasoning === "string" && exp.reasoning.trim().length > 0
					? sanitizeContext(exp.reasoning)
					: undefined;

			await experienceService.recordExperience({
				type: experienceType,
				outcome:
					experienceType === ExperienceType.CORRECTION
						? OutcomeType.POSITIVE
						: OutcomeType.NEUTRAL,
				context: sanitizedContext,
				action: "pattern_recognition",
				result: sanitizedLearning,
				learning: sanitizedLearning,
				domain: detectExperienceDomain(sanitizedLearning),
				tags: ["extracted", "novel", experienceTag],
				confidence: Math.min(exp.confidence, 0.9), // Cap confidence
				importance: 0.8, // High importance for extracted experiences
				sourceMessageIds: provenance.sourceMessageIds,
				sourceRoomId: provenance.sourceRoomId,
				sourceTriggerMessageId: provenance.sourceTriggerMessageId,
				sourceTrajectoryId: provenance.sourceTrajectoryId,
				sourceTrajectoryStepId: provenance.sourceTrajectoryStepId,
				associatedEntityIds: provenance.associatedEntityIds,
				extractionMethod: "experience_evaluator",
				extractionReason: sanitizedReason,
			});

			recordedCount++;
			logger.info(
				`[experienceEvaluator] Recorded novel experience: ${sanitizedLearning.substring(0, 100)}...`,
			);
		}

		if (experiences.length > 0) {
			logger.info(
				`[experienceEvaluator] Extracted ${experiences.length} candidate experiences, recorded ${recordedCount}, skipped ${skippedDuplicateCount} duplicates`,
			);
		} else {
			logger.debug(
				"[experienceEvaluator] No novel experiences found in recent conversation",
			);
		}

		return {
			success: true,
			data: {
				extractedCount: experiences.length,
				recordedCount,
				skippedDuplicateCount,
			},
			values: {
				extractedCount: experiences.length.toString(),
				recordedCount: recordedCount.toString(),
				skippedDuplicateCount: skippedDuplicateCount.toString(),
			},
		};
	},
};

function formatExistingExperiences(experiences: Experience[]): string {
	if (experiences.length === 0) {
		return "None";
	}

	return experiences
		.map((experience, index) => {
			const learning = sanitizeExperienceText(experience.learning);
			const context = sanitizeExperienceText(experience.context);
			return `${index + 1}. (${experience.type}/${experience.domain}, confidence ${experience.confidence.toFixed(2)}) When ${context}, learned: ${learning}`;
		})
		.join("\n");
}

function parseExtractedExperiences(response: unknown): ExtractedExperience[] {
	if (response && typeof response === "object" && !Array.isArray(response)) {
		const experiences = (response as { experiences?: unknown }).experiences;
		if (Array.isArray(experiences)) {
			return experiences.filter(
				(item): item is ExtractedExperience =>
					item !== null && typeof item === "object",
			);
		}
	}

	if (typeof response !== "string") return [];

	// JSON fallback for older generated prompts and text-returning providers.
	const objectMatch = response.match(/\{[\s\S]*\}/);
	const arrayMatch = response.match(/\[[\s\S]*\]/);
	const jsonText = objectMatch?.[0] ?? arrayMatch?.[0];
	if (!jsonText) return [];
	try {
		const parsed = JSON.parse(jsonText) as
			| ExtractedExperience[]
			| { experiences?: ExtractedExperience[] };
		const experiences = Array.isArray(parsed) ? parsed : parsed.experiences;
		if (!Array.isArray(experiences)) return [];
		return experiences.filter((item) => item && typeof item === "object");
	} catch {
		return [];
	}
}

function getNumberSetting(
	runtime: IAgentRuntime,
	key: string,
	fallback: number,
): number {
	const value = runtime.getSetting(key);
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : fallback;
	}
	return fallback;
}

function sanitizeContext(text: string): string {
	return sanitizeExperienceText(text);
}

function buildExperienceProvenance(
	triggerMessage: Memory,
	recentMessages: Memory[],
): Pick<
	Experience,
	| "sourceMessageIds"
	| "sourceRoomId"
	| "sourceTriggerMessageId"
	| "sourceTrajectoryId"
	| "sourceTrajectoryStepId"
	| "associatedEntityIds"
> {
	const sourceMessageIds = recentMessages
		.map((recentMessage) => recentMessage.id)
		.filter((id): id is NonNullable<Memory["id"]> => typeof id === "string");
	const associatedEntityIds = Array.from(
		new Set(
			recentMessages
				.map((recentMessage) => recentMessage.entityId)
				.filter(
					(entityId): entityId is NonNullable<Memory["entityId"]> =>
						typeof entityId === "string",
				),
		),
	);

	return {
		sourceMessageIds:
			sourceMessageIds.length > 0 ? sourceMessageIds : undefined,
		sourceRoomId: triggerMessage.roomId,
		sourceTriggerMessageId: triggerMessage.id,
		associatedEntityIds,
		sourceTrajectoryId: readMetadataString(triggerMessage, "trajectoryId"),
		sourceTrajectoryStepId: readMetadataString(
			triggerMessage,
			"trajectoryStepId",
		),
	};
}

function readMetadataString(message: Memory, key: string): string | undefined {
	const metadata = asRecord(message.metadata);
	const value = metadata?.[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}
