/** Applies application locale normalization to the canonical prompt keyword matcher. */
import {
  getValidationKeywordLocaleTerms as getLocaleTerms,
  getValidationKeywordTerms as getTerms,
} from "@elizaos/prompts/keyword-matching";
import { normalizeCharacterLanguage } from "../character-language.js";

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
} from "@elizaos/prompts/keyword-matching";
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
