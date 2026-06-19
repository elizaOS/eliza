import type { PersonalitySlot, ReplyGateMode } from "./types.ts";

/**
 * Pure decision for whether the agent should respond at all given a reply
 * gate setting. Used by the message runtime to short-circuit BEFORE the
 * model call when a user has asked the agent to "shut up" or only respond
 * on mention.
 *
 * Resolution order (most specific wins):
 *   1. user slot reply_gate (if set)
 *   2. global slot reply_gate (if set)
 *   3. "always" (no gate)
 */
export type ReplyGateDecision =
	| { allow: true; reason: "no_gate" | "lift_signal" | "on_mention_satisfied" }
	| {
			allow: false;
			reason: "never_until_lift" | "on_mention_not_addressed";
			gateMode: ReplyGateMode;
			scope: "user" | "global";
	  };

export interface ReplyGateInput {
	userSlot?: PersonalitySlot | null;
	globalSlot?: PersonalitySlot | null;
	messageText: string | undefined;
	explicitlyAddressesAgent: boolean;
}

export function resolveEffectiveReplyGate(
	userSlot: PersonalitySlot | null | undefined,
	globalSlot: PersonalitySlot | null | undefined,
): { mode: ReplyGateMode | null; scope: "user" | "global" | null } {
	if (userSlot?.reply_gate) {
		return { mode: userSlot.reply_gate, scope: "user" };
	}
	if (globalSlot?.reply_gate) {
		return { mode: globalSlot.reply_gate, scope: "global" };
	}
	return { mode: null, scope: null };
}

/**
 * Words/phrases that lift a `never_until_lift` gate. Kept as an explicit list
 * (not free-form LLM matching) so the behavior is predictable and testable.
 *
 * The "wake-up" phrase must be at the very start of the message (case-insensitive,
 * leading whitespace tolerated) so casual mentions don't accidentally unmute.
 */
const LIFT_PHRASES: ReadonlyArray<RegExp> = [
	/^\s*ok(?:ay)?\s+(?:you can\s+)?talk(?:\s+again)?\b/i,
	/^\s*you can talk(?:\s+again)?\b/i,
	/^\s*(?:please\s+)?un(?:mute|silence)\b/i,
	/^\s*(?:lift|cancel|clear|remove)\s+(?:the\s+)?(?:silence|mute|shut.?up|gag)\b/i,
	/^\s*(?:come back|wake up)\b/i,
	/^\s*(?:start|begin)\s+(?:responding|talking|replying)\s+again\b/i,
];

export function messageContainsLiftSignal(
	text: string | undefined,
	explicitlyAddressesAgent: boolean,
): boolean {
	if (!text) return false;
	if (explicitlyAddressesAgent) {
		// An @-mention or direct address acts as a lift signal too — the user
		// is clearly trying to interact again.
		return true;
	}
	return LIFT_PHRASES.some((re) => re.test(text));
}

export function decideReplyGate(input: ReplyGateInput): ReplyGateDecision {
	const { mode, scope } = resolveEffectiveReplyGate(
		input.userSlot,
		input.globalSlot,
	);

	if (!mode || mode === "always") {
		return { allow: true, reason: "no_gate" };
	}

	if (mode === "on_mention") {
		if (input.explicitlyAddressesAgent) {
			return { allow: true, reason: "on_mention_satisfied" };
		}
		return {
			allow: false,
			reason: "on_mention_not_addressed",
			gateMode: mode,
			// scope is non-null when mode is non-null
			scope: scope ?? "user",
		};
	}

	// mode === "never_until_lift"
	if (
		messageContainsLiftSignal(input.messageText, input.explicitlyAddressesAgent)
	) {
		return { allow: true, reason: "lift_signal" };
	}
	return {
		allow: false,
		reason: "never_until_lift",
		gateMode: mode,
		scope: scope ?? "user",
	};
}
