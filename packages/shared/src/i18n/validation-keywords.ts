/** Keyword matching uses the authored table in @elizaos/shared/i18n/keywords. */
export {
  collectKeywordTermMatches,
  collectPreparedKeywordTermMatches,
  findKeywordTermMatch,
  getValidationKeywordLocaleTerms,
  getValidationKeywordTerms,
  hasPreparedKeywordTermMatch,
  normalizeKeywordMatchText,
  type PreparedKeywordTerm,
  prepareKeywordTerms,
  splitKeywordDoc,
  textIncludesKeywordTerm,
  VALIDATION_KEYWORD_DOCS,
} from "./keyword-matching.js";
