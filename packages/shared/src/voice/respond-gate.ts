/**
 * Canonical client-side shouldRespond / echo-rejection gate for always-on voice.
 *
 * In always-on ("hands-free") mode the mic is open continuously, so the
 * recognizer transcribes EVERYTHING it hears — the agent's own text-to-speech
 * bleeding back into the mic, the speaker's disfluent thinking noises ("um…"),
 * and other people in the room. Sending those as turns makes the agent reply to
 * itself, to filler, or to a bystander — the "responding when it's not
 * appropriate" problem.
 *
 * This is the SINGLE definition of that gate, shared by:
 *   - the UI shell capture loop (`@elizaos/ui` `voice/should-respond` +
 *     `voice/voice-turn-signal` re-export from here), and
 *   - the Voice Workbench headless runner (the plugin's real-decision-logic
 *     services adapter calls these so the benchmark exercises the SAME code the
 *     client runs — no drift between what we test and what we ship).
 *
 * Pure (no DOM, no I/O); the only dependency is the canonical syntactic EOT
 * heuristic in `@elizaos/shared/voice-eot`.
 */

import { scoreEndOfTurnHeuristic } from "../voice-eot";

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
export const ECHO_WINDOW_MS = 9000;
/** Word-overlap fraction above which a turn is treated as TTS echo. */
export const ECHO_OVERLAP_THRESHOLD = 0.7;

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

/** Mirrors the server-side VoiceTurnSignalMetadata shape the gate parses. */
export interface VoiceTurnSignal {
  endOfTurnProbability: number;
  nextSpeaker: "agent" | "user" | "unknown";
  agentShouldSpeak: boolean;
  source: string;
}

/** Live speaker attribution from diarization (only where audio frames exist). */
export interface VoiceTurnSpeakerAttribution {
  /** Enrolled entity this turn was attributed to, or null when unknown. */
  entityId: string | null;
  /** Match confidence 0..1 (cosine-rescaled by the attribution pipeline). */
  confidence: number;
  /** True when attributed to the device owner / primary enrolled speaker. */
  isOwner?: boolean;
}

export interface BuildVoiceTurnSignalContext extends ShouldRespondContext {
  /** Speaker attribution for this turn (diarization; desktop/server only). */
  speaker?: VoiceTurnSpeakerAttribution;
  /** True when a wake word ("hey eliza") fired within the recent listen window. */
  wakeWordActive?: boolean;
  /** Entity ids the agent answers to without a wake word (owner + enrolled). */
  knownSpeakerEntityIds?: readonly string[];
  /**
   * Cosine similarity (0..1) of THIS turn's speaker embedding against the
   * agent's own TTS-voice imprint, when the speaker encoder is available. High =
   * the agent is hearing ITSELF (its TTS bled back into the mic). This is the
   * ACOUSTIC self-echo signal — it catches an echo the transcript word-overlap
   * guard misses (a mis-transcribed echo whose words don't match the reply).
   */
  selfVoiceSimilarity?: number;
  /**
   * Decision threshold for `selfVoiceSimilarity`. The threshold is a property
   * of the MEASUREMENT SOURCE, so it travels with the value: the MFCC-timbre
   * workbench measure clears {@link AGENT_SELF_VOICE_THRESHOLD} (the default),
   * while a WeSpeaker-embedding cosine against the agent's TTS centroid sits on
   * a much lower scale (self ~0.37 vs human ~0.15) and must be gated at
   * {@link AGENT_SELF_VOICE_IMPRINT_THRESHOLD} instead — at the 0.7 bar the
   * production imprint could never fire.
   */
  selfVoiceThreshold?: number;
}

/** Server SUPPRESS threshold for EOT — below this reads as "user still talking". */
export const SERVER_EOT_SUPPRESS_THRESHOLD = 0.4;
/** Only a CONFIDENT bystander attribution is allowed to silence a turn. */
export const BYSTANDER_SUPPRESS_CONFIDENCE = 0.7;
/**
 * Cosine at/above which an incoming turn is treated as the agent's OWN voice and
 * hard-suppressed. WeSpeaker enrolls the device owner at ~0.78; the agent's own
 * TTS imprint is a tighter, single-source match, so a slightly lower bar is
 * safe and catches echo the transcript guard cannot.
 */
export const AGENT_SELF_VOICE_THRESHOLD = 0.7;
/**
 * Agent-specific decision threshold for a **WeSpeaker-embedding** cosine
 * against the agent's own TTS-voice centroid (`AgentSelfVoiceImprint`).
 * Measured margins (`research/VOICE_8785_ASSESSMENT.md` §6, real on-device
 * encoder): the agent's synthesized voice embeds ~0.37 self-similar while
 * human speech lands ~0.15 (down to −0.13) — a clear but LOW-scale margin, so
 * the 0.78 human-enrollment bar (and the 0.7 MFCC bar above) can never fire on
 * it. 0.28 splits the measured margin; the documented safe range is 0.25–0.30.
 */
export const AGENT_SELF_VOICE_IMPRINT_THRESHOLD = 0.28;

export function buildVoiceTurnSignal(
  transcript: string,
  context: BuildVoiceTurnSignalContext = {},
): VoiceTurnSignal {
  const endOfTurnProbability = scoreEndOfTurnHeuristic(transcript);

  // Transcript-level gate: the agent's own TTS echoed back through the mic, or
  // pure thinking-noise ("um", "uh").
  let agentShouldSpeak = shouldRespondToVoiceTurn(transcript, context);

  // Audio-frame gate (only when diarization attributed the turn): a CONFIDENT
  // bystander — someone who is neither the owner nor an enrolled speaker — who
  // did NOT say the wake word is cross-talk, not a turn addressed to the agent.
  // An uncertain attribution must never silence a real turn (fail open).
  const speaker = context.speaker;
  if (agentShouldSpeak && speaker && context.wakeWordActive !== true) {
    const known = new Set(context.knownSpeakerEntityIds ?? []);
    const enrolled =
      speaker.isOwner === true ||
      (speaker.entityId !== null && known.has(speaker.entityId));
    const confidentBystander =
      !enrolled &&
      speaker.entityId !== null &&
      speaker.confidence >= BYSTANDER_SUPPRESS_CONFIDENCE;
    if (confidentBystander) agentShouldSpeak = false;
  }

  // The wake word is an explicit address: it overrides bystander doubt and a
  // soft echo/disfluency miss, because the user deliberately summoned the agent.
  if (context.wakeWordActive === true) agentShouldSpeak = true;

  // Acoustic self-voice rejection: if the incoming voice MATCHES the agent's own
  // TTS imprint while it is (or just was) speaking, it is the agent hearing
  // itself — hard-suppress, even past the wake word. This is definitive (the
  // owner cannot sound like the agent's synthetic voice) and catches the echo
  // the transcript word-overlap guard misses (e.g. a mis-transcribed echo, or a
  // "hey eliza" that the agent itself spoke).
  const replyRecent =
    context.agentSpeaking === true ||
    (context.replyAgeMs ?? Number.POSITIVE_INFINITY) <= ECHO_WINDOW_MS;
  const isSelfVoice =
    context.selfVoiceSimilarity !== undefined &&
    context.selfVoiceSimilarity >=
      (context.selfVoiceThreshold ?? AGENT_SELF_VOICE_THRESHOLD) &&
    replyRecent;
  if (isSelfVoice) agentShouldSpeak = false;

  const nextSpeaker: VoiceTurnSignal["nextSpeaker"] = !agentShouldSpeak
    ? "user"
    : endOfTurnProbability < SERVER_EOT_SUPPRESS_THRESHOLD
      ? "user"
      : "agent";

  const source = isSelfVoice
    ? "client-ambient+self-voice"
    : context.wakeWordActive
      ? "client-ambient+wakeword"
      : speaker
        ? "client-ambient+diarization"
        : "client-ambient";

  return { endOfTurnProbability, nextSpeaker, agentShouldSpeak, source };
}
