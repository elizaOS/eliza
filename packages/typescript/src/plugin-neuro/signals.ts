/**
 * Signal constants, emoji sentiment map, and timing thresholds for plugin-neuro.
 *
 * WHY centralize here: signal kind strings are used across evaluator,
 * continuation, reaction, and finalizer. A typo in a signal name would
 * silently create a new, unweighted signal. Constants catch this at
 * compile time and provide a single source of truth for the signal taxonomy.
 */

// Signal source identifier
export const NEURO_SOURCE = "neuro";

// Signal kinds
export const SIGNALS = {
	REACTION_POSITIVE: "reaction_positive",
	REACTION_NEGATIVE: "reaction_negative",
	REACTION_NEUTRAL: "reaction_neutral",
	USER_CORRECTION: "user_correction",
	CONVERSATION_CONTINUED: "conversation_continued",
	RESPONSE_LATENCY: "response_latency",
	LENGTH_APPROPRIATENESS: "length_appropriateness",
	EVALUATOR_AGREEMENT: "evaluator_agreement",
} as const;

/**
 * Emoji sentiment map for REACTION_RECEIVED events.
 * Values: 1.0 = positive, 0.5 = neutral, 0.0 = negative
 */
export const EMOJI_SENTIMENT: Record<string, number> = {
	// Positive
	"👍": 1.0,
	"❤️": 1.0,
	"🔥": 1.0,
	"⭐": 1.0,
	"🌟": 1.0,
	"💯": 1.0,
	"🙏": 1.0,
	"😊": 1.0,
	"😄": 1.0,
	"😍": 1.0,
	"🎉": 1.0,
	"✅": 1.0,
	"💪": 1.0,
	"+1": 1.0,

	// Neutral
	"🤔": 0.5,
	"😐": 0.5,
	"🫤": 0.5,

	// Negative
	"👎": 0.0,
	"😠": 0.0,
	"😡": 0.0,
	"🤬": 0.0,
	"❌": 0.0,
	"-1": 0.0,
};

/** WHY 2 minutes: short enough that a reply within the window is likely a
 *  direct response to the agent (not a new topic), long enough to accommodate
 *  users who read slowly or get interrupted. */
export const CONTINUATION_WINDOW_MS = 120_000;

/** WHY 100: large enough for stable medians, small enough to adapt to
 *  changing conversation patterns within a session. */
export const ROLLING_WINDOW_SIZE = 100;
