/** Public, renderer-safe speech text and error contracts. No host initialization. */
export {
	ElizaError,
	type ElizaErrorOptions,
	type ElizaErrorSeverity,
} from "./errors.ts";
export { sanitizeSpeechText } from "./spoken-text.ts";
export { trimEndCharacters } from "./utils/string-boundaries.ts";
