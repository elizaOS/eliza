/** Applies application locale normalization to the canonical prompt keyword matcher. */

import { normalizeCharacterLanguage } from "@elizaos/core/character-language";
import {
  getValidationKeywordLocaleTerms as getLocaleTerms,
  getValidationKeywordTerms as getTerms,
} from "@elizaos/core/i18n/keyword-matching-core";

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
} from "@elizaos/core/i18n/keyword-matching-core";
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
