/** Public, renderer-safe turn analysis. Hosts own capture, providers and playback. */
export {
  type BuildVoiceTurnSignalContext,
  buildVoiceTurnSignal,
  type ShouldRespondContext,
  shouldRespondToVoiceTurn,
  type VoiceTurnSignal,
  type VoiceTurnSpeakerAttribution,
} from "./respond-gate.js";
export { scoreEndOfTurnHeuristic } from "./voice-eot.js";
