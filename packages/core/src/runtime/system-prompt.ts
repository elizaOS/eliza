/**
 * System-prompt assembly for a model call: builds the canonical prompt from a
 * character's `system` + `bio` (name-token expanded) plus the caller's role, and
 * resolves the effective system prompt from explicit params, a leading `system`
 * chat message, or a fallback — de-duplicating that leading system message when it
 * already matches the resolved prompt.
 */

import { replaceNameTokens } from "../name-tokens";
import type { Character } from "../types/agent";
import type { RoleGateRole } from "../types/contexts";
import type { ChatMessage } from "../types/model";

type MessageLike = {
	role?: unknown;
	content?: unknown;
};

export function renderSystemPromptBio(value: unknown): string {
	if (typeof value === "string") {
		return value.trim();
	}
	if (Array.isArray(value)) {
		return value
			.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
			.filter(Boolean)
			.join(" ");
	}
	return "";
}

export function normalizeSystemPromptRole(
	role: RoleGateRole | string | null | undefined,
): string | undefined {
	const normalized = typeof role === "string" ? role.trim().toUpperCase() : "";
	return normalized || undefined;
}

/**
 * Character `knowledge` entries that are inline facts rather than document
 * sources. Path-shaped strings and `{ path | directory }` objects are document
 * ingestion inputs (see DocumentService.processCharacterDocuments) and stay out
 * of the prompt; everything else is identity-tier content the character author
 * wrote to be known, not retrieved.
 */
const PATHLIKE_RE = /^(?:\.{0,2}[\\/]|~[\\/]|file:\/\/|[A-Za-z]:[\\/])/;

export function renderInlineCharacterKnowledge(
	value: unknown,
	maxChars = 1500,
): string {
	if (!Array.isArray(value)) return "";
	const facts: string[] = [];
	let total = 0;
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const fact = entry.trim();
		if (!fact || PATHLIKE_RE.test(fact)) continue;
		if (total + fact.length > maxChars) break;
		total += fact.length;
		facts.push(fact);
	}
	return facts.join("\n");
}

export function buildCanonicalSystemPrompt(args: {
	character?: Pick<Character, "name" | "system" | "bio" | "knowledge"> | null;
	userRole?: RoleGateRole | string | null;
}): string {
	const character = args.character;
	const name =
		typeof character?.name === "string" && character.name.trim()
			? character.name.trim()
			: "the agent";
	const system = replaceNameTokens(
		typeof character?.system === "string" ? character.system.trim() : "",
		name,
	);
	const bio = replaceNameTokens(renderSystemPromptBio(character?.bio), name);
	// Identity knowledge is always in the prompt, like bio. The documents store
	// also ingests these entries for semantic recall, but retrieval is gated to
	// contexts Stage-1 does not select for identity questions ("who made you"),
	// which are exactly the questions this content exists to answer.
	const knowledge = replaceNameTokens(
		renderInlineCharacterKnowledge(character?.knowledge),
		name,
	);
	const role = normalizeSystemPromptRole(args.userRole);
	return [
		system,
		bio ? `# About ${name}\n${bio}` : "",
		knowledge ? `# What ${name} knows\n${knowledge}` : "",
		role ? `user_role: ${role}` : "",
	]
		.filter(Boolean)
		.join("\n\n")
		.trim();
}

export function textFromChatMessageContent(content: unknown): string {
	if (typeof content === "string") {
		return content.trim();
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((part) => {
			if (!part || typeof part !== "object" || Array.isArray(part)) {
				return "";
			}
			const text = (part as { text?: unknown }).text;
			return typeof text === "string" ? text.trim() : "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

export function extractLeadingSystemPrompt(
	messages: unknown,
): string | undefined {
	if (!Array.isArray(messages) || messages.length === 0) {
		return undefined;
	}
	const first = messages[0] as MessageLike | undefined;
	if (first?.role !== "system") {
		return undefined;
	}
	const content = textFromChatMessageContent(first.content);
	return content || undefined;
}

export function resolveEffectiveSystemPrompt(args: {
	params?: unknown;
	fallback?: string | null;
}): string | undefined {
	const params =
		args.params &&
		typeof args.params === "object" &&
		!Array.isArray(args.params)
			? (args.params as Record<string, unknown>)
			: null;
	if (params && Object.hasOwn(params, "system")) {
		return typeof params.system === "string" ? params.system.trim() : undefined;
	}
	const fromMessages = params
		? extractLeadingSystemPrompt(params.messages)
		: undefined;
	if (fromMessages) {
		return fromMessages;
	}
	const fallback =
		typeof args.fallback === "string" ? args.fallback.trim() : "";
	return fallback || undefined;
}

export function dropDuplicateLeadingSystemMessage<T extends MessageLike>(
	messages: readonly T[] | undefined,
	systemPrompt: string | undefined,
): T[] | undefined {
	if (!messages || messages.length === 0 || !systemPrompt) {
		return messages as T[] | undefined;
	}
	const first = messages[0];
	if (
		first?.role === "system" &&
		textFromChatMessageContent(first.content) === systemPrompt.trim()
	) {
		return messages.slice(1);
	}
	return messages as T[];
}

export function renderChatMessagesForPrompt(
	messages: readonly ChatMessage[] | undefined,
	options: { omitDuplicateSystem?: string } = {},
): string | undefined {
	if (!messages?.length) {
		return undefined;
	}
	const omitSystem = options.omitDuplicateSystem?.trim();
	const blocks: string[] = [];
	for (const [index, message] of messages.entries()) {
		const content = textFromChatMessageContent(message.content);
		if (!content) {
			continue;
		}
		if (
			index === 0 &&
			message.role === "system" &&
			omitSystem &&
			content === omitSystem
		) {
			continue;
		}
		blocks.push(`${message.role}:\n${content}`);
	}
	return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}
