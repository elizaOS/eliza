/**
 * Builds the `voiceTurnSignal` that the always-on (ambient) voice path attaches
 * to a VOICE_DM turn. The server gate `core.voice_turn_signal`
 * (packages/core/src/services/message.ts) reads this signal and SUPPRESSES the
 * agent reply when `agentShouldSpeak === false`, `nextSpeaker === "user"`, or
 * `endOfTurnProbability < 0.4`.
 *
 * This is the single producer for that signal, shared by the shell capture loop
 * (transcript-only — the Android/web path) and the chat-view voice path (which
 * additionally forwards a richer signal when the native VAD/turn engine supplies
 * one). It composes the transcript-level signals (semantic end-of-turn + the
 * echo/disfluency gate) with two optional audio-frame signals — speaker
 * identity and wake word — that are only present on platforms where raw PCM is
 * available (desktop/server diarization). On a transcript-only platform the
 * audio-frame inputs are simply absent and the signal degrades to the
 * transcript gate, which is the correct conservative behavior.
 */
import { scoreEndOfTurn } from "./end-of-turn";
import {
  type ShouldRespondContext,
  shouldRespondToVoiceTurn,
} from "./should-respond";

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
}

/** Server SUPPRESS threshold for EOT — below this reads as "user still talking". */
const SERVER_EOT_SUPPRESS_THRESHOLD = 0.4;
/** Only a CONFIDENT bystander attribution is allowed to silence a turn. */
const BYSTANDER_SUPPRESS_CONFIDENCE = 0.7;

export function buildVoiceTurnSignal(
  transcript: string,
  context: BuildVoiceTurnSignalContext = {},
): VoiceTurnSignal {
  const endOfTurnProbability = scoreEndOfTurn(transcript);

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

  const nextSpeaker: VoiceTurnSignal["nextSpeaker"] = !agentShouldSpeak
    ? "user"
    : endOfTurnProbability < SERVER_EOT_SUPPRESS_THRESHOLD
      ? "user"
      : "agent";

  const source = context.wakeWordActive
    ? "client-ambient+wakeword"
    : speaker
      ? "client-ambient+diarization"
      : "client-ambient";

  return { endOfTurnProbability, nextSpeaker, agentShouldSpeak, source };
}
