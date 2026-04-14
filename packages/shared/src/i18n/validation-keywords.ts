/**
 * Validation keywords — barrel re-export.
 *
 * Keyword DATA is generated from JSON: keywords/*.keywords.json
 *   → generated/validation-keyword-data.ts  (codegen, do not edit)
 *
 * Matching UTILITIES are hand-written: keyword-matching.ts
 *
 * To add/edit keywords, edit the JSON files and run:
 *   node scripts/generate-keywords.mjs
 */
export {
	VALIDATION_KEYWORD_DOCS,
	normalizeKeywordMatchText,
	splitKeywordDoc,
	textIncludesKeywordTerm,
	collectKeywordTermMatches,
	findKeywordTermMatch,
	getValidationKeywordTerms,
	getValidationKeywordLocaleTerms,
} from "./keyword-matching.js";
