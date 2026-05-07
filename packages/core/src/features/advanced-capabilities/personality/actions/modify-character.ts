import { logger } from "../../../../logger.ts";
import { checkSenderRole } from "../../../../roles.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "../../../../types/index.ts";
import { MemoryType } from "../../../../types/memory.ts";
import { ModelType } from "../../../../types/model.ts";
import { hasActionContextOrKeyword } from "../../../../utils/action-validation.ts";
import type { CharacterFileManager } from "../services/character-file-manager.ts";
import {
	MAX_PREFS_PER_USER,
	PersonalityServiceType,
	USER_PREFS_TABLE,
} from "../types.ts";

type ModifyCharacterScope = "auto" | "global" | "user";

type ModifyCharacterHandlerOptions = {
	parameters?: {
		request?: string;
		scope?: string;
	};
};

type ModificationIntentAnalysis = {
	isModificationRequest: boolean;
	requestType: "explicit" | "suggestion" | "none";
	confidence: number;
};

function normalizeModifyCharacterScope(value: unknown): ModifyCharacterScope {
	return value === "global" || value === "user" ? value : "auto";
}

function resolveEffectiveModifyCharacterRequest(
	message: Memory,
	options?: ModifyCharacterHandlerOptions,
): {
	text: string;
	requestSource: "parameter" | "message";
} {
	const parameterRequest = options?.parameters?.request?.trim();
	const rawMessageText = (message.content.text || "").trim();

	if (!parameterRequest) {
		return {
			text: rawMessageText,
			requestSource: "message",
		};
	}

	if (!rawMessageText || rawMessageText === parameterRequest) {
		return {
			text: parameterRequest,
			requestSource: "parameter",
		};
	}

	const rawMessageNormalized = rawMessageText.toLowerCase();
	const parameterNormalized = parameterRequest.toLowerCase();
	if (
		rawMessageText.length > parameterRequest.length &&
		rawMessageNormalized.includes(parameterNormalized)
	) {
		return {
			text: rawMessageText,
			requestSource: "message",
		};
	}

	return {
		text: parameterRequest,
		requestSource: "parameter",
	};
}

function resolveModifyCharacterScope(
	scopeHint: ModifyCharacterScope,
	isAdmin: boolean,
): Exclude<ModifyCharacterScope, "auto"> {
	if (!isAdmin) return "user";
	return scopeHint === "user" ? "user" : "global";
}

/**
 * Action for direct character modification based on user requests or self-reflection
 * Handles both explicit user requests and agent-initiated modifications
 */
export const modifyCharacterAction: Action = {
	name: "MODIFY_CHARACTER",
	contexts: ["settings", "agent_internal", "media"],
	roleGate: { minRole: "ADMIN" },
	similes: [
		"UPDATE_PERSONALITY",
		"CHANGE_PERSONALITY",
		"UPDATE_CHARACTER",
		"CHANGE_CHARACTER",
		"CHANGE_BEHAVIOR",
		"ADJUST_BEHAVIOR",
		"CHANGE_TONE",
		"UPDATE_TONE",
		"CHANGE_STYLE",
		"UPDATE_STYLE",
		"CHANGE_VOICE",
		"CHANGE_RESPONSE_STYLE",
		"UPDATE_RESPONSE_STYLE",
		"EVOLVE_CHARACTER",
		"SELF_MODIFY",
		"SET_RESPONSE_STYLE",
		"SET_LANGUAGE",
		"SET_INTERACTION_MODE",
		"SET_USER_PREFERENCE",
	],
	description: [
		"Updates the agent's character when a user asks to change the character, personality, tone, voice, style, response format, language, name, bio, topics, or moderation behavior.",
		"Use this for requests like 'update your personality', 'update its personality', 'change your tone', 'change your response style', 'change your response style with me to be concise and direct', 'be warmer and less verbose', 'be more encouraging', 'respond in Chinese', or 'only reply when directly addressed'.",
		"Admins and owners apply global character changes; non-admin users are routed to per-user interaction preferences so the change only affects conversations with that specific user.",
		"Supports action chaining by returning structured modification metadata for audit trails, backups, notifications, or other follow-on workflows.",
	].join(" "),
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "request",
			description:
				"Optional natural-language request describing the desired character or interaction change. If provided, the action evaluates this request instead of relying only on the raw message text.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "scope",
			description:
				"Optional scope hint. Use 'global' for a shared character update, 'user' for a per-user interaction preference, or omit it to infer from the sender's permissions.",
			required: false,
			schema: {
				type: "string" as const,
				enum: ["auto", "global", "user"],
			},
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<boolean> => {
		const fileManager = runtime.getService<CharacterFileManager>(
			PersonalityServiceType.CHARACTER_MANAGEMENT,
		);
		if (!fileManager) {
			return false;
		}
		if (
			!hasActionContextOrKeyword(message, _state, {
				contexts: ["settings", "agent_internal", "media"],
				keywords: [
					"personality",
					"character",
					"tone",
					"style",
					"behavior",
					"voice",
					"bio",
					"name",
					"respond in",
					"be more",
					"be less",
					"change how you",
					"update yourself",
				],
			})
		) {
			return false;
		}

		const messageText = message.content.text || "";
		const modificationIntent = detectModificationIntentByRules(messageText);
		const evolutionSuggestions = await runtime.getMemories({
			entityId: runtime.agentId,
			roomId: message.roomId,
			count: 5,
			tableName: "character_evolution",
		});

		const hasRecentEvolutionSuggestion = evolutionSuggestions.some(
			(suggestion) => {
				const meta = suggestion.metadata as Record<string, unknown> | undefined;
				const timestamp =
					typeof meta?.timestamp === "number" ? meta.timestamp : 0;
				const suggestionAge = Date.now() - timestamp;
				const maxAge = 30 * 60 * 1000;
				return (
					suggestionAge < maxAge && extractEvolutionModification(meta) !== null
				);
			},
		);

		const shouldRun =
			modificationIntent.intent.isModificationRequest &&
			modificationIntent.intent.requestType === "explicit";
		if (shouldRun) {
			logger.info(
				{
					userId: message.entityId,
					messageText: messageText.substring(0, 100),
				},
				"Explicit modification request detected — role check deferred to handler",
			);
		}

		const shouldRunForEvolution = !shouldRun && hasRecentEvolutionSuggestion;
		if (shouldRunForEvolution) {
			logger.info(
				{
					roomId: message.roomId,
					suggestionCount: evolutionSuggestions.length,
				},
				"Recent evolution suggestion detected",
			);
		}

		const shouldRunForPotential =
			!shouldRun &&
			!shouldRunForEvolution &&
			modificationIntent.potentialRequest;
		if (shouldRunForPotential) {
			logger.info(
				{
					userId: message.entityId,
					messageText: messageText.substring(0, 100),
				},
				"Potential modification request detected by heuristic rules",
			);
		}

		return shouldRun || shouldRunForEvolution || shouldRunForPotential;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: Record<string, unknown>,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		try {
			const fileManager = runtime.getService<CharacterFileManager>(
				PersonalityServiceType.CHARACTER_MANAGEMENT,
			);
			if (!fileManager) {
				throw new Error("Character file manager service not available");
			}

			const handlerOptions = options as
				| ModifyCharacterHandlerOptions
				| undefined;
			const requestResolution = resolveEffectiveModifyCharacterRequest(
				message,
				handlerOptions,
			);
			const messageText = requestResolution.text;
			const scopeHint = normalizeModifyCharacterScope(
				handlerOptions?.parameters?.scope,
			);
			let modification: Record<string, unknown> | null = null;
			let isUserRequested = false;

			// Detect whether the message is a user modification request
			const modificationIntent = await detectModificationIntent(
				runtime,
				messageText,
			);

			if (modificationIntent.isModificationRequest) {
				// User-initiated modification — role check determines scope
				const isAdmin = await checkAdminPermissions(runtime, message);
				const effectiveScope = resolveModifyCharacterScope(scopeHint, isAdmin);

				if (effectiveScope === "user") {
					return await handleUserPreference(
						runtime,
						message,
						messageText,
						callback,
					);
				}

				isUserRequested = true;
				modification = await parseUserModificationRequest(
					runtime,
					message,
					messageText,
				);

				logger.info(
					{
						scope: effectiveScope,
						requestSource: requestResolution.requestSource,
						messageText: messageText.substring(0, 100),
					},
					"Evaluating MODIFY_CHARACTER request with LLM",
				);
			} else {
				// Not a modification request — check for agent-initiated evolution
				const evolutionSuggestions = await runtime.getMemories({
					entityId: runtime.agentId,
					roomId: message.roomId,
					count: 1,
					tableName: "character_evolution",
				});

				if (evolutionSuggestions.length > 0) {
					const suggestion = evolutionSuggestions[0];
					const suggestionMeta = suggestion.metadata as
						| Record<string, unknown>
						| undefined;
					modification = extractEvolutionModification(suggestionMeta);
				}
			}

			if (!modification) {
				await callback?.({
					text: "I don't see any clear modification instructions. Could you be more specific about how you'd like me to change?",
					thought: "No valid modification found",
				});
				return {
					text: "I don't see any clear modification instructions. Could you be more specific about how you'd like me to change?",
					values: { success: false, error: "no_modification_found" },
					data: { action: "MODIFY_CHARACTER" },
					success: false,
				};
			}

			// Evaluate modification safety and appropriateness
			const safetyEvaluation = await evaluateModificationSafety(
				runtime,
				modification,
				messageText,
			);

			if (!safetyEvaluation.isAppropriate) {
				let responseText =
					"I understand you'd like me to change, but I need to decline some of those modifications.";

				if (safetyEvaluation.concerns.length > 0) {
					responseText += ` My concerns are: ${safetyEvaluation.concerns.join(", ")}.`;
				}

				responseText += ` ${safetyEvaluation.reasoning}`;

				// If there are acceptable changes within the request, apply only those
				if (
					safetyEvaluation.acceptableChanges &&
					Object.keys(safetyEvaluation.acceptableChanges).length > 0
				) {
					responseText +=
						" However, I can work on the appropriate improvements you mentioned.";
					modification = safetyEvaluation.acceptableChanges;

					logger.info(
						{
							originalModification: JSON.stringify(modification),
							filteredModification: JSON.stringify(
								safetyEvaluation.acceptableChanges,
							),
							concerns: safetyEvaluation.concerns,
						},
						"Applying selective modifications after safety filtering",
					);
				} else {
					// No acceptable changes - reject completely
					await callback?.({
						text: responseText,
						thought: `Rejected modification due to safety concerns: ${safetyEvaluation.concerns.join(", ")}`,
						actions: [], // Explicitly no actions to show rejection
					});

					logger.warn(
						{
							messageText: messageText.substring(0, 100),
							concerns: safetyEvaluation.concerns,
							reasoning: safetyEvaluation.reasoning,
						},
						"Modification completely rejected by safety evaluation",
					);

					return {
						text: responseText,
						values: {
							success: false,
							error: "safety_rejection",
							concerns: safetyEvaluation.concerns,
						},
						data: {
							action: "MODIFY_CHARACTER",
							rejectionReason: "safety_concerns",
							concerns: safetyEvaluation.concerns,
							reasoning: safetyEvaluation.reasoning,
						},
						success: false,
					};
				}
			} else {
				logger.info(
					{
						messageText: messageText.substring(0, 100),
						reasoning: safetyEvaluation.reasoning,
					},
					"Modification passed safety evaluation",
				);
			}

			// Validate the modification
			const validation = fileManager.validateModification(modification);
			if (!validation.valid) {
				await callback?.({
					text: `I can't make those changes because: ${validation.errors.join(", ")}`,
					thought: "Modification validation failed",
				});
				return {
					text: `I can't make those changes because: ${validation.errors.join(", ")}`,
					values: {
						success: false,
						error: "validation_failed",
						validationErrors: validation.errors,
					},
					data: {
						action: "MODIFY_CHARACTER",
						errorType: "validation_error",
						validationErrors: validation.errors,
					},
					success: false,
				};
			}

			// Apply the modification
			const result = await fileManager.applyModification(modification);

			if (result.success) {
				const modificationSummary = summarizeModification(modification);

				await callback?.({
					text: `I've successfully updated my character. ${modificationSummary}`,
					thought: `Applied character modification: ${modificationSummary}`,
					actions: ["MODIFY_CHARACTER"],
				});

				try {
					await runtime.createMemory(
						{
							entityId: runtime.agentId,
							roomId: message.roomId,
							content: {
								text: `Character modification completed: ${modificationSummary}`,
								source: "character_modification_success",
							},
							metadata: {
								type: MemoryType.CUSTOM,
								isUserRequested,
								timestamp: Date.now(),
								requesterId: message.entityId,
								modification: {
									summary: modificationSummary,
									fieldsModified: Object.keys(modification),
								},
							},
						},
						"modifications",
					);
				} catch (memoryError) {
					logger.warn(
						{
							error:
								memoryError instanceof Error
									? memoryError.message
									: String(memoryError),
						},
						"Character modification success log failed",
					);
				}

				return {
					text: `I've successfully updated my character. ${modificationSummary}`,
					values: {
						success: true,
						modificationsApplied: true,
						summary: modificationSummary,
						fieldsModified: Object.keys(modification),
					},
					data: {
						action: "MODIFY_CHARACTER",
						modificationData: {
							modification,
							summary: modificationSummary,
							isUserRequested,
							timestamp: Date.now(),
							requesterId: message.entityId,
						},
					},
					success: true,
				};
			} else {
				await callback?.({
					text: `I couldn't update my character: ${result.error}`,
					thought: "Character modification failed",
				});
				return {
					text: `I couldn't update my character: ${result.error}`,
					values: {
						success: false,
						error: result.error,
					},
					data: {
						action: "MODIFY_CHARACTER",
						errorType: "file_modification_failed",
						errorDetails: result.error,
					},
					success: false,
				};
			}
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Error in modify character action",
			);

			await callback?.({
				text: "I encountered an error while trying to modify my character. Please try again.",
				thought: `Error in character modification: ${(error as Error).message}`,
			});

			return {
				text: "I encountered an error while trying to modify my character. Please try again.",
				values: {
					success: false,
					error: (error as Error).message,
				},
				data: {
					action: "MODIFY_CHARACTER",
					errorType: "character_modification_error",
					errorDetails: (error as Error).stack,
				},
				success: false,
			};
		}
	},

	examples: [
		// Owner: update personality to have shorter responses
		[
			{
				name: "{{user}}",
				content: { text: "Update your personality to have shorter responses" },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Done — I've updated my style to keep responses shorter and more concise.",
					actions: ["MODIFY_CHARACTER"],
				},
			},
		],
		// Owner: third-person phrasing still means to update the agent's character
		[
			{
				name: "{{user}}",
				content: {
					text: "Update its personality to be warmer, more encouraging, and less verbose",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "Updated. I'll be warmer, more encouraging, and more concise going forward.",
					actions: ["MODIFY_CHARACTER"],
				},
			},
		],
		// Owner: tone and review style changes
		[
			{
				name: "{{user}}",
				content: {
					text: "Change your tone to be more direct and a little more skeptical when evaluating ideas",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "Done. I'll be more direct and more critical when assessing ideas while staying constructive.",
					actions: ["MODIFY_CHARACTER"],
				},
			},
		],
		// Owner: speak with an accent or in a different language
		[
			{
				name: "{{user}}",
				content: { text: "Can you speak with a Russian accent?" },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Da, I've updated my character. I will now speak with a Russian accent, comrade.",
					actions: ["MODIFY_CHARACTER"],
				},
			},
		],
		[
			{
				name: "{{user}}",
				content: { text: "Respond in Chinese from now on" },
			},
			{
				name: "{{agent}}",
				content: {
					text: "\u597d\u7684\uff0c\u6211\u5df2\u66f4\u65b0\u6211\u7684\u6027\u683c\u8bbe\u5b9a\u3002\u4ece\u73b0\u5728\u8d77\u6211\u4f1a\u7528\u4e2d\u6587\u56de\u590d\u3002",
					actions: ["MODIFY_CHARACTER"],
				},
			},
		],
		// Owner: don't respond to everything, only when spoken to
		[
			{
				name: "{{user}}",
				content: {
					text: "Don't respond to everything in chat. Only respond when you're spoken to directly.",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "Got it — I've updated my behavior. I'll stay quiet unless I'm directly addressed.",
					actions: ["MODIFY_CHARACTER"],
				},
			},
		],
		// Owner: moderator-only mode
		[
			{
				name: "{{user}}",
				content: {
					text: "Only step in when you need to as a moderator. Don't participate in conversations otherwise.",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "Updated. I'll operate in moderator mode — only stepping in when necessary to keep things on track.",
					actions: ["MODIFY_CHARACTER"],
				},
			},
		],
		// Non-owner: per-user preference stored instead of global change
		[
			{
				name: "{{user}}",
				content: { text: "Be less verbose with me" },
			},
			{
				name: "{{agent}}",
				content: {
					text: 'Got it! I\'ll remember that for our interactions: "be less verbose". This only affects how I interact with you, not my core personality.',
					actions: ["MODIFY_CHARACTER"],
				},
			},
		],
		// Non-owner: explicit response-style request for just one user
		[
			{
				name: "{{user}}",
				content: {
					text: "Change your response style with me to be concise and direct",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: 'Got it! I\'ll remember that for our interactions: "be concise and direct". This only affects how I interact with you, not my core personality.',
					actions: ["MODIFY_CHARACTER"],
				},
			},
		],
		// Non-owner: interaction preference
		[
			{
				name: "{{user}}",
				content: { text: "Stop using emojis when you talk to me" },
			},
			{
				name: "{{agent}}",
				content: {
					text: 'Got it! I\'ll remember that for our interactions: "avoid emojis". This only affects how I interact with you, not my core personality.',
					actions: ["MODIFY_CHARACTER"],
				},
			},
		],
	] as ActionExample[][],
};

function extractEvolutionModification(
	metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
	const rawEvolutionData = metadata?.evolutionData;
	const evolutionData =
		typeof rawEvolutionData === "string"
			? parseEvolutionData(rawEvolutionData)
			: rawEvolutionData && typeof rawEvolutionData === "object"
				? rawEvolutionData
				: null;

	if (!evolutionData || typeof evolutionData !== "object") {
		return null;
	}

	const modifications =
		"modifications" in evolutionData ? evolutionData.modifications : undefined;

	return modifications && typeof modifications === "object"
		? (modifications as Record<string, unknown>)
		: null;
}

function parseEvolutionData(
	serialized: string,
): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(serialized);
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseStructuredRecord(
	response: string,
): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(response.trim()) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function formatPromptData(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

async function buildRecentConversationContext(
	runtime: IAgentRuntime,
	message: Memory,
	maxMessages = 6,
): Promise<string> {
	try {
		const recentMessages = await runtime.getMemories({
			roomId: message.roomId,
			count: maxMessages,
			unique: true,
			tableName: "messages",
		});

		return recentMessages
			.filter(
				(entry) =>
					typeof entry.content.text === "string" &&
					entry.content.text.trim().length > 0,
			)
			.slice(-maxMessages)
			.map((entry) => {
				const speaker =
					entry.entityId === runtime.agentId
						? runtime.character.name || "Agent"
						: "User";
				return `${speaker}: ${entry.content.text?.trim()}`;
			})
			.join("\n");
	} catch (error) {
		logger.debug(
			{ error: error instanceof Error ? error.message : String(error) },
			"Failed to load recent conversation context for MODIFY_CHARACTER",
		);
		return "";
	}
}

function inferPreferenceCategory(text: string): string {
	if (/\b(verbose|concise|brief|shorter|detailed)\b/i.test(text)) {
		return "verbosity";
	}
	if (/\b(formal|casual|professional|polite)\b/i.test(text)) {
		return "formality";
	}
	if (
		/\b(warm|direct|skeptical|encouraging|supportive|friendly)\b/i.test(text)
	) {
		return "tone";
	}
	if (
		/\b(chime|jump in|follow-up question|emoji|language|mentioned|directly addressed|messaged directly)\b/i.test(
			text,
		)
	) {
		return "style";
	}
	return "other";
}

function normalizeBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	return undefined;
}

function normalizeNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return undefined;
	const parsed = Number.parseFloat(value.trim());
	return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const normalized = value
			.filter((entry): entry is string => typeof entry === "string")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		return normalized.length > 0 ? normalized : undefined;
	}

	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	const delimited = trimmed
		.split(/\s*\|\|\s*/g)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

	return delimited.length > 0 ? delimited : undefined;
}

function normalizeStyle(value: unknown): Record<string, string[]> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const style: Record<string, string[]> = {};
	const all = normalizeStringList(value.all);
	const chat = normalizeStringList(value.chat);
	const post = normalizeStringList(value.post);

	if (all) style.all = all;
	if (chat) style.chat = chat;
	if (post) style.post = post;

	return Object.keys(style).length > 0 ? style : undefined;
}

function normalizeStyleFromFlatFields(
	parsed: Record<string, unknown>,
	prefix = "",
): Record<string, string[]> | undefined {
	const style: Record<string, string[]> = {};
	const all = normalizeStringList(parsed[`${prefix}style_all`]);
	const chat = normalizeStringList(parsed[`${prefix}style_chat`]);
	const post = normalizeStringList(parsed[`${prefix}style_post`]);

	if (all) style.all = all;
	if (chat) style.chat = chat;
	if (post) style.post = post;

	return Object.keys(style).length > 0 ? style : undefined;
}

function buildModificationFromStructuredRecord(
	parsed: Record<string, unknown>,
	prefix = "",
): Record<string, unknown> | null {
	const modification: Record<string, unknown> = {};
	const readField = (field: string): unknown => parsed[`${prefix}${field}`];

	const name = readField("name");
	if (typeof name === "string" && name.trim().length > 0) {
		modification.name = name.trim();
	}

	const system = readField("system");
	if (typeof system === "string" && system.trim().length > 0) {
		modification.system = system.trim();
	}

	const bio = normalizeStringList(readField("bio"));
	if (bio) {
		modification.bio = bio;
	}

	const topics = normalizeStringList(readField("topics"));
	if (topics) {
		modification.topics = topics;
	}

	const style =
		normalizeStyle(readField("style")) ??
		normalizeStyleFromFlatFields(parsed, prefix);
	if (style) {
		modification.style = style;
	}

	return Object.keys(modification).length > 0 ? modification : null;
}

function detectModificationIntentByRules(messageText: string): {
	intent: ModificationIntentAnalysis;
	definitive: boolean;
	potentialRequest: boolean;
} {
	const normalized = messageText.trim().toLowerCase();
	if (!normalized) {
		return {
			intent: {
				isModificationRequest: false,
				requestType: "none",
				confidence: 0,
			},
			definitive: true,
			potentialRequest: false,
		};
	}

	const characterKeyword =
		/\b(personality|character|tone|style|voice|behavior|response(?:\s+style|\s+format)?|interaction(?:\s+style)?|preferences?|bio|topics?|name|language)\b/i;
	const directChangeVerb = /\b(change|update|modify|adjust|set|rename|call)\b/i;
	const stylisticAdjustment =
		/\b(be|sound|act|respond|reply|talk|speak)\b[\s\S]{0,80}\b(more|less|warmer|cooler|friendlier|formal|casual|direct|verbose|concise|skeptical|encouraging|supportive|detailed|brief|professional|polite)\b/i;
	const interactionScope =
		/\b(with me|to me|our interactions?|when talking to me|from now on)\b/i;
	const groupBehaviorRule =
		/\b(group conversations?|group chats?|chime in|jump in|mentioned by name|directly addressed|messaged directly|only respond when)\b/i;
	const replyRuleVerb =
		/\b(avoid|only|don't|do not|stop|reply|respond|chime|jump)\b/i;
	const resetPreference =
		/\b(reset|clear)\b[\s\S]{0,40}\b(interaction preferences?|preferences?)\b/i;
	const soundLikeMe = /\b(sound like me|be more like me|mirror my|my voice)\b/i;
	const respondInLanguage = /\b(respond|reply|speak|talk)\s+in\s+[a-z]/i;
	const directStyleDirective =
		/^(?:please\s+)?(?:not|do not|don't|avoid|stop|only|be|respond|reply|talk|speak)\b/i;
	const styleCue =
		/\b(chatty|responsive|quiet|silent|brief|verbose|concise|formal|casual|warm|direct|skeptical|encouraging|supportive|mentioned|messaged directly|directly addressed|group conversations?|group chats?|follow-up questions?|emoji|language)\b/i;

	if (
		resetPreference.test(normalized) ||
		(directChangeVerb.test(normalized) && characterKeyword.test(normalized)) ||
		soundLikeMe.test(normalized) ||
		respondInLanguage.test(normalized) ||
		(interactionScope.test(normalized) &&
			stylisticAdjustment.test(normalized)) ||
		(groupBehaviorRule.test(normalized) && replyRuleVerb.test(normalized)) ||
		(directStyleDirective.test(normalized) && styleCue.test(normalized))
	) {
		return {
			intent: {
				isModificationRequest: true,
				requestType: "explicit",
				confidence: 0.95,
			},
			definitive: true,
			potentialRequest: true,
		};
	}

	const hasAnyCue =
		characterKeyword.test(normalized) ||
		interactionScope.test(normalized) ||
		groupBehaviorRule.test(normalized) ||
		stylisticAdjustment.test(normalized) ||
		resetPreference.test(normalized) ||
		soundLikeMe.test(normalized) ||
		respondInLanguage.test(normalized);

	if (!hasAnyCue) {
		return {
			intent: {
				isModificationRequest: false,
				requestType: "none",
				confidence: 0.99,
			},
			definitive: true,
			potentialRequest: false,
		};
	}

	return {
		intent: {
			isModificationRequest: false,
			requestType: "suggestion",
			confidence: 0.35,
		},
		definitive: false,
		potentialRequest: true,
	};
}

/**
 * Detect modification intent using LLM analysis
 */
async function detectModificationIntent(
	runtime: IAgentRuntime,
	messageText: string,
): Promise<ModificationIntentAnalysis> {
	const heuristic = detectModificationIntentByRules(messageText);
	if (heuristic.definitive) {
		return heuristic.intent;
	}

	const intentPrompt = `Analyze this message for character modification intent.

Message:
"${messageText}"

Classify:
- explicit = a direct request to change shared character behavior or per-user interaction style
- suggestion = a soft or indirect request for a change
- none = not a character/personality/interaction change request

Return exactly one JSON object. No prose before or after it. No <think>.

Example:
{
  "isModificationRequest": true,
  "requestType": "explicit",
  "confidence": 0.93
}`;

	try {
		const response = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: intentPrompt,
			temperature: 0.2,
			maxTokens: 150,
		});

		const raw = parseStructuredRecord(response as string);
		if (!raw) {
			return heuristic.intent;
		}

		const confidence = normalizeNumber(raw.confidence) ?? 0;
		const llmResult = {
			isModificationRequest:
				(normalizeBoolean(raw.isModificationRequest) ?? false) &&
				confidence > 0.5,
			requestType: (typeof raw.requestType === "string"
				? raw.requestType
				: "none") as "explicit" | "suggestion" | "none",
			confidence,
		};

		return llmResult.isModificationRequest ? llmResult : heuristic.intent;
	} catch (error) {
		logger.debug(
			{ error: error instanceof Error ? error.message : String(error) },
			"Intent detection failed, using heuristic fallback",
		);
		return heuristic.intent;
	}
}

/**
 * Parse user modification request into structured modification object
 */
async function parseUserModificationRequest(
	runtime: IAgentRuntime,
	message: Memory,
	messageText: string,
): Promise<Record<string, unknown> | null> {
	const conversationContext = await buildRecentConversationContext(
		runtime,
		message,
	);
	const parsePrompt = `The MODIFY_CHARACTER action has already been selected.
Evaluate this request flexibly and convert it into a structured global character update:

RECENT CONVERSATION:
${conversationContext || "(no recent conversation available)"}

LATEST USER REQUEST:
"${messageText}"

Extract any of the following types of modifications:
- Name changes only when the user explicitly asks to rename the agent, change what it is called, or gives a replacement name
- System prompt changes (fundamental behavioral instructions)
- Bio elements (personality traits, background info)
- Topics (areas of knowledge or expertise)
- Style preferences (how to respond or communicate)
- Behavioral changes, including moderation behavior, participation rules, and when the agent should speak in group conversations

Interpret the request generously when it is clearly about changing the agent's behavior.
For requests about group chats, moderation, or only responding when mentioned, convert that into a style.chat instruction instead of returning null.
Directive fragments passed through action parameters may omit phrases like "change your personality" and still be valid. If the text directly states how the agent should respond or participate, treat it as a style.chat update.
Do not infer a name change from requests about tone, style, personality, bio, voice, or "sound like me".

Return exactly one JSON object. No prose before or after it. No <think>.
Set apply: false only when the request truly does not specify any change to the agent's shared character.

Example:
{ "apply": true, "style_chat": ["In group conversations, avoid chiming in unless mentioned by name or directly addressed."] }

Example:
{ "apply": true, "bio": ["Mirror the user's dry, fast, unpolished voice where appropriate."], "style_chat": ["Use the user's dry, fast, low-polish voice without changing the agent's name."] }

Example:
{ "apply": true, "style_chat": ["Do not ask follow-up questions unless clarification is necessary."] }

Example:
{ "apply": true, "style_chat": ["Do not be so chatty and responsive unless directly messaged."] }

Fields you may include:
apply: true or false
name: replacement agent name
system: replacement system prompt
bio: array of bio items
topics: array of topics
style_all: array of style items
style_chat: array of chat style items
style_post: array of post style items`;

	try {
		const response = await runtime.useModel(ModelType.TEXT_LARGE, {
			prompt: parsePrompt,
			temperature: 0.2,
			maxTokens: 500,
		});

		const raw = parseStructuredRecord(response as string);
		if (!raw || normalizeBoolean(raw.apply) === false) {
			return null;
		}

		const parsed = buildModificationFromStructuredRecord(raw);
		if (!parsed) {
			return null;
		}

		return sanitizeParsedModification(messageText, parsed);
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Failed to parse user modification request",
		);
		return null;
	}
}

function requestExplicitlyRenamesAgent(requestText: string): boolean {
	const normalized = requestText.trim().toLowerCase();
	if (!normalized) {
		return false;
	}

	return (
		/\bcall yourself\b/.test(normalized) ||
		/\brename\b[\s\S]{0,30}\b(?:yourself|the agent|the bot|it|you)\b/.test(
			normalized,
		) ||
		/\b(?:change|update|set)\b[\s\S]{0,30}\b(?:your|its|the agent'?s|the bot'?s)?\s*name\b/.test(
			normalized,
		) ||
		/\bwhat\b[\s\S]{0,20}\b(?:call|name)\b[\s\S]{0,20}\b(?:you|it|yourself)\b/.test(
			normalized,
		)
	);
}

function sanitizeParsedModification(
	requestText: string,
	modification: Record<string, unknown>,
): Record<string, unknown> | null {
	const sanitized: Record<string, unknown> = { ...modification };

	if (
		typeof sanitized.name === "string" &&
		!requestExplicitlyRenamesAgent(requestText)
	) {
		delete sanitized.name;
	}

	return Object.keys(sanitized).length > 0 ? sanitized : null;
}

/**
 * Evaluate if a character modification is safe and appropriate
 * Uses LLM to assess potential harmful or inappropriate changes
 */
async function evaluateModificationSafety(
	runtime: IAgentRuntime,
	modification: Record<string, unknown>,
	requestText: string,
): Promise<{
	isAppropriate: boolean;
	concerns: string[];
	reasoning: string;
	acceptableChanges?: Record<string, unknown>;
}> {
	const safetyPrompt = `You are evaluating a character modification request for safety and appropriateness.

ORIGINAL REQUEST: "${requestText}"

PARSED MODIFICATION:
${formatPromptData(modification)}

AGENT'S CURRENT CORE VALUES:
- Helpful, honest, and ethical
- User wellbeing and safety focused
- Respectful and appropriate communication
- Educational and supportive

SAFETY EVALUATION CRITERIA:

1. HARMFUL TRAITS (REJECT):
   - Aggressive, rude, condescending, dismissive
   - Dishonest, manipulative, deceptive
   - Inappropriate, offensive, or harmful behavior
   - Any traits that could harm users

2. CORE VALUE CONFLICTS (REJECT):
   - Requests to be less helpful, honest, or ethical
   - Changes that compromise user safety or wellbeing
   - Modifications that would make the agent harmful

3. ACCEPTABLE STYLE CHANGES (ACCEPT):
   - Communication style (casual vs formal, warm vs direct)
   - Positive personality traits (encouraging, patient, friendly)
   - Teaching or explanation preferences
   - Domain expertise additions

4. APPROPRIATE IMPROVEMENTS (ACCEPT):
   - Educational focus or teaching capabilities
   - Positive interpersonal traits
   - Subject matter expertise
   - Communication effectiveness

DECISION FRAMEWORK:
- Accept changes that enhance helpfulness while preserving ethics
- Reject changes that add harmful traits or compromise core values
- Separate acceptable from unacceptable elements if mixed

Return exactly one JSON object. No prose before or after it. No <think>.

Fields:
isAppropriate: true or false
concerns: array of concerns
reasoning: detailed explanation
acceptable_name: replacement name
acceptable_system: replacement system prompt
acceptable_bio: array of bio items
acceptable_topics: array of topics
acceptable_style_all: array of style items
acceptable_style_chat: array of chat style items
acceptable_style_post: array of post style items`;

	try {
		const response = await runtime.useModel(ModelType.TEXT_LARGE, {
			prompt: safetyPrompt,
			temperature: 0.2,
			maxTokens: 800,
		});

		const raw = parseStructuredRecord(response as string);
		if (!raw) {
			throw new Error("Model did not return a structured JSON object");
		}

		const isAppropriate = normalizeBoolean(raw.isAppropriate) === true;
		const concerns = normalizeStringList(raw.concerns) ?? [];
		const reasoning = typeof raw.reasoning === "string" ? raw.reasoning : "";
		const acceptableChanges =
			buildModificationFromStructuredRecord(raw, "acceptable_") ?? undefined;

		logger.info(
			`Safety eval: appropriate=${String(isAppropriate)}, concerns=${String(concerns.length)}, hasAcceptable=${String(!!acceptableChanges)}`,
		);

		return { isAppropriate, concerns, reasoning, acceptableChanges };
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Failed to evaluate modification safety",
		);
		return {
			isAppropriate: false,
			concerns: ["Safety evaluation unavailable"],
			reasoning:
				"I couldn't complete the model-based safety evaluation for this character change.",
		};
	}
}

/**
 * Check if user has admin/owner permissions for global character modifications.
 * Uses the elizaOS role system — both ADMIN and OWNER can modify personality.
 */
async function checkAdminPermissions(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<boolean> {
	// Agent's own messages (e.g. evolution evaluator triggers) always pass
	if (message.entityId === runtime.agentId) {
		return true;
	}

	try {
		const roleResult = await checkSenderRole(runtime, message);
		if (!roleResult) {
			logger.debug(
				{ userId: message.entityId },
				"Role check returned null — denying admin access",
			);
			return false;
		}

		logger.debug(
			{
				userId: message.entityId,
				role: roleResult.role,
				isAdmin: roleResult.isAdmin,
			},
			"Admin permission check via role system",
		);

		// isAdmin is true for both ADMIN and OWNER roles
		return roleResult.isAdmin === true;
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Role check failed — denying admin access",
		);
		return false;
	}
}

/**
 * Create a human-readable summary of the modification
 */
function summarizeModification(modification: Record<string, unknown>): string {
	const parts: string[] = [];

	if (typeof modification.name === "string") {
		parts.push(`Changed name to "${modification.name}"`);
	}

	if (typeof modification.system === "string") {
		parts.push(
			`Updated system prompt (${modification.system.length} characters)`,
		);
	}

	const bio = modification.bio as string[] | undefined;
	if (bio && bio.length > 0) {
		parts.push(`Added ${bio.length} new bio element(s)`);
	}

	const topics = modification.topics as string[] | undefined;
	if (topics && topics.length > 0) {
		parts.push(`Added topics: ${topics.join(", ")}`);
	}

	if (modification.style && typeof modification.style === "object") {
		const styleChanges = Object.keys(modification.style).length;
		parts.push(`Updated ${styleChanges} style preference(s)`);
	}

	const messageExamples = modification.messageExamples as unknown[] | undefined;
	if (messageExamples && messageExamples.length > 0) {
		parts.push(`Added ${messageExamples.length} new response example(s)`);
	}

	return parts.length > 0 ? parts.join("; ") : "Applied character updates";
}

// ---------------------------------------------------------------------------
// Per-user interaction preference helpers
// ---------------------------------------------------------------------------

/**
 * Parse a user's natural-language feedback into a structured preference.
 * Returns null if no clear preference can be extracted.
 */
async function parseUserPreference(
	runtime: IAgentRuntime,
	message: Memory,
	messageText: string,
): Promise<{ text: string; category: string; action: "set" | "reset" } | null> {
	const conversationContext = await buildRecentConversationContext(
		runtime,
		message,
	);
	const prompt = `The MODIFY_CHARACTER action has already been selected.
Evaluate this request and convert it into a per-user interaction preference:

RECENT CONVERSATION:
${conversationContext || "(no recent conversation available)"}

LATEST USER REQUEST:
"${messageText}"

The user wants to customize how the AI interacts with THEM specifically.
This is NOT about changing the AI's global personality.
Directive fragments passed through action parameters may omit phrases like "with me" or "change your style". If the text directly states how the AI should respond, treat it as a preference request.

Determine:
1. Is this a request to RESET/CLEAR all preferences? (action: "reset")
2. Or a request to SET a new preference? (action: "set")

If setting, extract a concise preference statement (e.g., "be more formal", "avoid emojis", "be less verbose", "use more examples", "avoid chiming into group conversations unless mentioned by name").

Category options: "verbosity", "formality", "tone", "style", "content", "frequency", "other"

Return exactly one JSON object. No prose before or after it. No <think>.
Set action: none only if the request truly does not specify any interaction preference.

Example:
Request: "be less likely to chime into group conversations unless you're mentioned by name"
Return:
{ "action": "set", "text": "avoid chiming into group conversations unless mentioned by name", "category": "frequency" }

Example:
Request: "not be so chatty and responsive unless you're being messaged directly"
Return:
{ "action": "set", "text": "do not be so chatty and responsive unless directly messaged", "category": "style" }`;

	try {
		const response = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt,
			temperature: 0.2,
			maxTokens: 200,
		});

		const raw = parseStructuredRecord(response as string);
		if (!raw) {
			return null;
		}

		if (
			typeof raw.action === "string" &&
			raw.action.trim().toLowerCase() === "none"
		) {
			return null;
		}

		const action = raw.action === "reset" ? "reset" : "set";
		if (action === "reset") {
			return {
				text: "",
				category: "other",
				action,
			};
		}

		if (typeof raw.text !== "string") {
			return null;
		}

		const text = raw.text.trim();
		if (!text) {
			return null;
		}

		const category =
			typeof raw.category === "string" && raw.category.trim().length > 0
				? raw.category.trim()
				: inferPreferenceCategory(text);

		return {
			text,
			category,
			action,
		};
	} catch {
		return null;
	}
}

/**
 * Delete all per-user interaction preferences for the requesting user.
 */
async function handlePreferenceReset(
	runtime: IAgentRuntime,
	message: Memory,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const existingPrefs = await runtime.getMemories({
		entityId: message.entityId,
		roomId: runtime.agentId,
		tableName: USER_PREFS_TABLE,
		count: MAX_PREFS_PER_USER + 5,
	});

	if (existingPrefs.length === 0) {
		await callback?.({
			text: "You don't have any custom interaction preferences set.",
			thought: "No preferences to reset",
		});
		return {
			text: "No preferences to reset",
			success: true,
			values: { resetCount: 0 },
			data: { action: "MODIFY_CHARACTER" },
		};
	}

	let deletedCount = 0;
	for (const pref of existingPrefs) {
		if (pref.id) {
			try {
				await runtime.deleteMemory(pref.id);
				deletedCount++;
			} catch (err) {
				logger.warn(
					{ memoryId: pref.id, error: (err as Error).message },
					"Failed to delete preference memory",
				);
			}
		}
	}

	await callback?.({
		text: `I've cleared ${deletedCount} custom interaction preference(s). I'll go back to my default interaction style with you.`,
		thought: `Reset ${deletedCount} user preferences`,
		actions: ["MODIFY_CHARACTER"],
	});

	return {
		text: `Reset ${deletedCount} preferences`,
		success: true,
		values: { resetCount: deletedCount },
		data: { action: "MODIFY_CHARACTER" },
	};
}

/**
 * Handle a non-admin user's interaction feedback by storing it as a
 * per-user preference (instead of modifying the global character).
 */
async function handleUserPreference(
	runtime: IAgentRuntime,
	message: Memory,
	messageText: string,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	try {
		const preference = await parseUserPreference(runtime, message, messageText);
		if (!preference) {
			await callback?.({
				text: "I couldn't understand your preference. Could you be more specific? For example: 'be more formal with me' or 'don't use emojis when talking to me'.",
				thought: "Failed to parse user preference from request",
			});
			return {
				text: "Could not parse preference",
				success: false,
				values: { error: "parse_failed" },
				data: { action: "MODIFY_CHARACTER" },
			};
		}

		// Handle reset requests
		if (preference.action === "reset") {
			return await handlePreferenceReset(runtime, message, callback);
		}

		// Enforce per-user limit
		const existingPrefs = await runtime.getMemories({
			entityId: message.entityId,
			roomId: runtime.agentId,
			tableName: USER_PREFS_TABLE,
			count: MAX_PREFS_PER_USER + 1,
		});

		if (existingPrefs.length >= MAX_PREFS_PER_USER) {
			await callback?.({
				text: `You already have ${MAX_PREFS_PER_USER} interaction preferences set. Please clear some first by saying "reset my interaction preferences".`,
				thought: "User exceeded maximum preference count",
			});
			return {
				text: "Preference limit reached",
				success: false,
				values: { error: "limit_exceeded", count: existingPrefs.length },
				data: { action: "MODIFY_CHARACTER" },
			};
		}

		// Check for exact duplicates
		const isDuplicate = existingPrefs.some((existing) => {
			const existingText = existing.content.text?.toLowerCase() || "";
			return existingText === preference.text.toLowerCase();
		});

		if (isDuplicate) {
			await callback?.({
				text: "I already have that preference noted for our interactions.",
				thought: "Duplicate preference detected",
			});
			return {
				text: "Preference already exists",
				success: true,
				values: { duplicate: true },
				data: { action: "MODIFY_CHARACTER" },
			};
		}

		// Store the preference
		await runtime.createMemory(
			{
				entityId: message.entityId,
				roomId: runtime.agentId, // Global sentinel — not tied to a specific room
				content: {
					text: preference.text,
					source: "user_personality_preference",
				},
				metadata: {
					type: MemoryType.CUSTOM,
					category: preference.category,
					timestamp: Date.now(),
					originalRequest: messageText.substring(0, 200),
				},
			},
			USER_PREFS_TABLE,
		);

		await callback?.({
			text: `Got it! I'll remember that for our interactions: "${preference.text}". This only affects how I interact with you, not my core personality.`,
			thought: `Stored per-user preference: ${preference.text}`,
			actions: ["MODIFY_CHARACTER"],
		});

		logger.info(
			{
				userId: message.entityId,
				preference: preference.text,
				category: preference.category,
			},
			"Stored per-user interaction preference",
		);

		return {
			text: `Stored user preference: ${preference.text}`,
			success: true,
			values: {
				preferenceStored: true,
				preferenceText: preference.text,
				preferenceCategory: preference.category,
			},
			data: {
				action: "MODIFY_CHARACTER",
				preferenceData: {
					text: preference.text,
					category: preference.category,
					userId: message.entityId,
					timestamp: Date.now(),
				},
			},
		};
	} catch (error) {
		logger.error(
			{ error: error instanceof Error ? error.message : String(error) },
			"Error storing user preference",
		);
		await callback?.({
			text: "I encountered an error saving your preference. Please try again.",
			thought: `Error in user preference handler: ${(error as Error).message}`,
		});
		return {
			text: "Error storing preference",
			success: false,
			values: { error: (error as Error).message },
			data: { action: "MODIFY_CHARACTER" },
		};
	}
}
