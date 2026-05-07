import { logger } from "../../../../logger.ts";
import type {
	ActionResult,
	EvaluationExample,
	Evaluator,
	IAgentRuntime,
	Memory,
	State,
} from "../../../../types/index.ts";
import { MemoryType } from "../../../../types/memory.ts";
import { ModelType } from "../../../../types/model.ts";

// ── Types ──────────────────────────────────────────────────────────────

/** Parsed trigger analysis from the LLM. */
export interface TriggerAnalysis {
	hasEvolutionTrigger: boolean;
	triggerType: string;
	reasoning: string;
	confidence: number;
}

/** Parsed evolution analysis from the LLM. */
export interface EvolutionAnalysis {
	shouldModify: boolean;
	confidence: number;
	gradualChange: boolean;
	reasoning: string;
	modifications: EvolutionModifications;
}

/** Character modifications extracted from a flat structured record. */
export interface EvolutionModifications {
	name?: string;
	system?: string;
	bio?: string[];
	topics?: string[];
	style?: { all?: string[]; chat?: string[]; post?: string[] };
}

// ── Pure helpers (exported for testing) ────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseStructuredRecord(
	response: string,
): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(response.trim()) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function normalizeBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	return undefined;
}

export function normalizeNumber(value: unknown): number | undefined {
	if (typeof value === "number")
		return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	const n = Number(trimmed);
	return Number.isFinite(n) ? n : undefined;
}

export function normalizeStringList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const values = value
			.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
			.filter(Boolean);
		return values.length > 0 ? values : undefined;
	}
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	const delimited = trimmed
		.split(/\s*\|\|\s*/g)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return delimited.length > 0 ? delimited : undefined;
}

/**
 * Parse a flat structured record into a typed TriggerAnalysis.
 * Returns null when the record is missing or has no valid trigger field.
 */
export function parseTriggerAnalysis(
	raw: Record<string, unknown>,
): TriggerAnalysis {
	return {
		hasEvolutionTrigger: normalizeBoolean(raw.hasEvolutionTrigger) ?? false,
		triggerType:
			typeof raw.triggerType === "string" ? raw.triggerType : "unknown",
		reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
		confidence: normalizeNumber(raw.confidence) ?? 0,
	};
}

/**
 * Build an EvolutionModifications object from flat JSON fields.
 * Uses || delimiters for list fields and style_all/style_chat/style_post for style.
 */
export function buildModifications(
	raw: Record<string, unknown>,
): EvolutionModifications {
	const mods: EvolutionModifications = {};

	if (typeof raw.name === "string" && raw.name.trim())
		mods.name = raw.name.trim();
	if (typeof raw.system === "string" && raw.system.trim())
		mods.system = raw.system.trim();

	const bio = normalizeStringList(raw.bio);
	if (bio) mods.bio = bio;

	const topics = normalizeStringList(raw.topics);
	if (topics) mods.topics = topics;

	const style: EvolutionModifications["style"] = {};
	const styleAll = normalizeStringList(raw.style_all);
	const styleChat = normalizeStringList(raw.style_chat);
	const stylePost = normalizeStringList(raw.style_post);
	if (styleAll) style.all = styleAll;
	if (styleChat) style.chat = styleChat;
	if (stylePost) style.post = stylePost;
	if (Object.keys(style).length > 0) mods.style = style;

	return mods;
}

/**
 * Parse a flat structured record into a typed EvolutionAnalysis.
 */
export function parseEvolutionAnalysis(
	raw: Record<string, unknown>,
): EvolutionAnalysis {
	return {
		shouldModify: normalizeBoolean(raw.shouldModify) ?? false,
		confidence: normalizeNumber(raw.confidence) ?? 0,
		gradualChange: normalizeBoolean(raw.gradualChange) ?? true,
		reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
		modifications: buildModifications(raw),
	};
}

/**
 * Evaluator that analyzes conversations for character evolution opportunities
 * Runs after conversations to identify patterns that suggest character growth
 */
export const characterEvolutionEvaluator: Evaluator = {
	name: "CHARACTER_EVOLUTION",
	description:
		"Analyzes conversations to identify opportunities for gradual character evolution and self-modification",
	alwaysRun: false, // Only run when conversation warrants it

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> => {
		// Skip if too recent since last evaluation
		const lastEvolution = await runtime.getCache<string>(
			"character-evolution:last-check",
		);
		const now = Date.now();
		const cooldownMs = 5 * 60 * 1000; // 5 minutes between evaluations

		if (lastEvolution && now - parseInt(lastEvolution, 10) < cooldownMs) {
			return false;
		}

		// Only evaluate if conversation has substantial content
		const rawMessageCount = state?.data?.messageCount;
		const conversationLength =
			typeof rawMessageCount === "number" ? rawMessageCount : 0;
		if (conversationLength < 3) {
			return false;
		}

		// Check if there are novel patterns or learning opportunities
		const recentMessages = await runtime.getMemories({
			roomId: message.roomId,
			count: 10,
			unique: true,
			tableName: "messages",
		});

		// Advanced trigger detection using "bitter lesson" approach - LLM evaluation instead of hardcoded patterns
		const triggerAnalysisPrompt = `Analyze this conversation for character evolution triggers:

CONVERSATION:
${recentMessages.map((m) => `${m.entityId === runtime.agentId ? "Agent" : "User"}: ${m.content.text}`).join("\n")}

TRIGGER ANALYSIS - Check for:

1. CONVERSATION SUCCESS PATTERNS
   - User engagement (long responses, follow-up questions)
   - Positive sentiment from user
   - User satisfaction indicators

2. KNOWLEDGE GAP DISCOVERY
   - Agent uncertainty or "I don't know" responses
   - User providing corrections or new information
   - New domains the agent struggled with

3. PERSONALITY EFFECTIVENESS
   - User preferences for communication style
   - Energy level matching user needs
   - Emotional intelligence opportunities

4. VALUE CREATION OPPORTUNITIES
   - User goals mentioned that agent could help with better
   - Suggestions that would improve user outcomes
   - Areas where agent could be more helpful

5. EXPLICIT FEEDBACK
   - Direct requests for personality changes
   - User feedback about agent behavior
   - Suggestions for improvement

Return exactly one JSON object. No prose before or after it. No <think>.

Example:
{
  "hasEvolutionTrigger": true,
  "triggerType": "explicit_feedback",
  "reasoning": "User explicitly asked for a personality change",
  "confidence": 0.85
}`;

		let hasEvolutionTriggers = false;
		try {
			const triggerResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
				prompt: triggerAnalysisPrompt,
				temperature: 0.2,
				maxTokens: 300,
			});

			const raw = parseStructuredRecord(triggerResponse as string);
			if (raw) {
				const trigger = parseTriggerAnalysis(raw);
				hasEvolutionTriggers =
					trigger.hasEvolutionTrigger && trigger.confidence > 0.6;

				if (hasEvolutionTriggers) {
					logger.info(
						{
							type: trigger.triggerType,
							reasoning: trigger.reasoning,
							confidence: trigger.confidence,
						},
						"Evolution trigger detected",
					);
				}
			}
		} catch {
			// Fallback to basic pattern matching if LLM analysis fails
			hasEvolutionTriggers = recentMessages.some((msg) => {
				const text = msg.content.text?.toLowerCase() || "";
				return (
					text.includes("you should") ||
					text.includes("change your") ||
					text.includes("different way") ||
					text.includes("personality") ||
					text.includes("behavior") ||
					text.includes("remember that") ||
					text.includes("from now on")
				);
			});
		}

		return hasEvolutionTriggers;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<ActionResult | undefined> => {
		try {
			await runtime.setCache(
				"character-evolution:last-check",
				Date.now().toString(),
			);

			// Get recent conversation context
			const recentMessages = await runtime.getMemories({
				roomId: message.roomId,
				count: 20,
				unique: true,
				tableName: "messages",
			});

			// Format conversation for analysis
			const conversationText = recentMessages
				.slice(-10) // Last 10 messages
				.map((msg) => {
					const isAgent = msg.entityId === runtime.agentId;
					const name = isAgent ? runtime.character.name : "User";
					return `${name}: ${msg.content.text}`;
				})
				.join("\n");

			// Current character summary for context
			const currentCharacter = runtime.character;
			const characterSummary = {
				name: currentCharacter.name,
				system: currentCharacter.system || "No system prompt defined",
				bio: Array.isArray(currentCharacter.bio)
					? currentCharacter.bio
					: [currentCharacter.bio],
				currentTopics: currentCharacter.topics || [],
				messageExampleCount: currentCharacter.messageExamples?.length || 0,
			};

			// Advanced evolution analysis using "bitter lesson" approach with specific triggers
			const evolutionPrompt = `You are conducting a comprehensive analysis to determine if an AI agent should evolve its character definition based on measurable patterns and outcomes.

CURRENT CHARACTER STATE:
Name: ${characterSummary.name}
System: ${characterSummary.system}
Bio: ${characterSummary.bio.join("; ")}
Topics: ${characterSummary.currentTopics.join(", ")}
Message Examples: ${characterSummary.messageExampleCount}

CONVERSATION TO ANALYZE:
${conversationText}

EVOLUTION TRIGGER ANALYSIS:

1. CONVERSATION SUCCESS METRICS
   - How engaged was the user? (response length, follow-up questions)
   - Did the conversation achieve positive outcomes?
   - What personality traits contributed to success/failure?

2. KNOWLEDGE GAP IDENTIFICATION
   - What topics did the agent struggle with?
   - Where did the agent show uncertainty or lack of knowledge?
   - What new domains emerged that should be added?

3. PERSONALITY EFFECTIVENESS ASSESSMENT
   - Is the agent's communication style working for this user?
   - Should energy level, formality, or approach be adjusted?
   - Are there emotional intelligence improvements needed?

4. VALUE CREATION OPPORTUNITIES
   - What goals did the user express that the agent could better support?
   - How could the agent be more helpful in achieving user outcomes?
   - What capabilities would increase user value?

5. BEHAVIORAL PATTERN OPTIMIZATION
   - What response patterns should be reinforced or changed?
   - Are there better ways to handle similar situations?
   - Should any communication preferences be updated?

EVOLUTION DECISION FRAMEWORK:
- Only suggest modifications that address measurable gaps
- Prioritize changes that improve user experience
- Ensure gradual, incremental evolution
- Maintain core personality while optimizing effectiveness
- Consider safety and appropriateness of all changes

MODIFICATION PRIORITIES:
- name: ONLY if a truly fitting identity emerges organically (very rare, reserved for major personality shifts)
- system: ONLY for fundamental behavioral misalignment (rare)
- bio: New traits that emerge from successful interactions
- topics: Domains where agent showed interest/competence
- style: Communication preferences that enhance effectiveness

Return exactly one JSON object. No prose before or after it. No <think>.
Use arrays for list fields.

Example:
{
  "shouldModify": true,
  "confidence": 0.75,
  "gradualChange": true,
  "reasoning": "User consistently asks about sustainability topics that are not in the current character definition.",
  "bio": ["Passionate about environmental sustainability", "Knowledgeable about renewable energy"],
  "topics": ["climate change", "solar energy", "sustainable living"],
  "style_chat": ["Use encouraging tone when discussing environmental topics"]
}`;

			const response = await runtime.useModel(ModelType.TEXT_LARGE, {
				prompt: evolutionPrompt,
				temperature: 0.3,
				maxTokens: 1000,
			});

			// Parse the evolution suggestion from structured output
			const raw = parseStructuredRecord(response as string);
			if (!raw) {
				logger.warn(
					"Failed to parse character evolution analysis — no structured record",
				);
				return;
			}

			const evolution = parseEvolutionAnalysis(raw);

			// Only proceed if modification is recommended with sufficient confidence
			if (!evolution.shouldModify || evolution.confidence < 0.7) {
				return;
			}

			// Ensure gradual change
			if (!evolution.gradualChange) {
				logger.info("Skipping character evolution - change too dramatic");
				return;
			}

			// Store evolution suggestion for potential application
			await runtime.createMemory(
				{
					entityId: runtime.agentId,
					roomId: message.roomId,
					content: {
						text: `Character evolution suggested (confidence: ${evolution.confidence}): ${evolution.reasoning}`,
						source: "character_evolution",
					},
					metadata: {
						type: MemoryType.CUSTOM,
						evaluatorName: "character-evolution",
						timestamp: Date.now(),
						confidence: evolution.confidence,
						evolutionData: JSON.stringify({
							shouldModify: evolution.shouldModify,
							gradualChange: evolution.gradualChange,
							modifications: evolution.modifications,
						}),
					},
				},
				"character_evolution",
			);

			logger.info(
				{
					shouldModify: evolution.shouldModify,
					confidence: evolution.confidence,
					reasoning: evolution.reasoning.slice(0, 100),
				},
				"Character evolution analysis completed",
			);
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Error in character evolution evaluator",
			);
		}
	},

	examples: [
		{
			prompt:
				"Evaluating character evolution after many conversations about environmental issues",
			messages: [
				{
					name: "{{user1}}",
					content: { text: "What can I do about climate change?" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "There are many ways to help, from reducing energy use to supporting renewable energy initiatives.",
					},
				},
				{
					name: "{{user2}}",
					content: { text: "How does solar energy work?" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Solar panels convert sunlight into electricity using photovoltaic cells.",
					},
				},
				{
					name: "{{user3}}",
					content: {
						text: "What are the best sustainable practices for daily life?",
					},
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Reducing waste, using public transport, and choosing renewable energy are great starts.",
					},
				},
			],
			outcome:
				"Character develops environmental expertise and adds sustainability topics to better serve user interests",
		},
		{
			prompt:
				"Evaluating character evolution after users frequently seek emotional support",
			messages: [
				{
					name: "{{user1}}",
					content: { text: "I'm feeling overwhelmed with work" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "I hear you. It's okay to feel overwhelmed. Let's take this one step at a time.",
					},
				},
				{
					name: "{{user2}}",
					content: { text: "I'm struggling with anxiety" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Thank you for sharing. Anxiety can be challenging. What specific situations trigger it for you?",
					},
				},
				{
					name: "{{user3}}",
					content: { text: "I need someone to talk to" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "I'm here to listen. Sometimes just talking things through can help bring clarity.",
					},
				},
			],
			outcome:
				"Character develops empathetic communication style and adds supportive message examples",
		},
	] as EvaluationExample[],
};
