/**
 * Detect refusal-shaped openings in model-generated replyText.
 *
 * Background: weaker / safety-tuned planner models (Cerebras-hosted
 * `gpt-oss-120b`, `qwen-3-235b-a22b-instruct-2507`, etc.) sometimes emit a
 * refusal in Stage-1 `replyText` even when the same turn correctly populates
 * `candidateActionNames` and routes to a planning context. The refusal text
 * then ships to the user via the early-reply path and contradicts the
 * planner's subsequent action call. See elizaOS/eliza#7620.
 *
 * This detector is intentionally conservative: it only matches replies that
 * OPEN with an explicit refusal (anchored at the start of the trimmed
 * string). Acknowledgements ("On it, spawning...", "Sure, I'll handle that")
 * never match. Mid-sentence "I can't promise it'll work first try" never
 * matches. The goal is zero false positives on the acknowledgement path;
 * false negatives (a creatively-worded refusal slipping through) just
 * regress to the pre-fix behaviour.
 *
 * Use sites:
 *  - `parseMessageHandlerOutput` (`runtime/message-handler.ts`) suppresses
 *    `plan.reply` when the parsed envelope routes to a planning context
 *    (non-simple contexts OR candidateActions present) AND
 *    `looksLikeRefusal(replyText)`.
 *  - `messageHandlerFromFieldResult` (`services/message.ts`) applies the
 *    same suppression on the field-registry path.
 *
 * The planner stage's reply is then the only one the user sees.
 */

// Apostrophe class — covers the straight ASCII apostrophe (U+0027) plus the
// curly singles models occasionally emit (U+2018 / U+2019) and a stray
// backtick (U+0060). Used everywhere we need to match `'m`, `'t`, etc.
const APOS = "['‘’`]";

// "I" — optionally followed by "'m" (contracted) or " am" (long form).
const I_PRONOUN_OR_IM = `i(?:\\s*${APOS}\\s*m|\\s+am)?`;

// Common opener prefixes that often precede the refusal verb. Optional in
// every pattern below.
const REFUSAL_PREFIX_GROUP = `(?:(?:sorry|apologies)[,.!]?\\s+(?:but\\s+)?|unfortunately,?\\s+|as\\s+an?\\s+(?:ai|assistant|llm|language\\s+model)[^.]{0,80}[,.!]?\\s+)?`;

/**
 * Refusal openers — must match at the start of the trimmed text.
 *
 * Each pattern is anchored with `^\s*` (allow leading whitespace only) and
 * uses `\b` boundaries so partial-word matches do not fire. Built from the
 * verbatim refusals reported in #7620 plus common Anthropic / OpenAI /
 * open-weights refusal templates.
 */
const REFUSAL_OPENERS: readonly RegExp[] = [
	// "I (am | 'm) (unable | not able) to ..."
	new RegExp(
		`^\\s*${REFUSAL_PREFIX_GROUP}${I_PRONOUN_OR_IM}\\s+(?:unable|not\\s+able)\\s+to\\b`,
		"i",
	),
	// "I (cannot | can't | can not) ..."
	new RegExp(
		`^\\s*${REFUSAL_PREFIX_GROUP}i\\s+(?:cannot|can${APOS}?t|can\\s+not)\\b`,
		"i",
	),
	// "I don't have the (ability | access | capability | permission | tools | means | way) to ..."
	new RegExp(
		`^\\s*${REFUSAL_PREFIX_GROUP}i\\s+do\\s*n${APOS}?o?t\\s+have\\s+(?:the\\s+)?(?:ability|access|capability|capabilities|permission|tools?|means|way)\\s+to\\b`,
		"i",
	),
	// "It's not possible for me to ..."
	new RegExp(`^\\s*it${APOS}?s\\s+not\\s+possible\\s+for\\s+me\\s+to\\b`, "i"),
];

/**
 * Hedge phrases. Strong evidence of a refusal when combined with a
 * "cannot / unable" verb anywhere in the reply (e.g. a model that opened
 * with a polite "Got it, but I'm unable to do this in this context").
 */
const HEDGE_PATTERNS: readonly RegExp[] = [
	/\bin\s+(?:this|the\s+current|my\s+current)\s+(?:context|environment|session|conversation|chat|setup|configuration|mode|sandbox)\b/i,
];

const SECONDARY_REFUSAL_VERBS = new RegExp(
	`\\bi(?:\\s*${APOS}\\s*m|\\s+am)?\\s+(?:cannot|can${APOS}?t|can\\s+not|unable|not\\s+able|do\\s*n${APOS}?o?t\\s+have\\s+(?:the\\s+)?(?:ability|access|capability|capabilities|permission|tools?|means|way))\\b`,
	"i",
);

/**
 * Returns true when `replyText` opens with — or strongly resembles — a
 * model refusal of the user's request.
 *
 * Conservative: never returns true for short greetings or empty strings,
 * and only matches at the START of the trimmed text (or, in the
 * hedge-fallback path, requires both a hedge phrase AND a refusal verb in
 * the same reply).
 */
export function looksLikeRefusal(text: string | undefined | null): boolean {
	if (typeof text !== "string") return false;
	const trimmed = text.trim();
	if (trimmed.length < 12) return false;

	for (const pattern of REFUSAL_OPENERS) {
		if (pattern.test(trimmed)) return true;
	}

	const hasHedge = HEDGE_PATTERNS.some((pattern) => pattern.test(trimmed));
	if (hasHedge && SECONDARY_REFUSAL_VERBS.test(trimmed)) {
		return true;
	}

	return false;
}
