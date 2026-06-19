/**
 * Client-side shouldRespond gate for always-on voice.
 *
 * In always-on ("hands-free") mode the mic is open continuously, so the
 * recognizer transcribes EVERYTHING it hears — including the agent's own
 * text-to-speech bleeding back into the mic, and the speaker's disfluent
 * thinking noises ("um…", "uh…"). Sending those as turns makes the agent reply
 * to itself or to filler — the "responding when it's not appropriate" problem.
 *
 * This is a conservative gate: it only suppresses turns we're confident are NOT
 * directed requests — pure disfluency, or a near-verbatim echo of what the agent
 * just said. Everything else (real questions, commands, even short answers like
 * "yes"/"stop") passes through. The full semantic shouldRespond (wake-word /
 * direct-address / the server `core.voice_turn_signal` evaluator) is a separate,
 * heavier layer; this handles the two cases that actually annoy users today.
 */

/** Pure disfluencies — never a meaningful turn on their own. NOT answers. */
const DISFLUENCIES = new Set([
  "um",
  "uh",
  "uhh",
  "uhm",
  "umm",
  "hmm",
  "hm",
  "mm",
  "mmm",
  "er",
  "erm",
  "ah",
  "eh",
]);

/** How recent the agent's reply must be for the echo guard to apply. */
const ECHO_WINDOW_MS = 9000;
/** Word-overlap fraction above which a turn is treated as TTS echo. */
const ECHO_OVERLAP_THRESHOLD = 0.7;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/gi, "")
    .split(/\s+/)
    .filter(Boolean);
}

export interface ShouldRespondContext {
  /** The agent's most recent spoken reply, for the echo guard. */
  recentAgentReply?: string;
  /** Age of that reply in ms; the echo guard applies while it's recent. */
  replyAgeMs?: number;
  /**
   * True while the agent is CURRENTLY speaking. Forces the echo guard on
   * regardless of `replyAgeMs`, because a long reply's TTS is actively bleeding
   * into the open mic even though its message was created many seconds ago (the
   * age-only window would have already expired mid-speech).
   */
  agentSpeaking?: boolean;
}

/**
 * Whether a transcribed voice turn should be sent to the agent (i.e. warrants a
 * response). Returns false for pure disfluency and for near-verbatim echoes of
 * the agent's recent speech.
 */
export function shouldRespondToVoiceTurn(
  transcript: string,
  context: ShouldRespondContext = {},
): boolean {
  const w = words(transcript);
  if (w.length === 0) return false;

  // Pure disfluency ("um", "uh huh"… with nothing substantive) → ignore.
  if (w.every((word) => DISFLUENCIES.has(word))) return false;

  // Self-echo: the agent's own TTS heard back through the mic. Only consider it
  // while the reply is recent, and only for multi-word turns (a one-word answer
  // shouldn't be suppressed just because the word also appears in the reply).
  const reply = context.recentAgentReply?.trim();
  const age = context.replyAgeMs ?? Number.POSITIVE_INFINITY;
  const echoActive = context.agentSpeaking === true || age <= ECHO_WINDOW_MS;
  if (reply && echoActive && w.length >= 2) {
    const replyWords = new Set(words(reply));
    if (replyWords.size > 0) {
      const overlap =
        w.filter((word) => replyWords.has(word)).length / w.length;
      if (overlap >= ECHO_OVERLAP_THRESHOLD) return false;
    }
  }

  return true;
}
