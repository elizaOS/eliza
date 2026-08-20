/**
 * Linear matcher for planner wildcard action hints. `wildcardCandidateRegex`
 * used to join literal segments with `.*` and run a JS regex; a model hint
 * like `A*A*A*…*Z` against a catalog name of A's is exponential and hangs
 * the retrieve-actions stage on the request thread. Honest hints are
 * `GMAIL_*` / `*_DRAFT` (one or two stars). This walk is O(name × parts).
 */

/** True when `name` matches `^parts[0].*parts[1].*…parts[n]$`. */
export function matchActionWildcardParts(
	parts: readonly string[],
	name: string,
): boolean {
	if (parts.length === 0) return false;

	const first = parts[0] ?? "";
	const last = parts[parts.length - 1] ?? "";
	let pos = 0;

	if (first) {
		if (!name.startsWith(first)) return false;
		pos = first.length;
	}

	for (let index = 1; index < parts.length - 1; index += 1) {
		const literal = parts[index] ?? "";
		if (!literal) continue;
		const found = name.indexOf(literal, pos);
		if (found === -1) return false;
		pos = found + literal.length;
	}

	if (last) {
		if (!name.endsWith(last)) return false;
		if (pos > name.length - last.length) return false;
	}

	return true;
}
