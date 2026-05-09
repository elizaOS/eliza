import { logger } from "../../../../logger.ts";
import { EvaluatorPriority } from "../../../../services/evaluator-priorities.ts";
import type {
	Evaluator,
	IAgentRuntime,
	JSONSchema,
	Memory,
	UUID,
} from "../../../../types/index.ts";
import type { ExperienceService } from "../service.ts";
import { type Experience, ExperienceType, OutcomeType } from "../types.ts";

const EXPERIENCE_EXTRACTION_INTERVAL = 25;
const EXISTING_EXPERIENCE_LIMIT = 5;
const DEFAULT_AUTO_RECORD_THRESHOLD = 0.6;

const experienceSchema: JSONSchema = {
	type: "object",
	properties: {
		experiences: {
			type: "array",
			maxItems: 3,
			items: {
				type: "object",
				properties: {
					type: {
						type: "string",
						enum: [
							"success",
							"failure",
							"discovery",
							"correction",
							"learning",
							"hypothesis",
							"validation",
							"warning",
						],
					},
					outcome: {
						type: "string",
						enum: ["positive", "negative", "neutral", "mixed"],
					},
					domain: { type: "string" },
					learning: { type: "string" },
					context: { type: "string" },
					confidence: { type: "number" },
					importance: { type: "number" },
					reasoning: { type: "string" },
				},
				required: [
					"type",
					"outcome",
					"domain",
					"learning",
					"context",
					"confidence",
					"importance",
					"reasoning",
				],
				additionalProperties: false,
			},
		},
	},
	required: ["experiences"],
	additionalProperties: false,
};

interface ExtractedExperience {
	type: ExperienceType;
	outcome: OutcomeType;
	domain: string;
	learning: string;
	context: string;
	confidence: number;
	importance: number;
	reasoning: string;
}

interface ExperienceOutput {
	experiences: ExtractedExperience[];
}

interface ExperiencePrepared {
	experienceService: ExperienceService;
	recentMessages: Memory[];
	conversationContext: string;
	existingExperiences: Experience[];
	provenance: Pick<
		Experience,
		| "sourceMessageIds"
		| "sourceRoomId"
		| "sourceTriggerMessageId"
		| "sourceTrajectoryId"
		| "sourceTrajectoryStepId"
		| "associatedEntityIds"
	>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function parseExperienceType(value: unknown): ExperienceType | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	for (const candidate of Object.values(ExperienceType)) {
		if (normalized === candidate) return candidate;
	}
	return null;
}

function parseOutcomeType(value: unknown): OutcomeType | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	for (const candidate of Object.values(OutcomeType)) {
		if (normalized === candidate) return candidate;
	}
	return null;
}

function parseExperienceOutput(output: unknown): ExperienceOutput | null {
	if (!isRecord(output) || !Array.isArray(output.experiences)) return null;
	const experiences: ExtractedExperience[] = [];
	for (const entry of output.experiences.slice(0, 3)) {
		if (!isRecord(entry)) continue;
		const type = parseExperienceType(entry.type);
		const outcome = parseOutcomeType(entry.outcome);
		const domain = typeof entry.domain === "string" ? entry.domain.trim() : "";
		const learning =
			typeof entry.learning === "string" ? entry.learning.trim() : "";
		const context =
			typeof entry.context === "string" ? entry.context.trim() : "";
		const confidence =
			typeof entry.confidence === "number" ? entry.confidence : Number.NaN;
		const importance =
			typeof entry.importance === "number" ? entry.importance : 0.8;
		const reasoning =
			typeof entry.reasoning === "string" ? entry.reasoning.trim() : "";
		if (!type || !outcome || !domain || !learning || !context) continue;
		if (Number.isNaN(confidence)) continue;
		experiences.push({
			type,
			outcome,
			domain,
			learning,
			context,
			confidence,
			importance,
			reasoning,
		});
	}
	return { experiences };
}

function formatExistingExperiences(experiences: Experience[]): string {
	if (experiences.length === 0) return "None";
	return experiences
		.map(
			(experience, index) =>
				`${index + 1}. (${experience.type}/${experience.domain}, confidence ${experience.confidence}) When ${experience.context}, learned: ${experience.learning}`,
		)
		.join("\n");
}

function buildExperienceProvenance(
	triggerMessage: Memory,
	recentMessages: Memory[],
): ExperiencePrepared["provenance"] {
	const sourceMessageIds = recentMessages
		.map((memory) => memory.id)
		.filter((id): id is UUID => typeof id === "string" && id.length > 0);
	const associatedEntityIds = Array.from(
		new Set(
			recentMessages
				.map((memory) => memory.entityId)
				.filter(
					(entityId): entityId is UUID =>
						typeof entityId === "string" && entityId.length > 0,
				),
		),
	);
	const metadata = isRecord(triggerMessage.metadata)
		? triggerMessage.metadata
		: {};
	return {
		sourceMessageIds,
		sourceRoomId: triggerMessage.roomId,
		sourceTriggerMessageId: triggerMessage.id as UUID | undefined,
		sourceTrajectoryId:
			typeof metadata.trajectoryId === "string"
				? metadata.trajectoryId
				: undefined,
		sourceTrajectoryStepId:
			typeof metadata.trajectoryStepId === "string"
				? metadata.trajectoryStepId
				: undefined,
		associatedEntityIds,
	};
}

function normalizeStoredText(runtime: IAgentRuntime, text: string): string {
	return runtime.redactSecrets(text).slice(0, 500);
}

export const experiencePatternEvaluator: Evaluator<
	ExperienceOutput,
	ExperiencePrepared
> = {
	name: "experiencePatterns",
	description:
		"Periodically extracts novel agent learning experiences from the room conversation.",
	priority: EvaluatorPriority.EXPERIENCE,
	schema: experienceSchema,
	async shouldRun({ runtime, message }) {
		if (!message.roomId || !message.content?.text) return false;
		const experienceService = runtime.getService(
			"EXPERIENCE",
		) as ExperienceService | null;
		if (!experienceService) return false;

		const cacheKey = `experience-extraction:${message.roomId}:message-count`;
		const currentCount = Number.parseInt(
			(await runtime.getCache<string>(cacheKey)) || "0",
			10,
		);
		const nextCount = Number.isFinite(currentCount) ? currentCount + 1 : 1;
		await runtime.setCache(cacheKey, String(nextCount));
		return nextCount % EXPERIENCE_EXTRACTION_INTERVAL === 0;
	},
	async prepare({ runtime, message }) {
		const experienceService = runtime.getService(
			"EXPERIENCE",
		) as ExperienceService | null;
		if (!experienceService) throw new Error("Experience service not available");
		const recentMessages = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			limit: 10,
			unique: false,
		});
		const conversationContext = recentMessages
			.map((memory) => memory.content.text)
			.filter(
				(text): text is string => typeof text === "string" && text.length > 0,
			)
			.join("\n");
		const existingExperiences = await experienceService.findSimilarExperiences(
			conversationContext,
			EXISTING_EXPERIENCE_LIMIT,
		);
		return {
			experienceService,
			recentMessages,
			conversationContext,
			existingExperiences,
			provenance: buildExperienceProvenance(message, recentMessages),
		};
	},
	prompt({ prepared }) {
		return `Extract novel learning experiences from the recent conversation.

Only emit experiences that describe a reusable lesson for future behavior. The lesson can come from success, failure, correction, discovery, validation, warning, or hypothesis formation.

Rules:
- Return at most three experiences.
- Do not repeat existing experiences.
- Do not extract ordinary chat, one-off user requests, or generic observations.
- The domain should be produced from the conversation itself, not from a fixed list.
- If nothing qualifies, return {"experiences":[]}.

Recent conversation:
${prepared.conversationContext || "(none)"}

Existing similar experiences:
${formatExistingExperiences(prepared.existingExperiences)}`;
	},
	parse: parseExperienceOutput,
	processors: [
		{
			name: "recordExperiences",
			async process({ runtime, prepared, output }) {
				const threshold = getNumberSetting(
					runtime,
					"AUTO_RECORD_THRESHOLD",
					DEFAULT_AUTO_RECORD_THRESHOLD,
				);
				let recordedCount = 0;
				let skippedDuplicateCount = 0;
				const existingLearning = new Set(
					prepared.existingExperiences.map((experience) =>
						experience.learning.trim(),
					),
				);
				for (const exp of output.experiences) {
					if (exp.confidence < threshold) continue;
					const learning = normalizeStoredText(runtime, exp.learning);
					if (!learning || existingLearning.has(learning)) {
						skippedDuplicateCount += 1;
						continue;
					}
					await prepared.experienceService.recordExperience({
						type: exp.type,
						outcome: exp.outcome,
						context: normalizeStoredText(runtime, exp.context),
						action: "post_turn_evaluation",
						result: learning,
						learning,
						domain: normalizeStoredText(runtime, exp.domain),
						tags: ["extracted", "novel", exp.type],
						confidence: Math.min(exp.confidence, 0.9),
						importance: Math.min(Math.max(exp.importance, 0), 1),
						sourceMessageIds: prepared.provenance.sourceMessageIds,
						sourceRoomId: prepared.provenance.sourceRoomId,
						sourceTriggerMessageId: prepared.provenance.sourceTriggerMessageId,
						sourceTrajectoryId: prepared.provenance.sourceTrajectoryId,
						sourceTrajectoryStepId: prepared.provenance.sourceTrajectoryStepId,
						associatedEntityIds: prepared.provenance.associatedEntityIds,
						extractionMethod: "experience_evaluator",
						extractionReason: normalizeStoredText(runtime, exp.reasoning),
					});
					recordedCount += 1;
				}
				logger.debug(
					{
						src: "evaluator:experience",
						extractedCount: output.experiences.length,
						recordedCount,
						skippedDuplicateCount,
					},
					"Processed experience evaluator output",
				);
				return {
					success: true,
					data: {
						extractedCount: output.experiences.length,
						recordedCount,
						skippedDuplicateCount,
					},
					values: {
						extractedCount: output.experiences.length,
						recordedCount,
						skippedDuplicateCount,
					},
				};
			},
		},
	],
};
