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

type ExtractedExperience = {
	type?: string;
	learning?: string;
	context?: string;
	confidence?: number;
	reasoning?: string;
};

const EXISTING_EXPERIENCE_LIMIT = 5;
const DUPLICATE_EXPERIENCE_LIMIT = 5;
const DUPLICATE_JACCARD_THRESHOLD = 0.45;
const DUPLICATE_CONTAINMENT_THRESHOLD = 0.65;
const DUPLICATE_SHARED_TERM_THRESHOLD = 4;
const PASSIVE_ACTIONS = new Set([
	"REPLY",
	"NONE",
	"NOACTION",
	"IGNORE",
	"WAIT",
]);
const STOP_WORDS = new Set([
	"about",
	"after",
	"again",
	"before",
	"being",
	"from",
	"into",
	"that",
	"their",
	"them",
	"then",
	"there",
	"these",
	"this",
	"when",
	"with",
	"without",
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
			const duplicate = await findDuplicateExperience(
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
				domain: detectDomain(sanitizedLearning),
				tags: ["extracted", "novel", experienceTag],
				confidence: Math.min(exp.confidence, 0.9), // Cap confidence
				importance: 0.8, // High importance for extracted experiences
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
			const learning = sanitizeContext(experience.learning);
			const context = sanitizeContext(experience.context);
			return `${index + 1}. (${experience.type}/${experience.domain}, confidence ${experience.confidence.toFixed(2)}) When ${context}, learned: ${learning}`;
		})
		.join("\n");
}

async function findDuplicateExperience(
	experienceService: ExperienceService,
	learning: string,
): Promise<Experience | null> {
	const similar = await experienceService.findSimilarExperiences(
		learning,
		DUPLICATE_EXPERIENCE_LIMIT,
	);

	return (
		similar.find((experience) =>
			isDuplicateLearning(learning, experience.learning),
		) ?? null
	);
}

function isDuplicateLearning(a: string, b: string): boolean {
	const normalizedA = normalizeTextForDuplicateComparison(a);
	const normalizedB = normalizeTextForDuplicateComparison(b);
	if (!normalizedA || !normalizedB) {
		return false;
	}
	if (normalizedA === normalizedB) {
		return true;
	}
	if (
		Math.min(normalizedA.length, normalizedB.length) >= 24 &&
		(normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA))
	) {
		return true;
	}

	const aTokens = tokenizeForDuplicateComparison(normalizedA);
	const bTokens = tokenizeForDuplicateComparison(normalizedB);
	if (aTokens.size < 4 || bTokens.size < 4) {
		return false;
	}

	const overlap = [...aTokens].filter((token) => bTokens.has(token)).length;
	const union = new Set([...aTokens, ...bTokens]).size;
	const jaccard = union > 0 ? overlap / union : 0;
	const containment = overlap / Math.min(aTokens.size, bTokens.size);

	return (
		jaccard >= DUPLICATE_JACCARD_THRESHOLD ||
		containment >= DUPLICATE_CONTAINMENT_THRESHOLD ||
		(overlap >= DUPLICATE_SHARED_TERM_THRESHOLD && containment >= 0.4)
	);
}

function normalizeTextForDuplicateComparison(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function tokenizeForDuplicateComparison(text: string): Set<string> {
	return new Set(
		text
			.split(" ")
			.map((token) => token.trim())
			.filter((token) => token.length > 3 && !STOP_WORDS.has(token)),
	);
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
	if (!text) return "Unknown context";

	// Remove user-specific details while preserving technical context
	return text
		.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "[EMAIL]") // emails
		.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[IP]") // IP addresses
		.replace(/\/Users\/[^/\s]+/g, "/Users/[USER]") // user directories
		.replace(/\/home\/[^/\s]+/g, "/home/[USER]") // home directories
		.replace(
			/\b(?:sk|pk|rk|gsk|ghp|gho|ghu|ghs|github_pat|xox[baprs])-?[A-Za-z0-9_-]{12,}\b/gi,
			"[TOKEN]",
		) // common API keys/tokens
		.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[TOKEN]") // long opaque tokens
		.replace(
			/\b(user|person|someone|they)\s+(said|asked|told|mentioned)/gi,
			"when asked",
		) // personal references
		.substring(0, 200); // limit length
}

function detectDomain(text: string): string {
	const domains: Record<string, string[]> = {
		shell: ["command", "terminal", "bash", "shell", "execute", "script", "cli"],
		coding: [
			"code",
			"function",
			"variable",
			"syntax",
			"programming",
			"debug",
			"typescript",
			"javascript",
		],
		system: [
			"file",
			"directory",
			"process",
			"memory",
			"cpu",
			"system",
			"install",
			"package",
		],
		network: [
			"http",
			"api",
			"request",
			"response",
			"url",
			"network",
			"fetch",
			"curl",
		],
		data: ["json", "csv", "database", "query", "data", "sql", "table"],
		ai: ["model", "llm", "embedding", "prompt", "token", "inference"],
	};

	const lowerText = text.toLowerCase();

	for (const [domain, keywords] of Object.entries(domains)) {
		if (keywords.some((keyword) => lowerText.includes(keyword))) {
			return domain;
		}
	}

	return "general";
}
