/**
 * Builds the `voiceTurnSignal` that the always-on (ambient) voice path attaches
 * to a VOICE_DM turn. The server gate `core.voice_turn_signal`
 * (packages/core/src/services/message.ts) reads this signal and SUPPRESSES the
 * agent reply when `agentShouldSpeak === false`, `nextSpeaker === "user"`, or
 * `endOfTurnProbability < 0.4`.
 *
 * The implementation is the canonical, pure definition in
 * `@elizaos/shared/voice/respond-gate` — shared with the UI shell capture loop,
 * the chat-view voice path, and the Voice Workbench headless runner (#8785) so
 * the gate never drifts between what we test and what we ship. This module
 * re-exports it to keep the `@elizaos/ui` `voice/voice-turn-signal` import path
 * (and its tests) stable.
 */

export {
  AGENT_SELF_VOICE_THRESHOLD,
  type BuildVoiceTurnSignalContext,
  BYSTANDER_SUPPRESS_CONFIDENCE,
  buildVoiceTurnSignal,
  SERVER_EOT_SUPPRESS_THRESHOLD,
  type VoiceTurnSignal,
  type VoiceTurnSpeakerAttribution,
} from "@elizaos/shared/voice/respond-gate";
