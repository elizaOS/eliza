/** Canonical tag names used by models to delimit private reasoning. */
export const REASONING_TAG_NAMES = [
	"think",
	"thinking",
	"reasoning",
	"reflection",
	"thought",
	"antthinking",
] as const;

const REASONING_TAG_ALTERNATION = REASONING_TAG_NAMES.join("|");
const REASONING_TAG_SOURCE = `<\\s*\\/?\\s*(?:${REASONING_TAG_ALTERNATION})\\b[^>]*>`;
const REASONING_CLOSE_TAG_RE = new RegExp(
	`<\\s*\\/\\s*(?:${REASONING_TAG_ALTERNATION})\\s*>`,
	"gi",
);
const REASONING_TAG_RE = new RegExp(REASONING_TAG_SOURCE, "gi");
// Deliberately non-global: `RegExp.prototype.test` on a global regex advances
// and retains `lastIndex`, so identical input alternates true/false across
// calls. Residue detection must be stateless — do not add the `g` flag here.
const REASONING_TAG_TEST_RE = new RegExp(REASONING_TAG_SOURCE, "i");

/**
 * Remove private-reasoning prefixes and any remaining reasoning tag tokens.
 * Content through the last completed closing tag is private model output; a
 * stray open tag is removed without guessing where its unterminated content
 * ends, allowing the caller to reject malformed surrounding output safely.
 */
export function stripReasoningPrefixes(text: string): string {
	let lastCloseEnd = -1;
	for (const match of text.matchAll(REASONING_CLOSE_TAG_RE)) {
		lastCloseEnd = (match.index ?? 0) + match[0].length;
	}
	const visible = lastCloseEnd >= 0 ? text.slice(lastCloseEnd) : text;
	return visible.replace(REASONING_TAG_RE, "");
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
	return REASONING_TAG_TEST_RE.test(text);
}
