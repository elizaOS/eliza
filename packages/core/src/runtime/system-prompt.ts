/**
 * System-prompt assembly for a model call: builds the canonical prompt from a
 * character's `system` + `bio` (name-token expanded) plus the caller's role, and
 * resolves the effective system prompt from explicit params, a leading `system`
 * chat message, or a fallback while preserving every valid source byte and
 * message entry. Also renders the character's static chat style directions for
 * the v5 stable prefix.
 */

import { ElizaError } from "../errors";
import { replaceNameTokens } from "../name-tokens";
import type { Character } from "../types/agent";
import type { RoleGateRole } from "../types/contexts";
import type { ChatMessage } from "../types/model";

type MessageLike = {
	role?: unknown;
	content?: unknown;
};

export function renderSystemPromptBio(value: unknown): string {
	if (value === undefined) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (!Array.isArray(value)) {
		throw new ElizaError("System prompt bio must be a string or string array", {
			code: "SYSTEM_PROMPT_BIO_INVALID",
			context: { receivedType: value === null ? "null" : typeof value },
			severity: "fatal",
		});
	}
	return value
		.map((entry, index) => {
			if (typeof entry !== "string") {
				throw new ElizaError("System prompt bio entry must be a string", {
					code: "SYSTEM_PROMPT_BIO_INVALID",
					context: {
						index,
						receivedType: entry === null ? "null" : typeof entry,
					},
					severity: "fatal",
				});
			}
			return entry;
		})
		.join(" ");
}

export function normalizeSystemPromptRole(
	role: RoleGateRole | string | null | undefined,
): string | undefined {
	const normalized = typeof role === "string" ? role.trim().toUpperCase() : "";
	return normalized || undefined;
}

export function buildCanonicalSystemPrompt(args: {
	character?: Pick<Character, "name" | "system" | "bio"> | null;
	userRole?: RoleGateRole | string | null;
}): string {
	const character = args.character;
	let name = "the agent";
	if (character) {
		if (
			typeof character.name !== "string" ||
			character.name.trim().length === 0
		) {
			throw new ElizaError("System prompt character name must be nonblank", {
				code: "SYSTEM_PROMPT_CHARACTER_NAME_INVALID",
				severity: "fatal",
			});
		}
		name = character.name;
	}
	if (character?.system !== undefined && typeof character.system !== "string") {
		throw new ElizaError("System prompt character system must be a string", {
			code: "SYSTEM_PROMPT_SYSTEM_INVALID",
			context: { receivedType: typeof character.system },
			severity: "fatal",
		});
	}
	const system = replaceNameTokens(character?.system ?? "", name);
	const bio = replaceNameTokens(renderSystemPromptBio(character?.bio), name);
	const role = normalizeSystemPromptRole(args.userRole);
	const sections: string[] = [];
	if (system.length > 0) sections.push(system);
	if (bio.length > 0) sections.push(`# About ${name}\n${bio}`);
	if (role) sections.push(`user_role: ${role}`);
	return sections.join("\n\n");
}

function renderStyleRules(value: unknown, field: string): string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new ElizaError("System prompt style rules must be an array", {
			code: "SYSTEM_PROMPT_STYLE_INVALID",
			context: { field, receivedType: typeof value },
			severity: "fatal",
		});
	}
	return value.map((entry, index) => {
		if (typeof entry !== "string") {
			throw new ElizaError("System prompt style rule must be a string", {
				code: "SYSTEM_PROMPT_STYLE_INVALID",
				context: {
					field,
					index,
					receivedType: entry === null ? "null" : typeof entry,
				},
				severity: "fatal",
			});
		}
		return entry;
	});
}

/**
 * Renders the character's chat-facing style directions (`style.all` +
 * `style.chat`) as a single self-headed block for the canonical v5 message
 * pipeline. Computed statically from the character — never through the
 * per-room CHARACTER provider — so the rendered block is byte-stable and safe
 * inside the KV-cacheable stable prefix. Returns "" when the character
 * declares no chat style.
 */
export function buildCharacterStyleDirections(args: {
	character?: Pick<Character, "name" | "style"> | null;
}): string {
	const character = args.character;
	const name =
		typeof character?.name === "string" && character.name.trim()
			? character.name.trim()
			: "the agent";
	const style = character?.style;
	const rules = [
		...renderStyleRules(style?.all, "all"),
		...renderStyleRules(style?.chat, "chat"),
	].map((rule) => replaceNameTokens(rule, name));
	if (rules.length === 0) {
		return "";
	}
	return `# Message Directions for ${name}\n${rules.join("\n")}`;
}

export function textFromChatMessageContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		throw new ElizaError(
			"Chat message content must be a string or text-part array",
			{
				code: "SYSTEM_PROMPT_CHAT_CONTENT_INVALID",
				context: {
					receivedType: content === null ? "null" : typeof content,
				},
				severity: "fatal",
			},
		);
	}
	return content
		.map((part, index) => {
			if (
				!part ||
				typeof part !== "object" ||
				Array.isArray(part) ||
				(part as { type?: unknown }).type !== "text" ||
				typeof (part as { text?: unknown }).text !== "string"
			) {
				throw new ElizaError(
					"Chat message part cannot be rendered losslessly as text",
					{
						code: "SYSTEM_PROMPT_CHAT_CONTENT_INVALID",
						context: { index },
						severity: "fatal",
					},
				);
			}
			return (part as { text: string }).text;
		})
		.join("\n");
}

export function extractLeadingSystemPrompt(
	messages: unknown,
): string | undefined {
	if (messages === undefined || messages === null) {
		return undefined;
	}
	if (!Array.isArray(messages)) {
		throw new ElizaError("System prompt messages must be an array", {
			code: "SYSTEM_PROMPT_MESSAGES_INVALID",
			context: { receivedType: typeof messages },
			severity: "fatal",
		});
	}
	if (messages.length === 0) return undefined;
	const first = messages[0] as MessageLike | undefined;
	if (first?.role !== "system") {
		return undefined;
	}
	return textFromChatMessageContent(first.content);
}

export function resolveEffectiveSystemPrompt(args: {
	params?: unknown;
	fallback?: string | null;
}): string | undefined {
	if (
		args.params !== undefined &&
		args.params !== null &&
		(typeof args.params !== "object" || Array.isArray(args.params))
	) {
		throw new ElizaError("System prompt params must be an object", {
			code: "SYSTEM_PROMPT_PARAMS_INVALID",
			context: { receivedType: typeof args.params },
			severity: "fatal",
		});
	}
	const params = args.params as Record<string, unknown> | null | undefined;
	if (params && Object.hasOwn(params, "system")) {
		if (typeof params.system !== "string") {
			throw new ElizaError("Explicit system prompt must be a string", {
				code: "SYSTEM_PROMPT_VALUE_INVALID",
				context: { source: "params.system" },
				severity: "fatal",
			});
		}
		return params.system;
	}
	const fromMessages = params
		? extractLeadingSystemPrompt(params.messages)
		: undefined;
	if (fromMessages !== undefined) {
		return fromMessages;
	}
	if (args.fallback === undefined || args.fallback === null) return undefined;
	if (typeof args.fallback !== "string") {
		throw new ElizaError("Fallback system prompt must be a string", {
			code: "SYSTEM_PROMPT_VALUE_INVALID",
			context: { source: "fallback" },
			severity: "fatal",
		});
	}
	return args.fallback;
}

export function dropDuplicateLeadingSystemMessage<T extends MessageLike>(
	messages: readonly T[] | undefined,
	_systemPrompt: string | undefined,
): T[] | undefined {
	// Compatibility seam: duplicates are intentional model context and must not
	// be removed merely because their rendered text matches another field.
	return messages as T[];
}

export function renderChatMessagesForPrompt(
	messages: readonly ChatMessage[] | undefined,
	options: { omitDuplicateSystem?: string } = {},
): string | undefined {
	if (!messages?.length) {
		return undefined;
	}
	void options.omitDuplicateSystem;
	const blocks: string[] = [];
	for (const message of messages) {
		const content = textFromChatMessageContent(message.content);
		blocks.push(`${message.role}:\n${content}`);
	}
	return blocks.join("\n\n");
}
