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

/**
 * A keyword term with its per-term work (normalization, word-boundary pattern)
 * done once. `term` is the raw string exactly as supplied, because match sets
 * are keyed by the raw term.
 */
export interface PreparedKeywordTerm {
	term: string;
	normalized: string;
	/** Word-boundary pattern for ASCII terms; null for terms matched by inclusion. */
	pattern: RegExp | null;
}

const NON_ASCII_PATTERN = /[\u0080-\uffff]/;

/**
 * Prepare a term list for repeated matching. Duplicate raw terms collapse to
 * one entry and terms that normalize to nothing are dropped; both are exactly
 * the entries that can never add a member to a match set, so
 * {@link collectPreparedKeywordTermMatches} returns the same set as
 * {@link collectKeywordTermMatches} over the unprepared list.
 */
export function prepareKeywordTerms(
	terms: readonly string[],
): PreparedKeywordTerm[] {
	const seen = new Set<string>();
	const prepared: PreparedKeywordTerm[] = [];
	for (const term of terms) {
		if (seen.has(term)) continue;
		seen.add(term);
		const normalized = normalizeKeywordMatchText(term);
		if (!normalized) continue;
		prepared.push({
			term,
			normalized,
			pattern: usesAsciiWordBoundaries(normalized)
				? new RegExp(
						`\\b${escapePattern(normalized).replace(/\\ /g, "\\s+")}\\b`,
						"i",
					)
				: null,
		});
	}
	return prepared;
}

/**
 * Same predicate as {@link textIncludesKeywordTerm} applied over every
 * (text, term) pair, with the per-text normalization and non-ASCII scan done
 * once per text and the per-term work taken from the prepared list. Retrieval
 * ran the unprepared form over ~16K terms × every recent-conversation text per
 * turn (0.7 s median, 9.5 s worst, synchronous on the event loop).
 */
export function collectPreparedKeywordTermMatches(
	texts: readonly string[],
	prepared: readonly PreparedKeywordTerm[],
): Set<string> {
	const matches = new Set<string>();
	if (prepared.length === 0) return matches;
	const preparedTexts: Array<{
		text: string;
		normalized: string;
		hasNonAscii: boolean;
	}> = [];
	for (const text of texts) {
		const normalized = normalizeKeywordMatchText(text);
		if (!normalized) continue;
		preparedTexts.push({
			text,
			normalized,
			hasNonAscii: NON_ASCII_PATTERN.test(text),
		});
	}
	if (preparedTexts.length === 0) return matches;
	for (const entry of prepared) {
		for (const candidate of preparedTexts) {
			const hit = entry.pattern
				? entry.pattern.test(candidate.text) ||
					(candidate.hasNonAscii &&
						candidate.normalized.includes(entry.normalized))
				: candidate.normalized.includes(entry.normalized);
			if (hit) {
				matches.add(entry.term);
				break;
			}
		}
	}
	return matches;
}

export function collectKeywordTermMatches(
	texts: readonly string[],
	terms: readonly string[],
): Set<string> {
	return collectPreparedKeywordTermMatches(texts, prepareKeywordTerms(terms));
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
