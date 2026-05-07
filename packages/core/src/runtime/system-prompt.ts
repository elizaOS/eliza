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

export function buildCanonicalSystemPrompt(args: {
	character?: Pick<Character, "name" | "system" | "bio"> | null;
	userRole?: RoleGateRole | string | null;
}): string {
	const character = args.character;
	const system =
		typeof character?.system === "string" ? character.system.trim() : "";
	const bio = renderSystemPromptBio(character?.bio);
	const name =
		typeof character?.name === "string" && character.name.trim()
			? character.name.trim()
			: "the agent";
	const role = normalizeSystemPromptRole(args.userRole);
	return [
		system,
		bio ? `# About ${name}\n${bio}` : "",
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
	if (!first || first.role !== "system") {
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
