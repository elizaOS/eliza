/**
 * Validation keywords for @elizaos/core.
 *
 * Keyword DATA is generated from JSON: @elizaos/shared/src/i18n/keywords/*.keywords.json
 *   → generated/validation-keyword-data.ts  (codegen, do not edit)
 *
 * Matching UTILITIES are below (hand-written).
 *
 * To add/edit keywords, edit the JSON files and run:
 *   node packages/shared/scripts/generate-keywords.mjs
 */

import {
	VALIDATION_KEYWORD_DOCS as _DOCS,
	VALIDATION_KEYWORD_LOCALES as _LOCALES,
} from "./generated/validation-keyword-data.ts";

export type { ValidationKeywordLocale } from "./generated/validation-keyword-data.ts";
export {
	_DOCS as VALIDATION_KEYWORD_DOCS,
	_LOCALES as VALIDATION_KEYWORD_LOCALES,
};

// --- Internal types ---

type ValidationKeywordDoc = {
	base?: string;
	locales?: Partial<Record<string, string>>;
};

function isValidationKeywordDoc(value: unknown): value is ValidationKeywordDoc {
	if (!value || typeof value !== "object") {
		return false;
	}
	const record = value as Record<string, unknown>;
	return "base" in record || "locales" in record;
}

function lookupValidationKeywordDoc(key: string): ValidationKeywordDoc {
	let current: unknown = _DOCS;
	for (const segment of key.split(".")) {
		if (!current || typeof current !== "object") {
			throw new Error(`Unknown validation keyword key: ${key}`);
		}
		current = (current as Record<string, unknown>)[segment];
	}

	if (!isValidationKeywordDoc(current)) {
		throw new Error(`Unknown validation keyword key: ${key}`);
	}

	return current;
}

// --- Matching utilities ---

function escapePattern(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeKeywordMatchText(value: string): string {
	return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function usesAsciiWordBoundaries(term: string): boolean {
	return /^[a-z0-9][a-z0-9' -]*$/i.test(term);
}

export function splitKeywordDoc(value: string | undefined): string[] {
	if (!value) {
		return [];
	}

	const seen = new Set<string>();
	const terms: string[] = [];
	for (const entry of value.split(/\n+/)) {
		const trimmed = entry.trim();
		if (!trimmed) {
			continue;
		}
		const key = normalizeKeywordMatchText(trimmed);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		terms.push(trimmed);
	}
	return terms;
}

export function textIncludesKeywordTerm(text: string, term: string): boolean {
	const normalizedText = normalizeKeywordMatchText(text);
	const normalizedTerm = normalizeKeywordMatchText(term);
	if (!normalizedText || !normalizedTerm) {
		return false;
	}

	if (usesAsciiWordBoundaries(normalizedTerm)) {
		const pattern = new RegExp(
			`\\b${escapePattern(normalizedTerm).replace(/\\ /g, "\\s+")}\\b`,
			"i",
		);
		if (pattern.test(text)) {
			return true;
		}

		const hasNonAsciiText = [...text].some((char) => char.charCodeAt(0) > 0x7f);
		if (hasNonAsciiText) {
			return normalizedText.includes(normalizedTerm);
		}
		return false;
	}

	return normalizedText.includes(normalizedTerm);
}

export function collectKeywordTermMatches(
	texts: readonly string[],
	terms: readonly string[],
): Set<string> {
	const matches = new Set<string>();
	for (const text of texts) {
		for (const term of terms) {
			if (textIncludesKeywordTerm(text, term)) {
				matches.add(term);
			}
		}
	}
	return matches;
}

export function findKeywordTermMatch(
	text: string,
	terms: readonly string[],
): string | undefined {
	const sorted = [...terms].sort((left, right) => right.length - left.length);
	return sorted.find((term) => textIncludesKeywordTerm(text, term));
}

export function getValidationKeywordTerms(
	key: string,
	options?: {
		includeAllLocales?: boolean;
		locale?: string;
	},
): string[] {
	const doc = lookupValidationKeywordDoc(key);
	if (options?.includeAllLocales) {
		return splitKeywordDoc(
			[doc.base, ...Object.values(doc.locales ?? {})]
				.filter((value): value is string => typeof value === "string")
				.join("\n"),
		);
	}

	return splitKeywordDoc(
		`${doc.base ?? ""}\n${
			options?.locale
				? (doc.locales?.[options.locale as keyof typeof doc.locales] ?? "")
				: ""
		}`,
	);
}

export function getValidationKeywordLocaleTerms(
	key: string,
	locale: string,
): string[] {
	const doc = lookupValidationKeywordDoc(key);
	return splitKeywordDoc(
		doc.locales?.[locale as keyof typeof doc.locales] ?? "",
	);
}
