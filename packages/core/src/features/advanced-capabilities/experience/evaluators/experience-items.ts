import { logger } from "../../../../logger.ts";
import { EvaluatorPriority } from "../../../../services/evaluator-priorities.ts";
import type {
	Evaluator,
	IAgentRuntime,
	JSONSchema,
	Memory,
	UUID,
} from "../../../../types/index.ts";
import { isSyntheticConversationArtifactMemory } from "../../../../utils/synthetic-conversation-artifact.ts";
import { isObjectRecord as isRecord } from "../../../../utils/type-guards.ts";
import type { ExperienceService } from "../service.ts";
import { type Experience, ExperienceType, OutcomeType } from "../types.ts";

const EXPERIENCE_EXTRACTION_FALLBACK_INTERVAL = 25;
const EXPERIENCE_EXTRACTION_MIN_SIGNAL_GAP = 4;
const RECENT_MESSAGES_LIMIT = 12;
const MAX_CONVERSATION_CONTEXT_CHARS = 6000;
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
	signalSummary: string;
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

function actionResultsFromState(state: unknown): unknown[] {
	if (!isRecord(state)) return [];
	const data = isRecord(state.data) ? state.data : {};
	const actionResults = data.actionResults;
	return Array.isArray(actionResults) ? actionResults : [];
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

function normalizeLearningKey(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function safeText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function isSyntheticMemory(memory: Memory): boolean {
	return isSyntheticConversationArtifactMemory(memory);
}

function getMessageText(memory: Memory): string {
	return typeof memory.content?.text === "string" ? memory.content.text : "";
}

function hasExplicitExperienceRequest(text: string): boolean {
	return /\b(?:remember|store|learn|note)\s+(?:this|that|this lesson|this pattern|for next time|going forward)\b/i.test(
		text,
	);
}

function scoreExperienceSignals(input: {
	latestText: string;
	responseTexts?: string[];
	actionResults?: unknown[];
	recentTexts?: string[];
}): { score: number; reasons: string[] } {
	const reasons = new Set<string>();
	const combinedText = [
		input.latestText,
		...(input.responseTexts ?? []),
		...(input.recentTexts ?? []),
	]
		.map((text) => text.toLowerCase())
		.join("\n");

	if (hasExplicitExperienceRequest(input.latestText)) {
		reasons.add("explicit learning request");
	}
	if (
		/\b(?:actually|correction|correcting|i was wrong|you were wrong|mistake|incorrect|misread|misunderstood)\b/.test(
			combinedText,
		)
	) {
		reasons.add("correction");
	}
	if (
		/\b(?:root cause|lesson learned|learned that|next time|from now on|avoid|workaround|regression|postmortem)\b/.test(
			combinedText,
		)
	) {
		reasons.add("reusable lesson");
	}
	if (
		/\b(?:failed|failure|error|exception|timeout|blocked|stuck|bug|broke|broken|invalid|flaky)\b/.test(
			combinedText,
		)
	) {
		reasons.add("failure signal");
	}
	if (
		/\b(?:fixed|resolved|validated|verified|confirmed|works now|passes now|green|succeeded)\b/.test(
			combinedText,
		)
	) {
		reasons.add("validated outcome");
	}
	if (
		/\b(?:discovered|found that|turns out|notably|surprising|unexpected|novel|new behavior)\b/.test(
			combinedText,
		)
	) {
		reasons.add("discovery");
	}

	for (const result of input.actionResults ?? []) {
		const text = safeText(result).toLowerCase();
		if (
			/\b(?:error|failed|failure|exception|timeout|blocked|success|completed|fixed|verified|validated)\b/.test(
				text,
			)
		) {
			reasons.add("action result outcome");
			break;
		}
	}

	return { score: reasons.size, reasons: Array.from(reasons) };
}

function summarizeExperienceSignals(reasons: string[]): string {
	return reasons.length > 0 ? reasons.join(", ") : "fallback interval";
}

async function getCounter(
	runtime: IAgentRuntime,
	key: string,
): Promise<number> {
	const current = Number.parseInt(
		(await runtime.getCache<string>(key)) || "0",
		10,
	);
	return Number.isFinite(current) ? current : 0;
}

function sanitizeConversationText(
	runtime: IAgentRuntime,
	text: string,
): string {
	return runtime.redactSecrets(text).replace(/\s+\n/g, "\n").trim();
}

export const experiencePatternEvaluator: Evaluator<
	ExperienceOutput,
	ExperiencePrepared
> = {
	name: "experiencePatterns",
	description:
		"Extracts reusable agent lessons from validated conversation events.",
	priority: EvaluatorPriority.EXPERIENCE,
	schema: experienceSchema,
	async shouldRun({ runtime, message, state, options }) {
		if (!message.roomId || !message.content?.text) return false;
		if (isSyntheticMemory(message)) return false;
		const experienceService = runtime.getService(
			"EXPERIENCE",
		) as ExperienceService | null;
		if (!experienceService) return false;

		const cacheKey = `experience-extraction:${message.roomId}:message-count`;
		const lastRunKey = `experience-extraction:${message.roomId}:last-run-count`;
		const nextCount = (await getCounter(runtime, cacheKey)) + 1;
		await runtime.setCache(cacheKey, String(nextCount));

		const latestText = getMessageText(message);
		const responseTexts = (options.responses ?? []).map(getMessageText);
		const actionResults = actionResultsFromState(state);
		const directSignal = scoreExperienceSignals({
			latestText,
			responseTexts,
			actionResults,
		});
		const lastRunCount = await getCounter(runtime, lastRunKey);
		const minSignalGap = Math.max(
			0,
			Math.floor(
				getNumberSetting(
					runtime,
					"EXPERIENCE_EXTRACTION_MIN_SIGNAL_GAP",
					EXPERIENCE_EXTRACTION_MIN_SIGNAL_GAP,
				),
			),
		);

		if (
			directSignal.score > 0 &&
			(hasExplicitExperienceRequest(latestText) ||
				lastRunCount === 0 ||
				nextCount - lastRunCount >= minSignalGap)
		) {
			await runtime.setCache(lastRunKey, String(nextCount));
			return true;
		}

		const fallbackInterval = Math.max(
			1,
			Math.floor(
				getNumberSetting(
					runtime,
					"EXPERIENCE_EXTRACTION_FALLBACK_INTERVAL",
					EXPERIENCE_EXTRACTION_FALLBACK_INTERVAL,
				),
			),
		);
		if (nextCount % fallbackInterval !== 0) return false;

		const recentMessages = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			limit: RECENT_MESSAGES_LIMIT,
			unique: false,
		});
		const recentTexts = recentMessages
			.filter((memory) => !isSyntheticMemory(memory))
			.map(getMessageText)
			.filter(Boolean);
		const fallbackSignal = scoreExperienceSignals({
			latestText,
			responseTexts,
			actionResults,
			recentTexts,
		});
		if (fallbackSignal.score === 0) return false;
		await runtime.setCache(lastRunKey, String(nextCount));
		return true;
	},
	async prepare({ runtime, message, state, options }) {
		const experienceService = runtime.getService(
			"EXPERIENCE",
		) as ExperienceService | null;
		if (!experienceService) throw new Error("Experience service not available");
		const rawRecentMessages = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			limit: RECENT_MESSAGES_LIMIT,
			unique: false,
		});
		const recentMessages = rawRecentMessages.filter(
			(memory) => !isSyntheticMemory(memory),
		);
		const conversationContext = recentMessages
			.map((memory) => memory.content.text)
			.filter(
				(text): text is string => typeof text === "string" && text.length > 0,
			)
			.map((text) => sanitizeConversationText(runtime, text))
			.join("\n")
			.slice(-MAX_CONVERSATION_CONTEXT_CHARS);
		const signalSummary = summarizeExperienceSignals(
			scoreExperienceSignals({
				latestText: getMessageText(message),
				responseTexts: (options.responses ?? []).map(getMessageText),
				actionResults: actionResultsFromState(state),
				recentTexts: recentMessages.map(getMessageText),
			}).reasons,
		);
		const existingExperiences = await experienceService.findSimilarExperiences(
			conversationContext,
			EXISTING_EXPERIENCE_LIMIT,
		);
		return {
			experienceService,
			recentMessages,
			conversationContext,
			signalSummary,
			existingExperiences,
			provenance: buildExperienceProvenance(message, recentMessages),
		};
	},
	prompt({ prepared }) {
		return `Extract reusable lessons from recent conversation.

Emit only lessons useful for future behavior: success, failure, correction, discovery, validation, warning, hypothesis.

Rules:
- Max 3. Do not duplicate existing.
- Keep operational lessons grounded in tool outcomes, corrections, failed assumptions, discoveries, or explicit remember-this.
- Skip ordinary chat, one-off requests, generic observations, stable user facts/preferences; other evaluators handle those.
- Skip synthetic summaries, benchmark scaffolding, agent-generated summaries.
- Never store secrets/credentials/API keys/passwords/tokens/private keys.
- Domain comes from conversation.
- Nothing qualifies -> {"experiences":[]}.

Detected extraction signal:
${prepared.signalSummary}

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
						normalizeLearningKey(experience.learning),
					),
				);
				const seenLearning = new Set<string>();
				for (const exp of output.experiences) {
					if (exp.confidence < threshold) continue;
					const learning = normalizeStoredText(runtime, exp.learning);
					const learningKey = normalizeLearningKey(learning);
					if (
						!learning ||
						!learningKey ||
						existingLearning.has(learningKey) ||
						seenLearning.has(learningKey)
					) {
						skippedDuplicateCount += 1;
						continue;
					}
					seenLearning.add(learningKey);
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
