/** Keyword matching over the authored catalog, with explicit raw and character-locale access. */
import { normalizeCharacterLanguage } from "../character-language.js";
import { VALIDATION_KEYWORD_DOCS as _DOCS } from "./keywords.js";

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

function compileKeywordTerm(term: string) {
	const normalizedTerm = normalizeKeywordMatchText(term);
	// Word-boundary terms test the normalized text: NFKC forms still match, a
	// collapsed whitespace run lets multi-word terms span line breaks, and an
	// emoji or accented letter elsewhere in the text keeps the boundaries.
	const pattern = usesAsciiWordBoundaries(normalizedTerm)
		? new RegExp(`\\b${escapePattern(normalizedTerm)}\\b`, "i")
		: null;

	return (normalizedText: string) => {
		if (!normalizedText || !normalizedTerm) {
			return false;
		}
		if (pattern) {
			return pattern.test(normalizedText);
		}
		return normalizedText.includes(normalizedTerm);
	};
}

export function textIncludesKeywordTerm(text: string, term: string): boolean {
	return compileKeywordTerm(term)(normalizeKeywordMatchText(text));
}

/**
 * A keyword term with its per-term work (normalization, word-boundary pattern)
 * done once. `term` is the raw string exactly as supplied, because match sets
 * are keyed by the raw term. Prepared terms hold catalog vocabulary only —
 * never conversation text — so callers may retain them across turns.
 */
export interface PreparedKeywordTerm {
	term: string;
	matches: (normalizedText: string) => boolean;
}

/**
 * Prepare a term list for repeated matching. Duplicate raw terms collapse to
 * one entry; a match set keyed by raw term cannot gain a member from a repeat,
 * so {@link collectPreparedKeywordTermMatches} returns the same set, in the
 * same text-first insertion order, as {@link collectKeywordTermMatches} over
 * the unprepared list. Action retrieval memoizes the result per catalog parent
 * (~16K terms per turn otherwise recompiled on every call).
 */
export function prepareKeywordTerms(
	terms: readonly string[],
): PreparedKeywordTerm[] {
	const seen = new Set<string>();
	const prepared: PreparedKeywordTerm[] = [];
	for (const term of terms) {
		if (seen.has(term)) continue;
		seen.add(term);
		prepared.push({ term, matches: compileKeywordTerm(term) });
	}
	return prepared;
}

/**
 * {@link collectKeywordTermMatches} over already-prepared terms: each text is
 * normalized once, each term's pattern was compiled once, and a term already
 * matched by an earlier text is not re-tested against later texts.
 */
export function collectPreparedKeywordTermMatches(
	texts: readonly string[],
	prepared: readonly PreparedKeywordTerm[],
): Set<string> {
	const matches = new Set<string>();
	if (texts.length === 0 || prepared.length === 0) return matches;
	let remaining = prepared;
	for (const text of texts) {
		if (remaining.length === 0) break;
		const normalizedText = normalizeKeywordMatchText(text);
		if (!normalizedText) continue;
		const unmatched: PreparedKeywordTerm[] = [];
		for (const entry of remaining) {
			if (entry.matches(normalizedText)) {
				matches.add(entry.term);
			} else {
				unmatched.push(entry);
			}
		}
		remaining = unmatched;
	}
	return matches;
}

export function collectKeywordTermMatches(
	texts: readonly string[],
	terms: readonly string[],
): Set<string> {
	// Preparation stays local to this call: conversation text is never retained
	// in a cross-turn cache. Callers that match static vocabulary repeatedly use
	// prepareKeywordTerms + collectPreparedKeywordTermMatches instead.
	return collectPreparedKeywordTermMatches(texts, prepareKeywordTerms(terms));
}

export function findKeywordTermMatch(
	text: string,
	terms: readonly string[],
): string | undefined {
	const sorted = [...terms].sort((left, right) => right.length - left.length);
	return sorted.find((term) => textIncludesKeywordTerm(text, term));
}

export function getCatalogValidationKeywordTerms(
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

export function getCatalogValidationKeywordLocaleTerms(
	key: string,
	locale: string,
): string[] {
	const doc = lookupValidationKeywordDoc(key);
	return splitKeywordDoc(
		doc.locales?.[locale as keyof typeof doc.locales] ?? "",
	);
}

export function hasPreparedKeywordTermMatch(
	texts: readonly string[],
	prepared: readonly PreparedKeywordTerm[],
): boolean {
	if (prepared.length === 0) return false;
	for (const text of texts) {
		const normalizedText = normalizeKeywordMatchText(text);
		if (!normalizedText) continue;
		for (const entry of prepared) {
			if (entry.matches(normalizedText)) return true;
		}
	}
	return false;
}

export function getValidationKeywordTerms(
	key: string,
	options?: { includeAllLocales?: boolean; locale?: unknown },
): string[] {
	return getCatalogValidationKeywordTerms(key, {
		...options,
		locale: normalizeCharacterLanguage(options?.locale),
	});
}
export function getValidationKeywordLocaleTerms(
	key: string,
	locale: unknown,
): string[] {
	return getCatalogValidationKeywordLocaleTerms(
		key,
		normalizeCharacterLanguage(locale),
	);
}
