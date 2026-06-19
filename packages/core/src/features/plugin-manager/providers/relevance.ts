import type { Memory } from "../../../types/memory.ts";
import type { State } from "../../../types/state.ts";
import {
	validateActionKeywords as coreValidateActionKeywords,
	validateActionRegex as coreValidateActionRegex,
} from "../../../validation/keywords.ts";

/**
 * Read the recent-messages memory array that `recentMessagesProvider` writes
 * into `state.data.providers.RECENT_MESSAGES.data.recentMessages`.
 *
 * Inlined from @elizaos/shared to avoid a cross-package type import that
 * breaks tsc declaration emit (rootDir constraint).
 */
function getRecentMessagesData(state: State | undefined): Memory[] {
	const messages =
		state?.data?.providers?.RECENT_MESSAGES?.data?.recentMessages;
	return Array.isArray(messages) ? (messages as Memory[]) : [];
}

const IGNORED_PLUGIN_NAME_TOKENS = new Set([
	"app",
	"core",
	"eliza",
	"elizaos",
	"manager",
	"plugin",
	"plugins",
	"provider",
	"providers",
]);

const escapeRegex = (value: string): string =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeKeyword = (value: string): string => value.trim().toLowerCase();

export const PLUGIN_MANAGER_BASE_KEYWORDS = [
	"plugin",
	"plugins",
	"plugin manager",
	"plugin-manager",
	"extension",
	"extensions",
	"module",
	"modules",
	"addon",
	"add-on",
	"add-ons",
	"integration",
	"integrations",
	"integrate",
	"integrated",
	"connect",
	"connected",
	"connection",
	"connector",
	"connectors",
	"adapter",
	"adapters",
	"bridge",
	"bridges",
	"interoperability",
	"orchestration",
	"compatibility",
	"ecosystem",
	"registry",
	"catalog",
	"directory",
	"marketplace",
	"index",
	"search",
	"discover",
	"install",
	"installed",
	"installation",
	"uninstall",
	"remove",
	"removed",
	"load",
	"loaded",
	"unload",
	"unloaded",
	"enable",
	"enabled",
	"disable",
	"disabled",
	"configure",
	"configuration",
	"config",
	"settings",
	"setup",
	"status",
	"state",
	"health",
	"available",
	"availability",
	"error",
	"errors",
	"package",
	"packages",
	"repo",
	"repository",
	"dependencies",
	"runtime",
	"provider",
	"providers",
	"service",
	"services",
	"tool",
	"tools",
	"workflow",
	"workflows",
] as const;

export const COMMON_CONNECTOR_KEYWORDS = [
	"discord",
	"telegram",
	"slack",
	"whatsapp",
	"twitter",
	"github",
	"farcaster",
	"nostr",
	"line",
	"matrix",
	"google chat",
	"msteams",
	"teams",
	"twilio",
	"imessage",
	"bluebubbles",
	"bluesky",
	"twitch",
	"instagram",
	"zalo",
	"nextcloud",
	"gmail",
	"openai",
	"anthropic",
	"groq",
	"ollama",
	"xai",
	"solana",
	"evm",
	"mcp",
	"rss",
	"s3",
	"sql",
] as const;

export function buildProviderKeywords(
	...groups: Array<readonly string[] | string[] | undefined>
): string[] {
	const deduped = new Set<string>();
	for (const group of groups) {
		if (!group) continue;
		for (const raw of group) {
			const keyword = normalizeKeyword(raw);
			if (!keyword) continue;
			deduped.add(keyword);
		}
	}
	return [...deduped];
}

export function keywordsFromPluginNames(
	pluginNames: Iterable<string>,
): string[] {
	const deduped = new Set<string>();

	for (const rawName of pluginNames) {
		const name = normalizeKeyword(rawName);
		if (!name) continue;

		deduped.add(name);

		const withoutScope = name.replace(/^@[^/]+\//, "");
		if (withoutScope) deduped.add(withoutScope);

		const withoutPrefix = withoutScope.replace(/^(plugin|app)[-_]/, "");
		if (withoutPrefix) deduped.add(withoutPrefix);

		for (const token of withoutPrefix.split(/[^a-z0-9]+/)) {
			if (!token || token.length < 2 || IGNORED_PLUGIN_NAME_TOKENS.has(token))
				continue;
			deduped.add(token);
		}
	}

	return [...deduped];
}

export function buildKeywordRegex(keywords: readonly string[]): RegExp {
	const escapedKeywords = [
		...new Set(keywords.map(normalizeKeyword).filter(Boolean)),
	]
		.sort((a, b) => b.length - a.length)
		.map(escapeRegex);

	if (escapedKeywords.length === 0) {
		return /$^/;
	}

	return new RegExp(`\\b(${escapedKeywords.join("|")})\\b`, "i");
}

function getMemoryText(memory: Memory | undefined): string {
	if (!memory || typeof memory !== "object") return "";

	const content = (memory as { content?: unknown }).content;
	if (!content || typeof content !== "object") return "";

	const text = (content as { text?: unknown }).text;
	return typeof text === "string" ? text.toLowerCase() : "";
}

function getRecentMessageTexts(state: State | undefined): string[] {
	return getRecentMessages(state)
		.map((message) => getMemoryText(message))
		.filter((text): text is string => text.length > 0);
}

function getRecentMessages(state: State | undefined): Memory[] {
	return getRecentMessagesData(state);
}

function validateKeywords(
	message: Memory,
	state: State | undefined,
	keywords: readonly string[],
): boolean {
	if (keywords.length === 0) return false;

	const texts = [getMemoryText(message), ...getRecentMessageTexts(state)];
	if (texts.every((text) => !text)) return false;

	return keywords.some((keyword) => {
		const normalizedKeyword = normalizeKeyword(keyword);
		if (!normalizedKeyword) return false;
		return texts.some((text) => text.includes(normalizedKeyword));
	});
}

function validateRegex(
	message: Memory,
	state: State | undefined,
	regex: RegExp,
): boolean {
	const texts = [getMemoryText(message), ...getRecentMessageTexts(state)];
	return texts.some((text) => Boolean(text) && regex.test(text));
}

export function isProviderRelevant(
	message: Memory,
	state: State | undefined,
	keywords: readonly string[],
): boolean {
	const recentMessages = getRecentMessages(state);
	const keywordRegex = buildKeywordRegex(keywords);
	const hasKeywordMatch = coreValidateActionKeywords
		? coreValidateActionKeywords(message, recentMessages, [...keywords])
		: validateKeywords(message, state, keywords);
	const hasRegexMatch = coreValidateActionRegex
		? coreValidateActionRegex(message, recentMessages, keywordRegex)
		: validateRegex(message, state, keywordRegex);

	return hasKeywordMatch || hasRegexMatch;
}
