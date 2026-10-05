/** Matches planner action wildcards in O(name × parts), avoiding exponential regular-expression backtracking on untrusted hints. */

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
