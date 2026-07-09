/**
 * omi pendant → eliza voice bridge.
 *
 * Public surface for the Web Bluetooth pendant integration. See
 * `pendant-connection.ts` for the pipeline overview and `omi-protocol.ts` for
 * the firmware-verified BLE protocol constants.
 */

export {
  type BleClientLike,
  NativeBlePendantTransport,
} from "./native-ble-transport";
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
  type PendantVoiceTranscriptDetail,
} from "./pendant-connection";
export {
  classifyPendantConnectionError,
  createPendantError,
  type PendantErrorCode,
  PendantPermissionDeniedError,
  type PendantRecoveryCategory,
  type PendantTypedError,
} from "./pendant-errors";
export {
  isPendantLiveStatus,
  type PendantStatus,
  pendantConnectStepLabel,
  pendantStatusLabel,
} from "./pendant-status";
export {
  createLocalOptimisticPendantTranscriptSessionAdapter,
  EMPTY_PENDANT_TRANSCRIPT_SESSION,
  loadPendantTranscriptSession,
  MAX_PERSISTED_PENDANT_TRANSCRIPT_SEGMENTS,
  PENDANT_TRANSCRIPT_STORAGE_KEY,
  type PendantTranscriptSegment,
  type PendantTranscriptSessionAction,
  type PendantTranscriptSessionAdapter,
  type PendantTranscriptSessionState,
  pendantTranscriptSessionReducer,
  savePendantTranscriptSession,
} from "./pendant-transcript-session";
export {
  type PendantTransport,
  PendantUserCancelledError,
} from "./pendant-transport";
export {
  isNativeAndroid,
  selectPendantTransport,
} from "./select-transport";
export {
  dispatchPendantTranscriptSegment,
  normalizePendantAsrWords,
  PENDANT_TRANSCRIPT_SEGMENT_EVENT,
  type PendantAsrWord,
  type PendantSegmentDiscardReason,
  type PendantSegmentFailureReason,
  type PendantSegmentStatus,
  type PendantTranscriptSegmentDetail,
} from "./transcript-segment-event";
export {
  type UsePendantOptions,
  type UsePendantResult,
  usePendant,
} from "./usePendant";
export { WebBluetoothPendantTransport } from "./web-bluetooth-transport";
