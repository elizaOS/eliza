/** Portable voice analysis and acoustic processing; no native model or HTTP lifecycle. */

export type { EchoDelayState } from "./delay-calibrator.js";
export {
  ECHO_CAL_CAP_EDGE_SAMPLES,
  ECHO_CAL_FAR_ENERGY_FLOOR,
  ECHO_CAL_MAX_LAG_SAMPLES,
  ECHO_CAL_MAX_SAMPLES,
  ECHO_CAL_MIN_CONFIDENCE,
  ECHO_CAL_TARGET_SAMPLES,
  StreamingEchoDelayCalibrator,
} from "./delay-calibrator.js";
export type {
  EchoAlignmentEstimate,
  EchoAlignmentOptions,
} from "./echo-alignment.js";
export { estimateEchoAlignment } from "./echo-alignment.js";
export type {
  EchoDelayEstimate,
  EchoDelayOptions,
} from "./echo-delay.js";
export {
  DEFAULT_PLAYBACK_DELAY_MS,
  estimateEchoDelaySamples,
  PLATFORM_PLAYBACK_DELAY_DEFAULTS,
  platformPlaybackDelayMs,
  platformPlaybackDelaySamples,
} from "./echo-delay.js";
export {
  computeErle,
  computeFarActiveErle,
} from "./echo-metrics-calculation.js";
export type { EchoReferenceBufferOptions } from "./echo-reference-buffer.js";
export { EchoReferenceBuffer } from "./echo-reference-buffer.js";
export type {
  FirstSentenceSnipResult,
  FirstSentenceSnipVersion,
} from "./first-sentence-snip.js";
export {
  FIRST_SENTENCE_MAX_WORDS,
  FIRST_SENTENCE_SNIP_VERSION,
  firstSentenceSnip,
  normalizeForKey,
  wordCount,
} from "./first-sentence-snip.js";
export type {
  NlmsEchoCancellerOptions,
  ResidualSuppressionOptions,
} from "./nlms-echo-canceller.js";
export { NlmsEchoCanceller } from "./nlms-echo-canceller.js";
export type {
  OwnerInferenceOptions,
  OwnerInferenceResult,
  OwnerObservation,
} from "./owner-inference.js";
export { resolveOwnerCandidate } from "./owner-inference.js";
export type {
  BuildVoiceTurnSignalContext,
  ShouldRespondContext,
  VoiceTurnSignal,
  VoiceTurnSpeakerAttribution,
} from "./respond-gate.js";
export {
  AGENT_SELF_VOICE_IMPRINT_THRESHOLD,
  AGENT_SELF_VOICE_THRESHOLD,
  BYSTANDER_SUPPRESS_CONFIDENCE,
  buildVoiceTurnSignal,
  ECHO_OVERLAP_THRESHOLD,
  ECHO_WINDOW_MS,
  SERVER_EOT_SUPPRESS_THRESHOLD,
  shouldRespondToVoiceTurn,
} from "./respond-gate.js";
export { scoreEndOfTurnHeuristic } from "./voice-eot.js";
export {
  MAX_WER_EDIT_CELLS,
  MAX_WER_INPUT_CHARS,
  normalizeWerText,
  wordErrorRate,
} from "./voice-wer.js";
