/** Applies application locale normalization to the canonical prompt keyword matcher. */

import { normalizeCharacterLanguage } from "../character-language.js";
import {
	getValidationKeywordLocaleTerms as getLocaleTerms,
	getValidationKeywordTerms as getTerms,
} from "./keyword-matching-core.js";

export {
	collectKeywordTermMatches,
	collectPreparedKeywordTermMatches,
	findKeywordTermMatch,
	hasPreparedKeywordTermMatch,
	normalizeKeywordMatchText,
	type PreparedKeywordTerm,
	prepareKeywordTerms,
	splitKeywordDoc,
	textIncludesKeywordTerm,
	VALIDATION_KEYWORD_DOCS,
} from "./keyword-matching-core.js";
export function getValidationKeywordTerms(
	key: string,
	options?: { includeAllLocales?: boolean; locale?: unknown },
): string[] {
	return getTerms(key, {
		...options,
		locale: normalizeCharacterLanguage(options?.locale),
	});
}
export function getValidationKeywordLocaleTerms(
	key: string,
	locale: unknown,
): string[] {
	return getLocaleTerms(key, normalizeCharacterLanguage(locale));
}
