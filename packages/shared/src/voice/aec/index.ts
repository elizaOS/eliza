/** Barrel for the acoustic echo cancellation (AEC) primitives: echo-delay estimation, the echo reference buffer, and the NLMS canceller. */
export {
  ECHO_CAL_CAP_EDGE_SAMPLES,
  ECHO_CAL_FAR_ENERGY_FLOOR,
  ECHO_CAL_MAX_LAG_SAMPLES,
  ECHO_CAL_MAX_SAMPLES,
  ECHO_CAL_MIN_CONFIDENCE,
  ECHO_CAL_TARGET_SAMPLES,
  type EchoDelayState,
  StreamingEchoDelayCalibrator,
} from "./delay-calibrator.js";
export {
  type EchoAlignmentEstimate,
  type EchoAlignmentOptions,
  estimateEchoAlignment,
} from "./echo-alignment.js";
export {
  DEFAULT_PLAYBACK_DELAY_MS,
  type EchoDelayEstimate,
  type EchoDelayOptions,
  estimateEchoDelaySamples,
  PLATFORM_PLAYBACK_DELAY_DEFAULTS,
  platformPlaybackDelayMs,
  platformPlaybackDelaySamples,
} from "./echo-delay.js";
export { computeErle, computeFarActiveErle } from "./echo-metrics.js";
export {
  EchoReferenceBuffer,
  type EchoReferenceBufferOptions,
} from "./echo-reference-buffer.js";
export {
  NlmsEchoCanceller,
  type NlmsEchoCancellerOptions,
  type ResidualSuppressionOptions,
} from "./nlms-echo-canceller.js";
