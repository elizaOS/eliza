/** Portable turn contracts for injected batch speech hosts; no media or provider lifecycle. */
export {
  buildVoiceTurnSignal,
  type ShouldRespondContext,
  shouldRespondToVoiceTurn,
  type VoiceTurnSignal,
} from "./respond-gate.js";
export { scoreEndOfTurnHeuristic } from "./voice-eot.js";
