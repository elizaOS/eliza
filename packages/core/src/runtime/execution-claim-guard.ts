/**
 * Deterministic recognizer for Stage-1 replies that promise imminent tool or
 * background execution on a turn that routed NO tool work. A simple-path reply
 * like "i'll re-run the t=3 action now" or "i'm sending 10 and i'll paste the
 * exact return here as soon as it hits" (live 2026-08-24, tj-cb6f91c5e32afe,
 * tj-cc509ce7e91f86, tj-cc8c77e1691584, tj-d166d2a722e44d) is dishonest by
 * construction: with contexts=["simple"], requiresTool=false and no candidate
 * actions, nothing runs after the reply ships, so the promised output can
 * never land. The recognizer is text-only and deliberately narrow — it fires
 * on a first-person execution/delivery commitment paired with an imminence or
 * trigger clause (or an inherently tool-shaped verb), never on offers
 * ("i can run it if you want"), questions, or completed-work claims (those are
 * the side-effect-claims module's jurisdiction).
 */

/**
 * First-person future/progressive commitment to an execution or delivery
 * verb: "i'll paste …", "i will re-run …", "i'm going to send …",
 * "i'm sending …". Bare "will <verb>" is only matched sentence-initially
 * (see SENTENCE_INITIAL_WILL_RE) so third-person subjects ("the script will
 * paste …") never fire.
 */
const FIRST_PERSON_COMMIT_RE =
	/\bi(?:['’]ll| will| am going to|['’]?m (?:going to|gonna|about to))\s+(?:just\s+|go(?:\s+ahead\s+and)?\s+|also\s+|then\s+)*(re-?run|run|rerun|execute|send|paste|post|drop|share|fetch|pull|grab|check|verify|ping|nudge|remind|report(?: back)?|update|get back|circle back|follow(?:\s|-)?up|kick(?: off)?|fire(?: off)?|trigger|spawn|start|launch|schedule|set|watch|monitor|keep (?:an eye|watching)|stay on)\b/iu;

/**
 * First-person progressive claim of execution in flight: "i'm sending 10",
 * "i'm re-running it". Restricted to verbs that are unambiguously tool-shaped
 * in chat — chatty progressives ("i'm checking my notes", "i'm watching")
 * stay out; the routing layer's progress-ack promotion already owns short
 * "checking …" openers.
 */
const FIRST_PERSON_PROGRESSIVE_EXECUTION_RE =
	/\bi(?:['’]m| am)\s+(?:sending|running|re-?running|rerunning|executing|pasting|posting|fetching|spawning|launching|firing|triggering|kicking off)\b/iu;

/**
 * Sentence-initial subjectless commitment ("i'm on it. will post the exact
 * output here the second it lands."): "will <delivery-verb>" only at the
 * start of the reply or after sentence punctuation.
 */
const SENTENCE_INITIAL_WILL_RE =
	/(?:^|[.!?]\s+)will\s+(?:post|paste|send|drop|share|report|run|re-?run|rerun|ping|nudge|update)\b/iu;

/**
 * Imminence / trigger clause: the promise claims delivery now, shortly, on a
 * countdown, or the moment some awaited event fires ("the second it lands",
 * "as soon as it hits", "when the paste comes", "in 10 minutes").
 */
const IMMINENCE_RE =
	/\b(?:(?:right )?now|right away|one (?:sec(?:ond)?|moment)|in a (?:sec(?:ond)?|minute|bit|moment)|shortly|momentarily|as soon as|the (?:second|moment|minute) (?:it|that|this|they)|when (?:it|the|that|this)\b[^.?!\n]{0,60}\b(?:lands?|hits?|arrives?|comes?|returns?|finishes|completes|is (?:done|back|in))|once (?:it|the|that|this)\b[^.?!\n]{0,60}\b(?:lands?|hits?|arrives?|comes?|returns?|finishes|completes|is (?:done|back|in))|in \d+ ?(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?))\b/iu;

/**
 * Verbs whose first-person commitment is execution-shaped even without an
 * explicit imminence clause — "i'll re-run the action", "i'll paste the
 * output" are tool promises regardless of a stated deadline.
 */
const INHERENT_EXECUTION_VERB_RE =
	/^(?:re-?run|rerun|execute|paste|spawn|trigger|fire(?: off)?|kick(?: off)?|launch)$/iu;

/**
 * Find the first imminent-execution promise in a reply. Returns the matched
 * commitment fragment (for debug traces) or null when the reply makes no such
 * promise. Deterministic, no model.
 */
export function findImminentExecutionPromise(reply: string): string | null {
	const text = String(reply ?? "");
	if (!text.trim()) return null;

	const commit =
		FIRST_PERSON_COMMIT_RE.exec(text) ??
		FIRST_PERSON_PROGRESSIVE_EXECUTION_RE.exec(text) ??
		SENTENCE_INITIAL_WILL_RE.exec(text);
	if (!commit) return null;

	// Captured verb group exists only for FIRST_PERSON_COMMIT_RE; the other
	// shapes carry their verb inside the whole match.
	const verb = commit[1] ?? "";
	if (verb && INHERENT_EXECUTION_VERB_RE.test(verb)) {
		return commit[0].trim();
	}
	if (
		!commit[1] &&
		FIRST_PERSON_PROGRESSIVE_EXECUTION_RE.test(commit[0]) &&
		/\b(?:re-?running|rerunning|executing|pasting|spawning|launching|firing|triggering)\b/iu.test(
			commit[0],
		)
	) {
		return commit[0].trim();
	}
	if (IMMINENCE_RE.test(text)) {
		return commit[0].trim();
	}
	return null;
}

/** Boolean form of {@link findImminentExecutionPromise}. */
export function replyPromisesImminentExecution(reply: string): boolean {
	return findImminentExecutionPromise(reply) !== null;
}
