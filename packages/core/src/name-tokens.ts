/**
 * Replace un-substituted `{{name}}` / `{{agentName}}` tokens with the actual
 * character name. Whitespace inside the braces (`{{ name }}`) is tolerated so
 * hand-authored and setup-preset templates resolve identically.
 *
 * Canonical owner lives here in `@elizaos/core`: setup-preset characters ship
 * `{{name}}` / `{{agentName}}` tokens in `system` / `bio` (PR #7101 preserves
 * them on save so renames propagate), so the prompt builder must resolve them
 * before forwarding text to the model. `@elizaos/shared` (and, through it,
 * `@elizaos/ui`) re-exports this so preview tooling and the model see the same
 * substitution.
 *
 * A replacer function is used (not the raw `name` string) so `$`-sequences in a
 * name (e.g. "Cash$$", "M$&M") are inserted literally instead of being read as
 * `String.replace` substitution patterns (`$&`, `$1`, `$$`).
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
