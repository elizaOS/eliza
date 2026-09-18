/** Keyword matching uses the authored table in @elizaos/prompts/keywords. */
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
