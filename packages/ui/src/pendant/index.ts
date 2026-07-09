/**
 * omi pendant → eliza voice bridge.
 *
 * Public surface for the Web Bluetooth pendant integration. See
 * `pendant-connection.ts` for the pipeline overview and `omi-protocol.ts` for
 * the firmware-verified BLE protocol constants.
 */

export type { BleClientLike } from "./native-ble-transport";
export {
  OMI_AUDIO_CODEC_CHAR_UUID,
  OMI_AUDIO_DATA_CHAR_UUID,
  OMI_AUDIO_SERVICE_UUID,
  OMI_CODEC,
  type OmiCodecId,
  OmiFrameReassembler,
  type ReassembledFrame,
} from "./omi-protocol";
export {
  createPendantAudioDecoder,
  type PendantAudioDecoder,
} from "./opus-frame-decoder";
export {
  connectPendant,
  dispatchPendantVoiceTranscript,
  isPendantSupported,
  isWebBluetoothAvailable,
  PENDANT_VOICE_TRANSCRIPT_EVENT,
  PendantConnection,
  type PendantConnectionOptions,
  type PendantState,
  type PendantStatus,
  type PendantVoiceTranscriptDetail,
} from "./pendant-connection";
export {
  type PendantTransport,
  PendantUserCancelledError,
} from "./pendant-transport";
export {
  createPendantLatencyTrace,
  isPendantLatencyMarkName,
  PENDANT_LATENCY_CONTRACT_VERSION,
  PENDANT_LATENCY_MARKS,
  PENDANT_LATENCY_METRICS,
  PENDANT_LATENCY_TARGET_BUDGETS_MS,
  type PendantLatencyClock,
  type PendantLatencyMark,
  type PendantLatencyMarkName,
  type PendantLatencyMetric,
  type PendantLatencyMetricName,
  type PendantLatencySink,
  type PendantLatencyTraceOptions,
} from "./performance/pendant-latency";
export {
  isNativeAndroid,
  selectPendantTransport,
} from "./select-transport";
export {
  type UsePendantOptions,
  type UsePendantResult,
  usePendant,
} from "./usePendant";
export { WebBluetoothPendantTransport } from "./web-bluetooth-transport";
