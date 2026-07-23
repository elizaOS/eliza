/**
 * Detector for replies that assert an already-completed scheduling/save side
 * effect ("I've set…", "Done — your reminders are set"). Lives in a leaf
 * module because both the Stage-1 response-handler evaluator
 * (`core.simple_completed_side_effect_claim`, services/message.ts) and the
 * planner-path REPLY action guard (features/basic-capabilities/actions/
 * reply.ts) consume it — importing the full message service from an action
 * would create an import cycle.
 *
 * Detection is split by grammatical certainty so that only ASSERTIONS of
 * finished work fire; consent-seeking offers, questions, and conditionals
 * must pass through untouched (a rewritten offer forces an unwanted planner
 * run — the user asked a question and got an action).
 */

// Perfective first-person claims ("I've set…", "I have scheduled…", "I just
// added…") carry an explicit completion auxiliary, so they read as reports in
// any sentence shape — including tag questions ("I've set it — anything
// else?"). Only a leading subordinator ("Once I've set…") turns one into a
// plan instead of a report. Adjacency keeps denials out: "I have not set"
// never matches.
const PERFECTIVE_SIDE_EFFECT_CLAIM_PATTERN =
	/\bi(?:['’]ve|\s+have|\s+just)\s+(?:(?:just|already|now)\s+)?(?:set|scheduled|created|added|saved|booked|logged|arranged)\b/gi;
// Bare simple-past claims ("I set a reminder for 9am."). "set" is the one
// verb here whose past tense equals its base form, so offers ("Should I
// set…?", "Before I set…") collide with reports on the raw pattern — this
// branch is additionally gated on the word preceding "I" and on the
// containing sentence not being a question.
const BARE_PAST_SIDE_EFFECT_CLAIM_PATTERN =
	/\bi\s+(?:set|scheduled|created|added|saved|booked|logged|arranged)\b/gi;
// State-of-the-world completion claims that need no first-person subject
// ("that's all set", "your reminders are set", "is now set up", "Done —").
// The "now" forms and the bare completion opener ("Saved!", "Done.") were
// added after a live fabricated reply — "Saved! ✅ Your book report plan is
// now set up as reminders" with zero tool calls — slipped through the
// first-person-only shapes (#16941). The bare "done —" branch is anchored to
// the start of the (trimmed) reply or of a sentence, so congratulations like
// "Well done — that's every task cleared." are not misread (#16987).
const STATE_SIDE_EFFECT_CLAIM_PATTERN =
	/\b(?:(?:it['’]s|it is|you['’]re|that['’]s)\s+all\s+set\b|remind(?:er)?s?\s+(?:are|is)\s+(?:set|saved|scheduled|in\s+place)\b|(?:is|are)\s+now\s+(?:set(?:\s+up)?|saved|scheduled|in\s+place)\b)|(?:^|[.!?]\s+)done\s*[—–-]|^\s*(?:saved|done)\s*[!.…✅🎉]/iu;
// A modal, interrogative auxiliary, or subordinator immediately before the
// matched "I" makes the clause an offer/question/condition ("Should I
// set…?", "Shall I set…?", "When I set…", "Once I've set…"), not a report of
// finished work.
const NON_ASSERTIVE_SIDE_EFFECT_LEAD_PATTERN =
	/\b(?:should|shall|can|could|may|might|would|will|do|does|did|must|if|unless|once|when|whenever|while|before|after|until|whether)\s+$/i;
// The claim must be ABOUT a schedulable/saved thing, not e.g. "I've set aside
// some thoughts". Vocabulary mirrors the scheduled-item nouns the LifeOps
// surfaces own.
const SIDE_EFFECT_SUBJECT_NOUN_PATTERN =
	/\b(?:remind(?:er)?s?|alarms?|schedul(?:e|ed|ing)|scheduled\s+(?:task|item)s?|tasks?|appointments?|calendar|routines?|habits?|goals?|todos?|to[- ]dos?|check[- ]?ins?|follow[- ]?ups?)\b/i;

// True when the sentence containing the match (scanning forward from the
// match) terminates in "?" — the shape of a consent-seeking offer or a
// clarifying question ("I set reminders in the morning usually — should I?").
function sideEffectClaimSentenceIsQuestion(
	text: string,
	fromIndex: number,
): boolean {
	for (let i = fromIndex; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === "?") return true;
		if (ch === "." || ch === "!" || ch === "\n") return false;
	}
	return false;
}

/**
 * True when a reply ASSERTS that a scheduling/save side effect already
 * happened. When no tool has run in the turn any such assertion is
 * fabricated — the "not loaded must never read as zero" doctrine applied to
 * writes: "no tool ran" must never read as "done" (#16935; observed live: a
 * bill-reminder ask answered "Done — I've set two reminders" with zero tool
 * calls, plus invented "session-only" caveats). Consent-seeking offers,
 * questions, and conditionals ("Want me to set…?", "Should I set…?", "I could
 * set…") are NOT claims and must return false — rewriting them to "On it."
 * turns a question the user asked into an action they did not consent to.
 */
export function replyClaimsCompletedSideEffect(reply: string): boolean {
	const text = reply.trim();
	if (!text) return false;
	if (!SIDE_EFFECT_SUBJECT_NOUN_PATTERN.test(text)) return false;
	if (STATE_SIDE_EFFECT_CLAIM_PATTERN.test(text)) return true;
	for (const match of text.matchAll(PERFECTIVE_SIDE_EFFECT_CLAIM_PATTERN)) {
		if (
			!NON_ASSERTIVE_SIDE_EFFECT_LEAD_PATTERN.test(text.slice(0, match.index))
		) {
			return true;
		}
	}
	for (const match of text.matchAll(BARE_PAST_SIDE_EFFECT_CLAIM_PATTERN)) {
		const prefix = text.slice(0, match.index);
		if (NON_ASSERTIVE_SIDE_EFFECT_LEAD_PATTERN.test(prefix)) continue;
		if (sideEffectClaimSentenceIsQuestion(text, match.index)) continue;
		return true;
	}
	return false;
}
