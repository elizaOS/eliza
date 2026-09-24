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
} from "@elizaos/core/voice/aec/delay-calibrator";
export {
  type EchoAlignmentEstimate,
  type EchoAlignmentOptions,
  estimateEchoAlignment,
} from "@elizaos/core/voice/aec/echo-alignment";
export {
  DEFAULT_PLAYBACK_DELAY_MS,
  type EchoDelayEstimate,
  type EchoDelayOptions,
  estimateEchoDelaySamples,
  PLATFORM_PLAYBACK_DELAY_DEFAULTS,
  platformPlaybackDelayMs,
  platformPlaybackDelaySamples,
} from "@elizaos/core/voice/aec/echo-delay";
export { computeErle, computeFarActiveErle } from "@elizaos/core/voice/aec/echo-metrics";
export {
  EchoReferenceBuffer,
  type EchoReferenceBufferOptions,
} from "@elizaos/core/voice/aec/echo-reference-buffer";
export {
  NlmsEchoCanceller,
  type NlmsEchoCancellerOptions,
  type ResidualSuppressionOptions,
} from "@elizaos/core/voice/aec/nlms-echo-canceller";
