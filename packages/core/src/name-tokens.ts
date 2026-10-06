/**
 * Literal-safe character-name substitution and inverse tokenization.
 */
export function replaceNameTokens(text: string, name: string): string {
	if (!text) return text;
	return text
		.replace(/\{\{\s*name\s*\}\}/g, () => name)
		.replace(/\{\{\s*agentName\s*\}\}/g, () => name);
}
/**
 * Resolve indexed example-participant tokens (`{{name1}}` / `{{user1}}` …) in
 * example-conversation templates against a positional `names` array (slot 1 ->
 * `names[0]`). Whitespace inside the braces (`{{ name1 }}`) is tolerated, and an
 * out-of-range index is left untouched so a partial name pool never blanks a
 * token.
 *
 * Same canonical-owner rationale and `$`-safety as `replaceNameTokens`: a
 * replacer function inserts the name literally, so a generated name containing
 * `$&` / `$1` / `$$` is not re-read as a `String.replace` substitution pattern.
 * The core prompt builder (`composeRandomUser`) and the character provider both
 * resolve these tokens through this one implementation.
 */
export function replaceIndexedNameTokens(
	text: string,
	names: readonly string[],
): string {
	if (!text) return text;
	return text.replace(
		/\{\{\s*(?:name|user)(\d+)\s*\}\}/g,
		(match, slot: string) => {
			const name = names[Number(slot) - 1];
			return name === undefined ? match : name;
		},
	);
}

/**
 * Reverse of `replaceNameTokens` — rewrite whole-word occurrences of the
 * given literal character name back into `{{name}}` tokens so that a
 * later rename continues to propagate through every text field.
 *
 * Rules:
 * - Case-sensitive, whole-word match (word boundaries on both sides).
 * - Names under 2 characters are ignored; the tokenizer is not
 * meaningful for single-letter names and risks destroying prose.
 * - Idempotent: re-running on already-tokenized text leaves it unchanged because
 * `{{name}}` does not contain the literal name.
 * - Non-destructive on empty input or empty name.
 *
 * @param text The text to scan.
 * @param name The literal character name to tokenize (e.g. "Momo").
 * @returns The text with whole-word occurrences replaced by `{{name}}`.
 */
export function tokenizeNameOccurrences(text: string, name: string): string {
	if (!text || !name) return text;
	const trimmed = name.trim();
	if (trimmed.length < 2) return text;
	const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// `\b` only understands ASCII `[A-Za-z0-9_]`, so non-ASCII names
	// (e.g. "小美", "Émile") would never match — use Unicode-aware
	// letter/number lookarounds as the whole-word boundary instead.
	const pattern = new RegExp(
		`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
		"gu",
	);
	return text.replace(pattern, "{{name}}");
}
