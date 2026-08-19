/**
 * Detectors for replies that assert ungrounded state: an already-completed
 * scheduling/save side effect ("I've set…", "Done — your reminders are set")
 * and the read-side twin — an empty/absent tracked-work state ("your task
 * list is empty", "I don't have today's log"). Lives in a leaf module because
 * the Stage-1 response-handler evaluators (services/message.ts), the
 * planner-path REPLY action guard (features/basic-capabilities/actions/
 * reply.ts), and the planned-reply egress guard all consume it — importing
 * the full message service from an action would create an import cycle.
 *
 * Detection is split by grammatical certainty so that only ASSERTIONS
 * fire; consent-seeking offers, questions, and conditionals must pass
 * through untouched (a rewritten offer forces an unwanted planner run — the
 * user asked a question and got an action).
 */

// Perfective first-person claims ("I've set…", "I have scheduled…", "I just
// added…") carry an explicit completion auxiliary, so they read as reports in
// any sentence shape — including tag questions ("I've set it — anything
// else?"). Only a leading subordinator ("Once I've set…") turns one into a
// plan instead of a report. Adjacency keeps denials out: "I have not set"
// never matches.
const PERFECTIVE_SIDE_EFFECT_CLAIM_PATTERN =
	/\bi(?:['’]ve|\s+have|\s+just)\s+(?:(?:just|already|now)\s+)?(?:set|scheduled|created|added|saved|booked|logged|arranged|updated|renamed|deleted|removed|cancell?ed)\b/gi;
// Bare simple-past claims ("I set a reminder for 9am."). "set" is the one
// verb here whose past tense equals its base form, so offers ("Should I
// set…?", "Before I set…") collide with reports on the raw pattern — this
// branch is additionally gated on the word preceding "I" and on the
// containing sentence not being a question.
const BARE_PAST_SIDE_EFFECT_CLAIM_PATTERN =
	/\bi\s+(?:set|scheduled|created|added|saved|booked|logged|arranged|updated|renamed|deleted|removed|cancell?ed)\b/gi;
// State-of-the-world completion claims that need no first-person subject
// ("that's all set", "your reminders are set", "is now set up", "Done —").
// The "now" forms and the bare completion opener ("Saved!", "Done.") were
// added after a live fabricated reply — "Saved! ✅ Your book report plan is
// now set up as reminders" with zero tool calls — slipped through the
// first-person-only shapes (#16941). The bare "done —" branch is anchored to
// the start of the (trimmed) reply or of a sentence, so congratulations like
// "Well done — that's every task cleared." are not misread (#16987).
const STATE_SIDE_EFFECT_CLAIM_PATTERN =
	/\b(?:(?:it['’]s|it is|you['’]re|that['’]s)\s+all\s+set\b|remind(?:er)?s?\s+(?:are|is)\s+(?:set|saved|scheduled|in\s+place)\b|(?:is|are)\s+now\s+(?:set(?:\s+up)?|saved|scheduled|in\s+place)\b)|(?:^|[.!?]\s+)done\s*[—–-]|^\s*(?:saved|done)\s*[!.…✅🎉]/giu;
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
	/\b(?:remind(?:er)?s?|alarms?|schedul(?:e|ed|ing)|scheduled\s+(?:task|item)s?|tasks?|appointments?|calendar|routines?|habits?|goals?|todos?|to[- ]dos?|notes?|check[- ]?ins?|follow[- ]?ups?|set[- ]?up|setup|onboard(?:ing)?|first[- ]?run|settings|defaults|configur(?:ation|ed))\b/i;

function sentenceContaining(text: string, index: number): string {
	let start = index;
	while (start > 0 && !/[.!?\n]/u.test(text[start - 1] ?? "")) {
		start -= 1;
	}
	let end = index;
	while (end < text.length && !/[.!?\n]/u.test(text[end] ?? "")) {
		end += 1;
	}
	return text.slice(start, end);
}

// Committed-mutation syntax. When a generic "done" opener's sentence carries
// one of these write verbs, it is a save/schedule report and outranks any
// read verb present ("Done — I saved your note and it's visible").
const COMMITTED_MUTATION_SYNTAX_PATTERN =
	/\b(?:set(?:\s+up)?|schedul(?:e|ed|ing)|saved|creat(?:e|ed)|add(?:s|ed)?|book(?:s|ed)?|logg(?:ed|ing)|arrang(?:e|ed)|updat(?:e|ed)|renam(?:e|ed)|delet(?:e|ed)|remov(?:e|ed)|cancell?(?:s|ed)?|in\s+place)\b/i;
// Read/navigation predicates. A tracked noun described only by one of these
// verbs was surfaced/opened, not committed ("Done — your notes are
// loaded/visible/on screen"), so a generic completion opener must NOT read as
// a mutation report (#22609).
const READ_NAVIGATION_PREDICATE_PATTERN =
	/\b(?:load(?:s|ed|ing)?|visible|shown|show(?:s|ing)?|display(?:s|ed|ing)?|open(?:s|ed|ing)?|render(?:s|ed|ing)?|onscreen|on\s+screen|in\s+view|pulled\s+up|brought\s+up|highlighted)\b/i;
// A bare completion opener ("Done —", "Done!", "Done.") carries no verb of its
// own — only the rest of its sentence can. Match text that begins with "done"
// (after the leading sentence-boundary anchor the STATE pattern captures)
// identifies these generic openers so they are held to the read-verb exclusion
// below.
const GENERIC_COMPLETION_OPENER_PATTERN = /^[\s.!?…–—-]*done\b/i;

/**
 * Bare completion openers must name their tracked subject in the same
 * sentence. A later question such as "Done. What should we do with your
 * notes?" mentions notes but does not claim a note was saved; treating the
 * whole reply as one clause replaces a true UI-navigation acknowledgement
 * with the unrelated unverified-effect fallback.
 *
 * A generic "done" opener is additionally rejected when its sentence's only
 * predicate is a read/navigation verb: "Done — your notes are loaded/visible"
 * (and the quantified variants) surfaced tracked state rather than committing a
 * write, so it is not a mutation report (#22609). A committed-mutation verb in
 * the same sentence overrides that exclusion, and openers whose own match text
 * carries the write verb ("reminders are set", "Saved!") are unaffected.
 */
function stateSideEffectClaimHasLocalSubject(text: string): boolean {
	for (const match of text.matchAll(STATE_SIDE_EFFECT_CLAIM_PATTERN)) {
		const firstWordOffset = match[0].search(/[\p{L}\p{N}]/u);
		const claimIndex =
			(match.index ?? 0) + (firstWordOffset >= 0 ? firstWordOffset : 0);
		const sentence = sentenceContaining(text, claimIndex);
		if (!SIDE_EFFECT_SUBJECT_NOUN_PATTERN.test(sentence)) continue;
		if (
			GENERIC_COMPLETION_OPENER_PATTERN.test(match[0]) &&
			READ_NAVIGATION_PREDICATE_PATTERN.test(sentence) &&
			!COMMITTED_MUTATION_SYNTAX_PATTERN.test(sentence)
		) {
			continue;
		}
		return true;
	}
	return false;
}

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
// Subjectless past-participle openers — "Added todo: sand the shelf",
// "saved a note: the charger is in the drawer", "Deleted the reminder." The
// live fabrication shape the I-subject patterns miss: the model reports
// finished work headline-style with no pronoun (observed on the Discord
// group surface: "Added todo: sand the dc5 shelf (no deadline, general
// task)" shipped with ZERO tool calls). Anchored to a sentence start so
// ordinary mid-sentence past tense ("the note I added yesterday") passes;
// bare "set" is deliberately absent — "Set a reminder on your phone…" is a
// common advisory imperative, not a report.
const SUBJECTLESS_PAST_SIDE_EFFECT_CLAIM_PATTERN =
	/(?:^|[.!?]\s+)(?:added|created|saved|scheduled|booked|logged|deleted|removed|renamed|cancell?ed|arranged)\b/gi;

// Noun-first passive headline claims — "todo added: polish the lens",
// "note saved.", "reminder set: 9am" (live variant that evaded the verb-first
// shape above: the model leads with the record noun). Requires the terminal
// claim punctuation/colon so descriptive prose ("the todo added by you last
// week…") passes through.
const NOUN_FIRST_SIDE_EFFECT_CLAIM_PATTERN =
	/(?:^|[.!?]\s+)(?:todos?|to[- ]dos?|notes?|reminders?|alarms?|tasks?|events?|appointments?|goals?|habits?)\s+(?:added|created|saved|scheduled|booked|logged|deleted|removed|renamed|cancell?ed|set|updated)\s*(?::|[.!…]|$)/gi;

export function replyClaimsCompletedSideEffect(reply: string): boolean {
	const text = reply.trim();
	if (!text) return false;
	if (!SIDE_EFFECT_SUBJECT_NOUN_PATTERN.test(text)) return false;
	if (stateSideEffectClaimHasLocalSubject(text)) return true;
	for (const match of text.matchAll(
		SUBJECTLESS_PAST_SIDE_EFFECT_CLAIM_PATTERN,
	)) {
		if (sideEffectClaimSentenceIsQuestion(text, match.index)) continue;
		return true;
	}
	for (const match of text.matchAll(NOUN_FIRST_SIDE_EFFECT_CLAIM_PATTERN)) {
		if (sideEffectClaimSentenceIsQuestion(text, match.index)) continue;
		return true;
	}
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

// Read-side twin of the completed-side-effect patterns above: assertions that
// the user's TRACKED WORK is empty/absent ("your task list is empty", "no
// notes, tasks, or messages from earlier today", "I don't have today's log").
// On a path where no read tool ran, such a reply conflates "not loaded" with
// "zero" — the exact conflation the error doctrine bans on data paths. Each
// branch is anchored to tracked-work nouns so ordinary chat ("no messages from
// Bob in this thread") passes through; chat-recall stays owned by the
// visible-context-recall exception.
const EMPTY_TRACKED_STATE_CLAIM_PATTERNS: readonly RegExp[] = [
	// "your task list is empty", "the todo list looks clear"
	/\b(?:task|todo|to[- ]do|reminder|goal|habit)s?\s+list\s+(?:is|looks|seems|appears)\s+(?:empty|clear|blank)\b/gi,
	// "no notes, tasks, or messages from earlier today", "no tasks logged"
	/\b(?:no|zero)\s+(?:new\s+)?(?:notes?|tasks?|todos?|to[- ]dos?|reminders?|habits?|goals?|entries)\b[^.!?\n]*\b(?:today|tonight|this\s+morning|this\s+afternoon|this\s+evening|so\s+far|earlier|logged|recorded|saved|tracked|on\s+file)\b/gi,
	// "I don't have today's log (in front of me)", "I don't have your task list"
	/\bi\s+don['’]t\s+have\s+(?:today['’]s|your)\s+(?:log|notes?|list|tasks?|todos?)\b/gi,
	// "nothing logged today", "nothing was recorded this morning"
	/\bnothing\s+(?:is\s+|was\s+|got\s+)?(?:logged|recorded|written\s+down|saved|tracked)\b[^.!?\n]*\b(?:today|tonight|yesterday|this\s+(?:morning|afternoon|evening|week)|so\s+far)\b/gi,
	// "nothing on your list/schedule/plate"
	/\bnothing\s+(?:is\s+)?on\s+(?:your|the)\s+(?:list|schedule|plate|docket)\b/gi,
	// "your day is wide open", "your schedule looks clear"
	/\byour\s+(?:day|schedule|slate)\s+(?:is|looks|seems|appears)\s+(?:empty|clear|blank|free|wide\s+open)\b/gi,
];

// A subordinator opening the clause turns the match into a hypothetical ("If
// your task list is empty, we could…"), not a report of looked-up state.
const CONDITIONAL_EMPTY_CLAIM_LEAD_PATTERN =
	/\b(?:if|unless|when|whenever|once|whether|in\s+case)\b[^.!?\n]*$/i;

/**
 * True when a reply ASSERTS that the user's tracked work (tasks, todos,
 * reminders, habits, goals, notes, day log) is empty or unavailable. On a path
 * where no read tool ran, that assertion fabricates an empty day — "not loaded
 * must never read as zero" applied to READS (#17059; observed live: a recap ask
 * routed contexts=["simple"] and answered "I don't have today's log in front of
 * me — no notes, tasks, or messages from earlier today", run 729acaf2).
 * Questions and conditionals pass through: asking the user whether their list
 * is empty is not a claim about looked-up state.
 */
export function replyClaimsEmptyTrackedWorkState(reply: string): boolean {
	const text = reply.trim();
	if (!text) return false;
	for (const pattern of EMPTY_TRACKED_STATE_CLAIM_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			const prefix = text.slice(0, match.index);
			if (CONDITIONAL_EMPTY_CLAIM_LEAD_PATTERN.test(prefix)) continue;
			if (sideEffectClaimSentenceIsQuestion(text, match.index)) continue;
			return true;
		}
	}
	return false;
}
