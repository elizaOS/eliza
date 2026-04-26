import { logger } from "../../../../logger.ts";
import type {
	ActionResult,
	Evaluator,
	HandlerCallback,
	HandlerOptions,
} from "../../../../types/components.ts";
import type { Memory } from "../../../../types/memory.ts";
import { ModelType } from "../../../../types/model.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { State } from "../../../../types/state.ts";
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
const PASSIVE_ACTIONS = new Set([
	"REPLY",
	"NONE",
	"NOACTION",
	"IGNORE",
	"WAIT",
]);

export const experienceEvaluator: Evaluator = {
	name: "EXPERIENCE_EVALUATOR",
	similes: ["experience recorder", "learning evaluator", "self-reflection"],
	description:
		"Periodically analyzes conversation patterns to extract novel learning experiences",
	alwaysRun: false,

	examples: [
		{
			prompt:
				"The agent successfully executed a shell command after initially failing",
			messages: [
				{
					name: "Autoliza",
					content: {
						text: "Let me try to run this Python script.",
					},
				},
				{
					name: "Autoliza",
					content: {
						text: "Error: ModuleNotFoundError for pandas. I need to install it first.",
					},
				},
				{
					name: "Autoliza",
					content: {
						text: "After installing pandas, the script ran successfully and produced the expected output.",
					},
				},
			],
			outcome:
				"Record a CORRECTION experience about needing to install dependencies before running Python scripts",
		},
		{
			prompt: "The agent discovered a new system capability",
			messages: [
				{
					name: "Autoliza",
					content: {
						text: "I found that the system has jq installed, which is perfect for parsing JSON data.",
					},
				},
			],
			outcome:
				"Record a DISCOVERY experience about the availability of jq for JSON processing",
		},
	],

	async validate(
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<boolean> {
		// Only run every 10 messages and only on agent messages
		if (message.entityId !== runtime.agentId) {
			return false;
		}

		const content = asRecord(message.content);
		if (content && isSimpleReplyOnlyMessage(content)) {
			return false;
		}

		if (content && hasNonPassiveAction(content)) {
			logger.info(
				"[experienceEvaluator] Triggering experience extraction after actionful agent turn",
			);
			return true;
		}

		// Check cooldown - only extract experiences every 25 messages to reduce token cost
		const lastExtractionKey = "experience-extraction:last-message-count";
		const currentCount =
			(await runtime.getCache<string>(lastExtractionKey)) || "0";
		const messageCount = Number.parseInt(currentCount, 10);
		const newMessageCount = messageCount + 1;

		await runtime.setCache(lastExtractionKey, newMessageCount.toString());

		// Trigger extraction every 25 messages (was 10 — reduced to cut LLM costs by ~60%)
		const shouldExtract = newMessageCount % 25 === 0;

		if (shouldExtract) {
			logger.info(
				`[experienceEvaluator] Triggering experience extraction after ${newMessageCount} messages`,
			);
		}

		return shouldExtract;
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

		// Use TEXT_SMALL — extraction is a structured JSON task, not complex reasoning.
		// Saves 5-10x in token cost vs TEXT_LARGE.
		const runModel = runtime.useModel.bind(runtime);
		const response = await runModel(ModelType.TEXT_SMALL, {
			prompt: extractionPrompt,
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

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}

function readStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((item): item is string => typeof item === "string");
}

function normalizeActionName(name: string): string {
	return name
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");
}

function hasNonPassiveAction(content: Record<string, unknown>): boolean {
	const actions = readStringArray(content.actions).map(normalizeActionName);
	return actions.some((action) => action && !PASSIVE_ACTIONS.has(action));
}

function isSimpleReplyOnlyMessage(content: Record<string, unknown>): boolean {
	const conversationMode =
		typeof content.conversationMode === "string"
			? content.conversationMode.trim().toLowerCase()
			: "";
	if (conversationMode !== "simple") {
		return false;
	}

	const actions = readStringArray(content.actions).map(normalizeActionName);
	return (
		actions.length === 0 ||
		actions.every((action) => !action || PASSIVE_ACTIONS.has(action))
	);
}

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

function parseExtractedExperiences(response: string): ExtractedExperience[] {
	const jsonMatch = response.match(/\[[\s\S]*\]/);
	if (!jsonMatch) return [];

	try {
		const parsed = JSON.parse(jsonMatch[0]) as ExtractedExperience[];
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item) => item && typeof item === "object");
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
> {
	const sourceMessageIds = recentMessages
		.map((recentMessage) => recentMessage.id)
		.filter((id): id is NonNullable<Memory["id"]> => typeof id === "string");

	return {
		sourceMessageIds: sourceMessageIds.length > 0 ? sourceMessageIds : undefined,
		sourceRoomId: triggerMessage.roomId,
		sourceTriggerMessageId: triggerMessage.id,
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
