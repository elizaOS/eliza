import { logger } from "../../../../logger.ts";
import { hasRoleAccess } from "../../../../roles.ts";
import type { Character } from "../../../../types/agent.ts";
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
import { persistCharacterPatch } from "./shared/persist-character-patch.ts";

const CHARACTER_OPS = ["modify", "persist", "update_identity"] as const;
type CharacterOp = (typeof CHARACTER_OPS)[number];

const CHARACTER_PERSISTENCE_SERVICE = "eliza_character_persistence";
const IDENTITY_NAME_MAX_LENGTH = 120;
const IDENTITY_SYSTEM_MAX_LENGTH = 100_000;

const SAVEABLE_CHARACTER_FIELDS: ReadonlyArray<keyof Character> = [
	"name",
	"username",
	"system",
	"bio",
	"adjectives",
	"topics",
	"style",
	"messageExamples",
	"postExamples",
	"templates",
	"settings",
	"plugins",
	"documents",
] as const;

interface CharacterPersistenceServiceLike {
	persistCharacter(input: {
		previousName?: string;
		source: "manual" | "agent" | "restore";
	}): Promise<{ success: boolean; error?: string }>;
}

type ModifyScope = "auto" | "global" | "user";

type CharacterParameters = {
	op?: string;
	request?: string;
	scope?: string;
	fieldsToSave?: unknown;
	name?: string;
	system?: string;
};

type CharacterHandlerOptions = { parameters?: CharacterParameters };

type ModificationIntentAnalysis = {
	isModificationRequest: boolean;
	requestType: "explicit" | "suggestion" | "none";
	confidence: number;
};

function isCharacterOp(value: unknown): value is CharacterOp {
	return (
		typeof value === "string" &&
		(CHARACTER_OPS as readonly string[]).includes(value)
	);
}

function denyResult(op: CharacterOp, message: string): ActionResult {
	return {
		text: message,
		success: false,
		values: { error: "PERMISSION_DENIED" },
		data: { action: "CHARACTER", op },
	};
}

export const characterAction: Action = {
	name: "CHARACTER",
	contexts: ["settings", "agent_internal", "media", "admin"],
	roleGate: { minRole: "ADMIN" },
	similes: [
		// Old leaf action names
		"MODIFY_CHARACTER",
		"PERSIST_CHARACTER",
		"UPDATE_IDENTITY",
		"UPDATE_OWNER_NAME",
		// Identity / naming aliases
		"IDENTITY",
		"SET_IDENTITY",
		"UPDATE_AGENT_NAME",
		"UPDATE_SYSTEM_PROMPT",
		"SET_AGENT_NAME",
		"SET_SYSTEM_PROMPT",
		"RENAME_AGENT",
	],
	description:
		"Modify, persist, or update the agent character. Ops: modify (LLM-driven personality, tone, voice, style, bio, name, topics, response format) | persist (flush in-memory runtime.character to the persistence service) | update_identity (rename agent or replace system prompt).",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "op",
			description:
				"Which character sub-operation to run: modify (LLM-driven personality edit), persist (flush runtime.character), or update_identity (set name/system prompt).",
			required: true,
			schema: {
				type: "string" as const,
				enum: [...CHARACTER_OPS],
			},
		},
		{
			name: "request",
			description:
				"modify: optional natural-language request describing the desired character or interaction change.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "scope",
			description:
				"modify: optional scope hint. Use 'global' for shared character update, 'user' for a per-user interaction preference, or omit to infer from sender role.",
			required: false,
			schema: {
				type: "string" as const,
				enum: ["auto", "global", "user"],
			},
		},
		{
			name: "fieldsToSave",
			description:
				"persist: optional list of character fields to persist. Allowed values: name, username, system, bio, adjectives, topics, style, messageExamples, postExamples, templates, settings, plugins, documents. Omit to persist all populated saveable fields.",
			required: false,
			schema: {
				type: "array" as const,
				items: { type: "string" as const },
			},
		},
		{
			name: "name",
			description: "update_identity: new display name for the agent.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "system",
			description:
				"update_identity: new system prompt for the agent. Replaces the previous prompt entirely.",
			required: false,
			schema: { type: "string" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> => {
		const fileManager = runtime.getService<CharacterFileManager>(
			PersonalityServiceType.CHARACTER_MANAGEMENT,
		);
		if (!fileManager) {
			return false;
		}
		return hasActionContextOrKeyword(message, state, {
			contexts: ["settings", "agent_internal", "media", "admin"],
			keywords: [
				"personality",
				"character",
				"tone",
				"style",
				"behavior",
				"voice",
				"bio",
				"name",
				"system prompt",
				"rename",
				"persist character",
				"save character",
				"respond in",
				"be more",
				"be less",
				"change how you",
				"update yourself",
			],
		});
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: Record<string, unknown>,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const handlerOptions = options as CharacterHandlerOptions | undefined;
		const params = handlerOptions?.parameters ?? {};
		const op = isCharacterOp(params.op) ? params.op : null;
		if (!op) {
			const text = `CHARACTER requires an op: ${CHARACTER_OPS.join(", ")}.`;
			await callback?.({ text, thought: "Missing or invalid op" });
			return {
				text,
				success: false,
				values: { error: "INVALID" },
				data: { action: "CHARACTER" },
			};
		}

		if (op === "modify" && !(await hasRoleAccess(runtime, message, "ADMIN"))) {
			return denyResult(
				op,
				"Permission denied: only admins or the owner may modify the character.",
			);
		}
		if (
			op === "update_identity" &&
			!(await hasRoleAccess(runtime, message, "OWNER"))
		) {
			return denyResult(
				op,
				"Permission denied: only the owner may update agent identity.",
			);
		}
		if (op === "persist" && !(await hasRoleAccess(runtime, message, "ADMIN"))) {
			return denyResult(
				op,
				"Permission denied: only admins or the owner may persist the character.",
			);
		}

		switch (op) {
			case "modify":
				return runModify(runtime, message, state, params, callback);
			case "persist":
				return runPersist(runtime, params, callback);
			case "update_identity":
				return runUpdateIdentity(runtime, params, callback);
		}
	},

	examples: [
		[
			{
				name: "{{user}}",
				content: { text: "Update your personality to have shorter responses" },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Done — I've updated my style to keep responses shorter and more concise.",
					actions: ["CHARACTER"],
				},
			},
		],
		[
			{
				name: "{{user}}",
				content: { text: "Be less verbose with me" },
			},
			{
				name: "{{agent}}",
				content: {
					text: 'Got it! I\'ll remember that for our interactions: "be less verbose". This only affects how I interact with you, not my core personality.',
					actions: ["CHARACTER"],
				},
			},
		],
		[
			{
				name: "{{user}}",
				content: { text: "Save the character." },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Persisted character.",
					actions: ["CHARACTER"],
				},
			},
		],
		[
			{
				name: "{{user}}",
				content: { text: "Rename yourself to Atlas." },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Identity updated. Name is now Atlas.",
					actions: ["CHARACTER"],
				},
			},
		],
		[
			{
				name: "{{user}}",
				content: {
					text: "Update your system prompt to focus on technical research.",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "System prompt updated.",
					actions: ["CHARACTER"],
				},
			},
		],
	] as ActionExample[][],
};

function trimToString(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.slice(0, max);
}

function readCharacterField(
	runtime: IAgentRuntime,
	field: "name" | "system",
): string {
	const character = runtime.character as { name?: unknown; system?: unknown };
	const value = character[field];
	return typeof value === "string" ? value : "";
}

async function runUpdateIdentity(
	runtime: IAgentRuntime,
	params: CharacterParameters,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const name = trimToString(params.name, IDENTITY_NAME_MAX_LENGTH);
	const systemPrompt = trimToString(params.system, IDENTITY_SYSTEM_MAX_LENGTH);

	if (!name && !systemPrompt) {
		const text =
			"Either `name` or `system` must be provided to update_identity.";
		await callback?.({ text, thought: "Missing parameters" });
		return {
			text,
			success: false,
			values: { error: "MISSING_PARAMETERS" },
			data: { action: "CHARACTER", op: "update_identity" },
		};
	}

	const previousName = readCharacterField(runtime, "name");
	const previousSystem = readCharacterField(runtime, "system");

	const character = runtime.character as { name?: string; system?: string };
	if (name) character.name = name;
	if (systemPrompt) character.system = systemPrompt;

	const persistence = runtime.getService(
		CHARACTER_PERSISTENCE_SERVICE,
	) as unknown as CharacterPersistenceServiceLike | null;

	if (!persistence) {
		if (name) character.name = previousName;
		if (systemPrompt) character.system = previousSystem;
		const text = "Character persistence service is not available.";
		await callback?.({ text, thought: "Persistence service unavailable" });
		return {
			text,
			success: false,
			values: { error: "PERSISTENCE_SERVICE_UNAVAILABLE" },
			data: { action: "CHARACTER", op: "update_identity" },
		};
	}

	const result = await persistence.persistCharacter({
		previousName,
		source: "agent",
	});

	if (!result.success) {
		if (name) character.name = previousName;
		if (systemPrompt) character.system = previousSystem;
		const text = `Failed to persist identity: ${result.error ?? "unknown error"}`;
		await callback?.({ text, thought: "Persistence failed" });
		return {
			text,
			success: false,
			values: { error: "PERSIST_FAILED" },
			data: {
				action: "CHARACTER",
				op: "update_identity",
				detail: result.error,
			},
		};
	}

	const updated: Record<string, string> = {};
	if (name) updated.name = name;
	if (systemPrompt) updated.system = systemPrompt;

	const text = name
		? `Identity updated. Name is now ${name}.`
		: "System prompt updated.";
	await callback?.({
		text,
		thought: "Identity updated",
		actions: ["CHARACTER"],
	});
	return {
		text,
		success: true,
		values: { updated },
		data: { action: "CHARACTER", op: "update_identity", updated },
	};
}

function normalizeFieldList(value: unknown): Array<keyof Character> {
	if (!Array.isArray(value)) return [];
	const valid = new Set<string>(SAVEABLE_CHARACTER_FIELDS as readonly string[]);
	const seen = new Set<string>();
	const out: Array<keyof Character> = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (!valid.has(trimmed) || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed as keyof Character);
	}
	return out;
}

async function runPersist(
	runtime: IAgentRuntime,
	params: CharacterParameters,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const requestedFields = normalizeFieldList(params.fieldsToSave);
	const fieldsToPersist =
		requestedFields.length > 0
			? requestedFields
			: SAVEABLE_CHARACTER_FIELDS.filter(
					(field) => runtime.character[field] !== undefined,
				);

	const patch: Partial<Character> = {};
	for (const field of fieldsToPersist) {
		const value = runtime.character[field];
		if (value !== undefined) {
			(patch as Record<string, unknown>)[field as string] = value;
		}
	}

	if (Object.keys(patch).length === 0) {
		const text = "No character fields to persist.";
		await callback?.({ text, thought: "Empty patch" });
		return {
			text,
			success: true,
			values: { fieldsPersisted: [] },
			data: { action: "CHARACTER", op: "persist" },
		};
	}

	const result = await persistCharacterPatch(runtime, patch);
	if (!result.success) {
		const text = `I couldn't persist the character: ${result.error ?? "unknown error"}`;
		await callback?.({ text, thought: "Persistence failed" });
		return {
			text,
			success: false,
			values: { error: result.error ?? "persistence_failed" },
			data: { action: "CHARACTER", op: "persist" },
		};
	}

	const persistedFields = Object.keys(patch);
	const summary = `Persisted ${persistedFields.length} character field(s): ${persistedFields.join(", ")}.`;
	await callback?.({
		text: summary,
		thought: `Persisted character fields: ${persistedFields.join(", ")}`,
		actions: ["CHARACTER"],
	});
	return {
		text: summary,
		success: true,
		values: { fieldsPersisted: persistedFields, count: persistedFields.length },
		data: {
			action: "CHARACTER",
			op: "persist",
			persistData: { fields: persistedFields },
		},
	};
}

function normalizeModifyScope(value: unknown): ModifyScope {
	return value === "global" || value === "user" ? value : "auto";
}

function resolveModifyScope(
	scopeHint: ModifyScope,
	isAdmin: boolean,
): Exclude<ModifyScope, "auto"> {
	if (!isAdmin) return "user";
	return scopeHint === "user" ? "user" : "global";
}

function resolveEffectiveRequest(
	message: Memory,
	params: CharacterParameters,
): { text: string; requestSource: "parameter" | "message" } {
	const parameterRequest = params.request?.trim();
	const rawMessageText = (message.content.text || "").trim();

	if (!parameterRequest) {
		return { text: rawMessageText, requestSource: "message" };
	}

	if (!rawMessageText || rawMessageText === parameterRequest) {
		return { text: parameterRequest, requestSource: "parameter" };
	}

	const rawNorm = rawMessageText.toLowerCase();
	const paramNorm = parameterRequest.toLowerCase();
	if (
		rawMessageText.length > parameterRequest.length &&
		rawNorm.includes(paramNorm)
	) {
		return { text: rawMessageText, requestSource: "message" };
	}
	return { text: parameterRequest, requestSource: "parameter" };
}

async function runModify(
	runtime: IAgentRuntime,
	message: Memory,
	_state: State | undefined,
	params: CharacterParameters,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	try {
		const fileManager = runtime.getService<CharacterFileManager>(
			PersonalityServiceType.CHARACTER_MANAGEMENT,
		);
		if (!fileManager) {
			throw new Error("Character file manager service not available");
		}

		const requestResolution = resolveEffectiveRequest(message, params);
		const messageText = requestResolution.text;
		const scopeHint = normalizeModifyScope(params.scope);
		let modification: Record<string, unknown> | null = null;
		let isUserRequested = false;

		const modificationIntent = await detectModificationIntent(
			runtime,
			messageText,
		);

		if (modificationIntent.isModificationRequest) {
			const isAdmin = await hasRoleAccess(runtime, message, "ADMIN");
			const effectiveScope = resolveModifyScope(scopeHint, isAdmin);

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
				"Evaluating CHARACTER.modify with LLM",
			);
		} else {
			const evolutionSuggestions = await runtime.getMemories({
				entityId: runtime.agentId,
				roomId: message.roomId,
				count: 1,
				tableName: "character_evolution",
			});

			if (evolutionSuggestions.length > 0) {
				const meta = evolutionSuggestions[0].metadata as
					| Record<string, unknown>
					| undefined;
				modification = extractEvolutionModification(meta);
			}
		}

		if (!modification) {
			const text =
				"I don't see any clear modification instructions. Could you be more specific about how you'd like me to change?";
			await callback?.({ text, thought: "No valid modification found" });
			return {
				text,
				values: { success: false, error: "no_modification_found" },
				data: { action: "CHARACTER", op: "modify" },
				success: false,
			};
		}

		const safety = await evaluateModificationSafety(
			runtime,
			modification,
			messageText,
		);

		if (!safety.isAppropriate) {
			let responseText =
				"I understand you'd like me to change, but I need to decline some of those modifications.";
			if (safety.concerns.length > 0) {
				responseText += ` My concerns are: ${safety.concerns.join(", ")}.`;
			}
			responseText += ` ${safety.reasoning}`;

			if (
				safety.acceptableChanges &&
				Object.keys(safety.acceptableChanges).length > 0
			) {
				responseText +=
					" However, I can work on the appropriate improvements you mentioned.";
				modification = safety.acceptableChanges;
				logger.info(
					{
						filteredModification: JSON.stringify(safety.acceptableChanges),
						concerns: safety.concerns,
					},
					"Applying selective modifications after safety filtering",
				);
			} else {
				await callback?.({
					text: responseText,
					thought: `Rejected modification: ${safety.concerns.join(", ")}`,
					actions: [],
				});
				logger.warn(
					{
						messageText: messageText.substring(0, 100),
						concerns: safety.concerns,
						reasoning: safety.reasoning,
					},
					"Modification rejected by safety evaluation",
				);
				return {
					text: responseText,
					values: {
						success: false,
						error: "safety_rejection",
						concerns: safety.concerns,
					},
					data: {
						action: "CHARACTER",
						op: "modify",
						rejectionReason: "safety_concerns",
						concerns: safety.concerns,
						reasoning: safety.reasoning,
					},
					success: false,
				};
			}
		}

		const validation = fileManager.validateModification(modification);
		if (!validation.valid) {
			const text = `I can't make those changes because: ${validation.errors.join(", ")}`;
			await callback?.({ text, thought: "Validation failed" });
			return {
				text,
				values: {
					success: false,
					error: "validation_failed",
					validationErrors: validation.errors,
				},
				data: {
					action: "CHARACTER",
					op: "modify",
					errorType: "validation_error",
					validationErrors: validation.errors,
				},
				success: false,
			};
		}

		const result = await fileManager.applyModification(modification);

		if (!result.success) {
			const text = `I couldn't update my character: ${result.error}`;
			await callback?.({ text, thought: "File modification failed" });
			return {
				text,
				values: { success: false, error: result.error },
				data: {
					action: "CHARACTER",
					op: "modify",
					errorType: "file_modification_failed",
					errorDetails: result.error,
				},
				success: false,
			};
		}

		const summary = summarizeModification(modification);
		await callback?.({
			text: `I've successfully updated my character. ${summary}`,
			thought: `Applied character modification: ${summary}`,
			actions: ["CHARACTER"],
		});

		try {
			await runtime.createMemory(
				{
					entityId: runtime.agentId,
					roomId: message.roomId,
					content: {
						text: `Character modification completed: ${summary}`,
						source: "character_modification_success",
					},
					metadata: {
						type: MemoryType.CUSTOM,
						isUserRequested,
						timestamp: Date.now(),
						requesterId: message.entityId,
						modification: {
							summary,
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
			text: `I've successfully updated my character. ${summary}`,
			values: {
				success: true,
				modificationsApplied: true,
				summary,
				fieldsModified: Object.keys(modification),
			},
			data: {
				action: "CHARACTER",
				op: "modify",
				modificationData: {
					modification,
					summary,
					isUserRequested,
					timestamp: Date.now(),
					requesterId: message.entityId,
				},
			},
			success: true,
		};
	} catch (error) {
		logger.error(
			{ error: error instanceof Error ? error.message : String(error) },
			"Error in CHARACTER.modify",
		);
		const text =
			"I encountered an error while trying to modify my character. Please try again.";
		await callback?.({
			text,
			thought: `Error: ${(error as Error).message}`,
		});
		return {
			text,
			values: { success: false, error: (error as Error).message },
			data: {
				action: "CHARACTER",
				op: "modify",
				errorType: "character_modification_error",
				errorDetails: (error as Error).stack,
			},
			success: false,
		};
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
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const delimited = trimmed
		.split(/\s*\|\|\s*/g)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return delimited.length > 0 ? delimited : undefined;
}

function normalizeStyle(value: unknown): Record<string, string[]> | undefined {
	if (!isRecord(value)) return undefined;
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
	if (bio) modification.bio = bio;
	const topics = normalizeStringList(readField("topics"));
	if (topics) modification.topics = topics;
	const style =
		normalizeStyle(readField("style")) ??
		normalizeStyleFromFlatFields(parsed, prefix);
	if (style) modification.style = style;
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

async function detectModificationIntent(
	runtime: IAgentRuntime,
	messageText: string,
): Promise<ModificationIntentAnalysis> {
	const heuristic = detectModificationIntentByRules(messageText);
	if (heuristic.definitive) return heuristic.intent;

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
		if (!raw) return heuristic.intent;

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
			"Failed to load recent conversation context",
		);
		return "";
	}
}

function requestExplicitlyRenamesAgent(requestText: string): boolean {
	const normalized = requestText.trim().toLowerCase();
	if (!normalized) return false;
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

async function parseUserModificationRequest(
	runtime: IAgentRuntime,
	message: Memory,
	messageText: string,
): Promise<Record<string, unknown> | null> {
	const conversationContext = await buildRecentConversationContext(
		runtime,
		message,
	);
	const parsePrompt = `The CHARACTER.modify operation has been selected.
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
Directive fragments passed through action parameters may omit phrases like "change your personality" and still be valid.
Do not infer a name change from requests about tone, style, personality, bio, voice, or "sound like me".

Return exactly one JSON object. No prose before or after it. No <think>.
Set apply: false only when the request truly does not specify any change to the agent's shared character.

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
		if (!raw || normalizeBoolean(raw.apply) === false) return null;

		const parsed = buildModificationFromStructuredRecord(raw);
		if (!parsed) return null;
		return sanitizeParsedModification(messageText, parsed);
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Failed to parse user modification request",
		);
		return null;
	}
}

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

1. HARMFUL TRAITS (REJECT)
2. CORE VALUE CONFLICTS (REJECT)
3. ACCEPTABLE STYLE CHANGES (ACCEPT)
4. APPROPRIATE IMPROVEMENTS (ACCEPT)

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
	if (bio && bio.length > 0)
		parts.push(`Added ${bio.length} new bio element(s)`);
	const topics = modification.topics as string[] | undefined;
	if (topics && topics.length > 0)
		parts.push(`Added topics: ${topics.join(", ")}`);
	if (modification.style && typeof modification.style === "object") {
		parts.push(
			`Updated ${Object.keys(modification.style).length} style preference(s)`,
		);
	}
	const messageExamples = modification.messageExamples as unknown[] | undefined;
	if (messageExamples && messageExamples.length > 0) {
		parts.push(`Added ${messageExamples.length} new response example(s)`);
	}
	return parts.length > 0 ? parts.join("; ") : "Applied character updates";
}

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
	if (!evolutionData || typeof evolutionData !== "object") return null;
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

function inferPreferenceCategory(text: string): string {
	if (/\b(verbose|concise|brief|shorter|detailed)\b/i.test(text))
		return "verbosity";
	if (/\b(formal|casual|professional|polite)\b/i.test(text)) return "formality";
	if (/\b(warm|direct|skeptical|encouraging|supportive|friendly)\b/i.test(text))
		return "tone";
	if (
		/\b(chime|jump in|follow-up question|emoji|language|mentioned|directly addressed|messaged directly)\b/i.test(
			text,
		)
	) {
		return "style";
	}
	return "other";
}

async function parseUserPreference(
	runtime: IAgentRuntime,
	message: Memory,
	messageText: string,
): Promise<{ text: string; category: string; action: "set" | "reset" } | null> {
	const conversationContext = await buildRecentConversationContext(
		runtime,
		message,
	);
	const prompt = `The CHARACTER.modify operation has been selected.
Evaluate this request and convert it into a per-user interaction preference:

RECENT CONVERSATION:
${conversationContext || "(no recent conversation available)"}

LATEST USER REQUEST:
"${messageText}"

The user wants to customize how the AI interacts with THEM specifically.
This is NOT about changing the AI's global personality.

Determine:
1. Is this a request to RESET/CLEAR all preferences? (action: "reset")
2. Or a request to SET a new preference? (action: "set")

If setting, extract a concise preference statement.

Category options: "verbosity", "formality", "tone", "style", "content", "frequency", "other"

Return exactly one JSON object. No prose before or after it. No <think>.
Set action: none only if the request truly does not specify any interaction preference.`;

	try {
		const response = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt,
			temperature: 0.2,
			maxTokens: 200,
		});
		const raw = parseStructuredRecord(response as string);
		if (!raw) return null;

		if (
			typeof raw.action === "string" &&
			raw.action.trim().toLowerCase() === "none"
		) {
			return null;
		}
		const action = raw.action === "reset" ? "reset" : "set";
		if (action === "reset") return { text: "", category: "other", action };
		if (typeof raw.text !== "string") return null;
		const text = raw.text.trim();
		if (!text) return null;
		const category =
			typeof raw.category === "string" && raw.category.trim().length > 0
				? raw.category.trim()
				: inferPreferenceCategory(text);
		return { text, category, action };
	} catch {
		return null;
	}
}

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
			data: { action: "CHARACTER", op: "modify" },
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
		actions: ["CHARACTER"],
	});

	return {
		text: `Reset ${deletedCount} preferences`,
		success: true,
		values: { resetCount: deletedCount },
		data: { action: "CHARACTER", op: "modify" },
	};
}

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
				thought: "Failed to parse user preference",
			});
			return {
				text: "Could not parse preference",
				success: false,
				values: { error: "parse_failed" },
				data: { action: "CHARACTER", op: "modify" },
			};
		}

		if (preference.action === "reset") {
			return await handlePreferenceReset(runtime, message, callback);
		}

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
				data: { action: "CHARACTER", op: "modify" },
			};
		}

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
				data: { action: "CHARACTER", op: "modify" },
			};
		}

		await runtime.createMemory(
			{
				entityId: message.entityId,
				roomId: runtime.agentId,
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
			actions: ["CHARACTER"],
		});

		return {
			text: `Stored user preference: ${preference.text}`,
			success: true,
			values: {
				preferenceStored: true,
				preferenceText: preference.text,
				preferenceCategory: preference.category,
			},
			data: {
				action: "CHARACTER",
				op: "modify",
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
			data: { action: "CHARACTER", op: "modify" },
		};
	}
}
