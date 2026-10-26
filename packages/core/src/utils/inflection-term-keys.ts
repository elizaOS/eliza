/**
 * Inflection-insensitive term keys for matching a user's phrasing against a
 * stored or restated sentence: "like"/"likes", "prefer"/"prefers",
 * "wake"/"wakes"/"waking" compare equal when both sides are indexed by every
 * candidate form. Consumers are the MEMORY action's query scoring
 * (packages/agent) and the planner loop's malformed-call correlation; both
 * index all keys of the haystack terms and accept a needle term when any of
 * its keys is present. Terms shorter than four characters are never stemmed
 * so "bus"/"bu" style collisions cannot happen.
 */
export function inflectionTermKeys(term: string): string[] {
	const lower = term.toLowerCase();
	const keys = new Set<string>([lower]);
	let base = lower;
	if (base.length >= 5 && base.endsWith("ies")) {
		base = `${base.slice(0, -3)}y`;
	} else if (base.length >= 5 && base.endsWith("sses")) {
		base = base.slice(0, -2);
	} else if (base.length >= 4 && base.endsWith("s") && !base.endsWith("ss")) {
		base = base.slice(0, -1);
	}
	keys.add(base);
	// Sibilant and "-o" stems pluralize with "-es" (boxes, watches, dishes,
	// heroes), so the single-"s" strip above leaves a trailing "e" ("boxe")
	// and the real singular ("box") is never offered. Add it as an extra
	// candidate form instead of replacing `base`: stems that end in "e"
	// pluralize with a plain "-s" (houses, caches), and for those the stripped
	// form above is already the singular.
	if (lower.length >= 4 && /(?:[sxz]|ch|sh|o)es$/u.test(lower)) {
		keys.add(lower.slice(0, -2));
	}
	for (const suffix of ["ing", "ed"]) {
		if (base.length < suffix.length + 2 || !base.endsWith(suffix)) continue;
		const stem = base.slice(0, -suffix.length);
		keys.add(stem);
		keys.add(`${stem}e`);
		if (suffix === "ed" && stem.length >= 3 && stem.endsWith("i")) {
			keys.add(`${stem.slice(0, -1)}y`);
		}
		if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
			keys.add(stem.slice(0, -1));
		}
	}
	return [...keys];
}
