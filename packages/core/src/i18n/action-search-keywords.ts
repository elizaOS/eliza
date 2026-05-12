/**
 * Action search keywords for tool retrieval.
 *
 * The backing data is generated from packages/shared/src/i18n/keywords/*.json.
 * These helpers deliberately support retrieval/ranking only. They must not be
 * used as hard action availability checks.
 */

import { VALIDATION_KEYWORD_DOCS } from "./generated/validation-keyword-data.ts";
import {
	collectKeywordTermMatches,
	splitKeywordDoc,
} from "./validation-keywords.ts";

type KeywordDoc = {
	base?: string;
	locales?: Partial<Record<string, string>>;
};

type KeywordTree = {
	[key: string]: KeywordTree | KeywordDoc;
};

export type ActionSearchKeywordSource = {
	key: string;
	terms: string[];
};

const CONTEXT_KEYWORD_STEMS: Record<string, readonly string[]> = {
	admin: ["contextSignal.admin"],
	agent_internal: ["contextSignal.agent_internal"],
	automation: [
		"contextSignal.automation",
		"action.createTask",
		"action.triggerCreate",
	],
	browser: ["contextSignal.browser", "contextSignal.web_search"],
	calendar: ["contextSignal.calendar"],
	character: ["contextSignal.character"],
	code: ["contextSignal.code"],
	connectors: ["contextSignal.connectors"],
	contacts: ["contextSignal.contacts", "action.searchContacts"],
	crypto: ["contextSignal.crypto"],
	documents: [
		"contextSignal.documents",
		"action.processDocuments",
		"action.searchDocuments",
	],
	email: ["contextSignal.email", "contextSignal.gmail"],
	files: ["contextSignal.files"],
	finance: ["contextSignal.finance"],
	game: ["contextSignal.game"],
	general: ["contextSignal.general"],
	health: ["contextSignal.health"],
	knowledge: ["contextSignal.knowledge"],
	messaging: [
		"contextSignal.messaging",
		"contextSignal.send_message",
		"contextSignal.read_messages",
		"contextSignal.read_channel",
		"contextSignal.search_conversations",
	],
	media: ["contextSignal.media"],
	memory: ["contextSignal.memory"],
	payments: ["contextSignal.payments"],
	phone: ["contextSignal.phone", "contextSignal.send_message"],
	productivity: [
		"contextSignal.productivity",
		"action.createTask",
		"action.manageTasks",
	],
	research: ["contextSignal.research", "contextSignal.web_search"],
	screen_time: ["contextSignal.screen_time"],
	secrets: ["contextSignal.secrets"],
	settings: ["contextSignal.settings"],
	simple: ["contextSignal.simple"],
	social: [
		"contextSignal.social",
		"contextSignal.send_message",
		"contextSignal.read_messages",
	],
	social_posting: [
		"contextSignal.social_posting",
		"contextSignal.send_message",
	],
	state: ["contextSignal.state"],
	subscriptions: ["contextSignal.subscriptions"],
	system: ["contextSignal.system"],
	tasks: ["contextSignal.tasks", "action.createTask", "action.manageTasks"],
	terminal: ["contextSignal.terminal"],
	todos: ["contextSignal.todos", "action.createTask", "action.manageTasks"],
	wallet: ["contextSignal.wallet"],
	web: ["contextSignal.web", "contextSignal.web_search"],
	world: ["contextSignal.world"],
};

export function actionNameToKeywordStem(actionName: string): string {
	const words = String(actionName ?? "")
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.split(/[^A-Za-z0-9]+/g)
		.map((word) => word.trim().toLowerCase())
		.filter(Boolean);
	if (words.length === 0) {
		return "";
	}
	return [words[0], ...words.slice(1).map(capitalizeAscii)].join("");
}

export function getActionSearchKeywordSources(input: {
	name: string;
	contexts?: unknown;
	includeAllLocales?: boolean;
}): ActionSearchKeywordSource[] {
	const stems = new Set<string>();
	const actionStem = actionNameToKeywordStem(input.name);
	if (actionStem) {
		stems.add(`action.${actionStem}`);
	}

	for (const context of normalizeStringArray(input.contexts)) {
		for (const stem of CONTEXT_KEYWORD_STEMS[context] ?? []) {
			stems.add(stem);
		}
	}

	const sources: ActionSearchKeywordSource[] = [];
	for (const stem of stems) {
		for (const source of collectKeywordSourcesUnderStem(stem, {
			includeAllLocales: input.includeAllLocales ?? true,
		})) {
			sources.push(source);
		}
	}
	return dedupeKeywordSources(sources);
}

export function getActionSearchKeywordTerms(input: {
	name: string;
	contexts?: unknown;
	includeAllLocales?: boolean;
}): string[] {
	return dedupeTerms(
		getActionSearchKeywordSources(input).flatMap((source) => source.terms),
	);
}

export function countActionSearchKeywordMatches(
	texts: readonly string[],
	terms: readonly string[],
): number {
	return collectKeywordTermMatches(texts, terms).size;
}

function collectKeywordSourcesUnderStem(
	stem: string,
	options: { includeAllLocales: boolean },
): ActionSearchKeywordSource[] {
	const node = lookupKeywordNode(stem);
	if (!node) {
		return [];
	}

	const sources: ActionSearchKeywordSource[] = [];
	collectKeywordDocs(node, stem, sources, options);
	return sources;
}

function collectKeywordDocs(
	node: KeywordTree | KeywordDoc,
	key: string,
	sources: ActionSearchKeywordSource[],
	options: { includeAllLocales: boolean },
): void {
	if (isKeywordDoc(node)) {
		const terms = options.includeAllLocales
			? splitKeywordDoc(
					[node.base, ...Object.values(node.locales ?? {})]
						.filter((value): value is string => typeof value === "string")
						.join("\n"),
				)
			: splitKeywordDoc(node.base);
		if (terms.length > 0) {
			sources.push({ key, terms });
		}
		return;
	}

	for (const [childKey, childNode] of Object.entries(node)) {
		collectKeywordDocs(childNode, `${key}.${childKey}`, sources, options);
	}
}

function lookupKeywordNode(path: string): KeywordTree | KeywordDoc | undefined {
	let current: unknown = VALIDATION_KEYWORD_DOCS as KeywordTree;
	for (const segment of path.split(".")) {
		if (!current || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	if (!current || typeof current !== "object") {
		return undefined;
	}
	return current as KeywordTree | KeywordDoc;
}

function isKeywordDoc(value: KeywordTree | KeywordDoc): value is KeywordDoc {
	return "base" in value || "locales" in value;
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
}

function capitalizeAscii(value: string): string {
	return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function dedupeTerms(terms: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const term of terms) {
		const key = term.trim().toLowerCase();
		if (!key || seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(term);
	}
	return result;
}

function dedupeKeywordSources(
	sources: readonly ActionSearchKeywordSource[],
): ActionSearchKeywordSource[] {
	const byKey = new Map<string, ActionSearchKeywordSource>();
	for (const source of sources) {
		const existing = byKey.get(source.key);
		byKey.set(source.key, {
			key: source.key,
			terms: dedupeTerms([...(existing?.terms ?? []), ...source.terms]),
		});
	}
	return [...byKey.values()];
}
