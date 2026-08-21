/** Canonical tag names used by models to delimit private reasoning. */
export const REASONING_TAG_NAMES = [
	"think",
	"thinking",
	"analysis",
	"reasoning",
	"reflection",
	"thought",
	"antthinking",
] as const;

const REASONING_TAG_ALTERNATION = REASONING_TAG_NAMES.join("|");

const WHITESPACE_RE = /\s/;

/** Index of the first non-whitespace char at/after `from`, or `text.length`. */
function skipWhitespace(text: string, from: number): number {
	let i = from;
	while (i < text.length && WHITESPACE_RE.test(text[i] as string)) i++;
	return i;
}

export interface TagMatch {
	/** Index of the tag's leading `<`. */
	start: number;
	/** Index just past the matched `>`. */
	end: number;
	closing: boolean;
}

/**
 * Finds the next well-formed OPEN tag for a name in `tagAlternation`
 * (case-insensitive) at or after `from`.
 *
 * The terminating `>` is located with `indexOf` instead of a `[^>]*>`
 * regex quantifier — a maintainer benchmarked the regex form going
 * quadratic on malformed residue (many `<tag ...` candidates with no
 * reachable `>`: each one independently re-triggers the same
 * greedy-then-backtrack terminator search over the rest of the string).
 * If `indexOf` finds no `>` anywhere after this candidate's tag name, no
 * `>` can exist after any LATER candidate's tag name either (a later
 * candidate only shrinks the search range), so one failed probe is enough
 * to rule out every remaining candidate — this returns `null` immediately
 * rather than repeating the same doomed scan per candidate. This mirrors
 * `[^>]*>`'s own match-or-no-match semantics exactly: an open tag with no
 * terminator anywhere never forms a tag, open or otherwise (locked by
 * `outbound-sanitize.test.ts`'s "unterminated open tag" cases).
 */
export function findNextOpenTag(
	text: string,
	from: number,
	tagAlternation: string,
): TagMatch | null {
	const openRe = new RegExp(`<\\s*(?:${tagAlternation})(?=[\\s/>])`, "gi");
	openRe.lastIndex = from;
	const match = openRe.exec(text);
	if (!match) return null;
	const headEnd = match.index + match[0].length;
	const terminator = text.indexOf(">", headEnd);
	if (terminator === -1) return null;
	return { start: match.index, end: terminator + 1, closing: false };
}

/**
 * Finds the next well-formed CLOSE tag for a name in `tagAlternation`
 * (case-insensitive) at or after `from`. A close tag permits only
 * whitespace between its name and `>` (no attributes), so this walks that
 * gap with a plain index loop rather than a `\s*>` regex quantifier — the
 * same backtracking shape as the open-tag terminator, and the same DoS
 * class on a run of `</tag <non-whitespace, no '>'>` candidates. A failed
 * candidate resumes the search exactly where its whitespace walk stopped
 * (never before it) so the walked span is never re-scanned by the next
 * candidate lookup; the whitespace runs a scan crosses are disjoint, so
 * total work across every call for one `text` is bounded by `text.length`.
 */
export function findNextCloseTag(
	text: string,
	from: number,
	tagAlternation: string,
): TagMatch | null {
	const closeRe = new RegExp(
		`<\\s*\\/\\s*(?:${tagAlternation})(?=[\\s>])`,
		"gi",
	);
	let pos = from;
	while (pos <= text.length) {
		closeRe.lastIndex = pos;
		const match = closeRe.exec(text);
		if (!match) return null;
		const headEnd = match.index + match[0].length;
		const afterWs = skipWhitespace(text, headEnd);
		if (text[afterWs] === ">") {
			return { start: match.index, end: afterWs + 1, closing: true };
		}
		// The lookahead above only accepted this candidate because the char at
		// headEnd was whitespace or '>'; landing here means it was whitespace,
		// so skipWhitespace always advances (afterWs > headEnd) — guaranteed
		// forward progress, no risk of looping on the same position.
		pos = afterWs;
	}
	return null;
}

/**
 * Removes every complete `open...close` pair for a name in `tagAlternation`,
 * bounded to the prefix through the LAST close tag in `text` (a suffix of
 * dangling opens after the last close cannot contain a full pair, so it is
 * never fed to the pairing scan — the caller's unclosed-suffix pass handles
 * it separately). Non-greedy like the regex it replaces: an open pairs with
 * the NEAREST later close, so nested same-family tags collapse the outer
 * pair and its embedded markup together (see outbound-sanitize's
 * "nested same-family tags" characterization test).
 */
export function stripPairedTagBlocks(
	text: string,
	tagAlternation: string,
): string {
	let lastCloseEnd = -1;
	for (
		let close = findNextCloseTag(text, 0, tagAlternation);
		close;
		close = findNextCloseTag(text, close.end, tagAlternation)
	) {
		lastCloseEnd = close.end;
	}
	if (lastCloseEnd < 0) return text;

	let out = "";
	let cursor = 0;
	let pos = 0;
	while (pos < lastCloseEnd) {
		const open = findNextOpenTag(text, pos, tagAlternation);
		if (!open || open.start >= lastCloseEnd) break;
		const close = findNextCloseTag(text, open.end, tagAlternation);
		if (!close || close.end > lastCloseEnd) break;
		out += text.slice(cursor, open.start);
		cursor = close.end;
		pos = close.end;
	}
	return out + text.slice(cursor);
}

/**
 * Removes a trailing unmatched OPEN tag and everything after it (an
 * unclosed reasoning/machine-syntax block runs to the end of the model's
 * turn). A no-terminator candidate reports no match at all (see
 * `findNextOpenTag`), so this is a no-op for genuinely malformed markup —
 * intentional: the actual leak-prevention gate is `hasReasoningResidue`,
 * which denies on the tag *prefix* alone regardless of termination. This
 * cleanup pass only needs to match the well-formed shapes its callers'
 * characterization tests pin.
 */
export function stripUnclosedTagSuffix(
	text: string,
	tagAlternation: string,
): string {
	const open = findNextOpenTag(text, 0, tagAlternation);
	return open ? text.slice(0, open.start) : text;
}

const REASONING_OPEN_PREFIX_SOURCE = `<\\s*(?:${REASONING_TAG_ALTERNATION})(?=[\\s/>])`;
const REASONING_CLOSE_PREFIX_SOURCE = `<\\s*\\/\\s*(?:${REASONING_TAG_ALTERNATION})(?=[\\s>])`;
// Deliberately non-global: `RegExp.prototype.test` on a global regex advances
// and retains `lastIndex`, so identical input alternates true/false across
// calls. Residue detection must be stateless — do not add the `g` flag here.
//
// Deliberately no `[^>]*>` / `\s*>` terminator requirement either: the gate
// denies on the tag PREFIX alone (`<reasoning`, `</think`, ...), so a
// malformed/unterminated tag is residue too. Requiring a terminator here was
// the fail-open half of the same defect the DoS fix addresses on the
// stripping paths — a tag missing its `>` used to sail through this gate as
// "no residue found" while `[^>]*>` backtracked toward a timeout looking for
// one. The prefix alone is sufficient evidence of markup residue and is
// immune to the terminator-search backtrack entirely (no `[^>]*` / `\s*`
// bridges a match to an ambiguous, possibly-absent terminator).
const REASONING_TAG_PREFIX_TEST_RE = new RegExp(
	`${REASONING_OPEN_PREFIX_SOURCE}|${REASONING_CLOSE_PREFIX_SOURCE}`,
	"i",
);

/**
 * Remove private-reasoning prefixes through the last completed closing tag.
 * An unmatched opening tag is deliberately preserved: deleting only its tag
 * would turn the private payload into apparently safe output, while retaining
 * the residue lets evaluator parsing and final-egress checks fail closed.
 */
export function stripReasoningPrefixes(text: string): string {
	let lastCloseEnd = -1;
	for (
		let close = findNextCloseTag(text, 0, REASONING_TAG_ALTERNATION);
		close;
		close = findNextCloseTag(text, close.end, REASONING_TAG_ALTERNATION)
	) {
		lastCloseEnd = close.end;
	}
	return lastCloseEnd >= 0 ? text.slice(lastCloseEnd) : text;
}

/**
 * Return true when text contains any private-reasoning tag markup.
 *
 * This is the deny gate at the last user-visible boundary, and BOTH egress
 * legs in planner-loop.ts route through it (via `isUnsafeUserVisibleText`)
 * before anything reaches the user:
 *
 * - `userSafeFinalMessage` — the success leg (~15 call sites).
 * - `userSafeFailureReport` — the `evaluator.success === false` leg, which
 *   deliberately prefers the evaluator's diagnosis, so it is the input most
 *   likely to carry residue; it gates with `isUnsafeUserVisibleText` before
 *   any of its other screens.
 *
 * Parse strips, egress gates: a future third egress leg must call this gate
 * too — verifying only one of the legs above cannot reveal the other.
 */
export function hasReasoningResidue(text: string): boolean {
	return REASONING_TAG_PREFIX_TEST_RE.test(text);
}
