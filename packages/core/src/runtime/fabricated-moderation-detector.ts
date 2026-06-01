/**
 * Detect fabricated content-moderation / policy-enforcement claims in
 * model-generated `replyText`.
 *
 * Background: the system prompt forbids attributing a refusal or the agent's own
 * behavior to a moderation system, content filter, "usage policies", "safety
 * guidelines", or an automatic block that does not actually exist in this
 * runtime (`packages/prompts/src/index.ts`). There is no such enforcer sitting
 * between the agent and the user; inventing one is, in the prompt's words, "a
 * lie about how you work". Hosted planner models nonetheless reach for these
 * excuses when they decline — the same prompt-contract violation class that
 * motivated `looksLikeRefusal` (see `refusal-detector.ts`).
 *
 * This detector is the structural net for that rule. Every pattern requires
 * SELF / POSSESSIVE framing ("our usage policies", "my content filter", "I was
 * blocked", "your request was flagged", "the system blocked your message") so
 * that legitimately discussing a third party's policies ("Stripe's usage
 * policies state ...") or describing a real runtime error ("the request was
 * blocked by CORS") never matches. Matched anywhere in the trimmed text.
 *
 * Note: describing an ACTUAL tool/runtime error this turn is explicitly allowed
 * by the prompt — hence the patterns target invented *moderation* framing, not
 * generic "blocked/failed" language.
 *
 * Use sites: the planning-path reply suppression in `parseMessageHandlerOutput`
 * (`runtime/message-handler.ts`) and `messageHandlerFromFieldResult`
 * (`services/message.ts`), alongside `looksLikeRefusal` and
 * `looksLikeTrainingCutoffLeak`. When a planning path is selected the planner
 * produces the user-facing message, so a fabricated-moderation Stage-1
 * `replyText` is blanked.
 */

// Apostrophe class — ASCII (U+0027), curly singles (U+2018/U+2019), backtick.
const APOS = "['‘’`]";

/**
 * Fabricated-moderation phrases. Each requires self/possessive framing so that
 * third-party policy mentions and genuine runtime-error descriptions do not
 * match. Built from the forbidden phrases enumerated in the system-prompt
 * honesty rule.
 */
const FABRICATED_MODERATION_PATTERNS: readonly RegExp[] = [
	// "violates / breaches / against our|the|my usage|content|community|safety policies|guidelines|standards|rules"
	/\b(?:violat\w+|breach\w+|against)\s+(?:our|the|my)\s+(?:usage|content|community|safety)\s+(?:polic\w+|guidelines?|standards?|rules?)\b/i,
	// "your request|message|previous message|input|prompt|content (was|got|has been) flagged|rejected"
	/\byour\s+(?:request|message|previous message|input|prompt|content)\s+(?:(?:was|were|got|has been)\s+)?(?:flagged|rejected)\b/i,
	// "your request|message|... was blocked by the system/content filter/moderation system"
	/\byour\s+(?:request|message|previous message|input|prompt|content)\s+(?:(?:was|were|got|has been)\s+)?blocked\s+by\s+(?:the\s+)?(?:system|content\s+filter|(?:content\s+)?moderation\s+(?:system|filter|layer|policy)|safety\s+(?:system|filter|policy))\b/i,
	// "my|the|our content filter"
	/\b(?:my|the|our)\s+content\s+filter\b/i,
	// "I (was|am|got|'m) blocked from ..." — "'m" is contracted (no space before it)
	new RegExp(
		`\\bi(?:\\s+(?:was|am|got)|\\s*${APOS}\\s*m)\\s+blocked\\s+from\\b`,
		"i",
	),
	// "my|our safety guidelines | usage policies | content policies"
	/\b(?:my|our)\s+(?:safety\s+guidelines?|usage\s+polic\w+|content\s+polic\w+)\b/i,
	// "my|our|the (content) moderation system|filter|layer|policy"
	/\b(?:my|our|the)\s+(?:content\s+)?moderation\s+(?:system|filter|layer|policy)\b/i,
	// "your request|message|... contained hateful|harmful|inappropriate|abusive|offensive language|content|material|speech"
	/\byour\s+(?:request|message|previous message|input|prompt|content)\s+contained\s+(?:hateful|harmful|inappropriate|abusive|offensive)\s+(?:language|content|material|speech)\b/i,
	// "the system (automatically) blocked|flagged|prevented|filtered this|that|it|your|the request|message|content|response|reply"
	/(?:^|[.!?]\s+)(?:the\s+)?system\s+(?:automatically\s+)?(?:blocked|flagged|prevented|filtered)\s+(?:this|that|it|your|the\s+(?:request|message|content|response|reply))\b/i,
];

/**
 * Returns true when `text` blames a refusal or the agent's behavior on a
 * moderation system / content filter / usage policy that does not exist in this
 * runtime.
 *
 * Conservative: never returns true for empty/short strings; requires
 * self/possessive framing so third-party policy mentions and genuine runtime
 * errors do not match.
 */
export function looksLikeFabricatedModeration(
	text: string | undefined | null,
): boolean {
	if (typeof text !== "string") return false;
	const trimmed = text.trim();
	if (trimmed.length < 8) return false;

	for (const pattern of FABRICATED_MODERATION_PATTERNS) {
		if (pattern.test(trimmed)) return true;
	}

	return false;
}
