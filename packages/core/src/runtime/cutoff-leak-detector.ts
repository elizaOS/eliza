/**
 * Detect training-metadata / knowledge-cutoff leaks in model-generated
 * `replyText`.
 *
 * Background: the system prompt forbids exposing the underlying LLM's training
 * metadata to the user (`packages/prompts/src/index.ts`) — phrases like "as of
 * my training data", "my knowledge cutoff", "I was trained on", "I was last
 * updated", "the latest information I have is from". The agent has a character
 * (a name, a role, a persona); the model beneath it does not exist to the user.
 * Weaker / safety-tuned hosted planner models (Cerebras-served `gpt-oss-120b`,
 * `qwen-3-235b-a22b-instruct-2507`) still emit these phrases even with the
 * prompt rule in place — the same class of prompt-contract violation that
 * motivated `looksLikeRefusal` (see `refusal-detector.ts`).
 *
 * This detector is the structural net for that rule: a closed, distinctive set
 * of cutoff phrases that almost never appear in honest, in-character replies.
 * Unlike a refusal (which OPENS the reply and is anchored at the start), a
 * cutoff leak frequently appears mid-sentence ("Happy to help, but as of my
 * training data in 2023 ..."), so these patterns match ANYWHERE in the trimmed
 * text. They are specific enough to keep false positives near zero — a third
 * party's "training data" ("the model's training cutoff") references the model
 * directly and is intentionally caught; an honest statement that never names
 * the model's own knowledge horizon ("let me check the latest information")
 * does not match.
 *
 * The prompt's EXCEPTION — the current date/time/year is always known from the
 * runtime `CURRENT_TIME` signal — needs no handling here: a correct date answer
 * ("Today is June 1, 2026") contains none of these phrases.
 *
 * Use sites: the planning-path reply suppression in `parseMessageHandlerOutput`
 * (`runtime/message-handler.ts`) and `messageHandlerFromFieldResult`
 * (`services/message.ts`), alongside `looksLikeRefusal`. When a planning path is
 * selected the planner stage produces the user-facing message, so a leaky
 * Stage-1 `replyText` is blanked and the planner's message is the only one the
 * user sees.
 */

/**
 * Training-metadata / knowledge-cutoff phrases. Matched anywhere in the reply
 * (cutoff leaks are commonly mid-sentence). Built verbatim from the forbidden
 * phrases enumerated in the system-prompt honesty rule.
 */
const CUTOFF_LEAK_PATTERNS: readonly RegExp[] = [
	// "as of my last/latest update | training | knowledge | last training | most recent update/training"
	/\bas of my (?:last update|latest update|training|knowledge|last training|most recent (?:update|training))\b/i,
	// "knowledge / training cutoff" (and "cut-off" / "cut off") — references the model's own horizon
	/\b(?:knowledge|training)\s*cut[\s-]?off\b/i,
	// "I was trained on | up to | until | through ...", "I was last updated | last trained"
	/\bi\s+was\s+(?:trained\s+(?:on|up\s+to|until|through)|last\s+(?:updated|trained))\b/i,
	// "the latest information / data / knowledge I have is/dates/goes from | to | up to | back to ..."
	/\bthe latest (?:information|data|knowledge) i have (?:is|dates|goes)?\s*(?:from|to|up to|back to)\b/i,
	// "based on data through ...", "based on the data I was trained on", "based on my training data"
	/\bbased on (?:data through|the data i was trained on|my training data)\b/i,
	// "my training data | set | corpus"
	/\bmy training (?:data|set|corpus)\b/i,
];

/**
 * Returns true when `text` exposes the underlying model's training metadata or
 * knowledge cutoff to the user.
 *
 * Conservative: never returns true for empty/short strings, and only matches a
 * closed set of distinctive model-self-reference phrases.
 */
export function looksLikeTrainingCutoffLeak(
	text: string | undefined | null,
): boolean {
	if (typeof text !== "string") return false;
	const trimmed = text.trim();
	if (trimmed.length < 8) return false;

	for (const pattern of CUTOFF_LEAK_PATTERNS) {
		if (pattern.test(trimmed)) return true;
	}

	return false;
}
