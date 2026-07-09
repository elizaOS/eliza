/**
 * omi pendant → eliza voice bridge.
 *
 * Public surface for the Web Bluetooth pendant integration. See
 * `pendant-connection.ts` for the pipeline overview and `omi-protocol.ts` for
 * the firmware-verified BLE protocol constants.
 */

export {
  connectPendant,
  dispatchPendantVoiceTranscript,
  isPendantSupported,
  isWebBluetoothAvailable,
  PendantConnection,
  PENDANT_VOICE_TRANSCRIPT_EVENT,
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
  isNativeAndroid,
  selectPendantTransport,
} from "./select-transport";
export { WebBluetoothPendantTransport } from "./web-bluetooth-transport";
export {
  type BleClientLike,
  NativeBlePendantTransport,
} from "./native-ble-transport";
export {
  OMI_AUDIO_SERVICE_UUID,
  OMI_AUDIO_DATA_CHAR_UUID,
  OMI_AUDIO_CODEC_CHAR_UUID,
  OMI_CODEC,
  type OmiCodecId,
  OmiFrameReassembler,
  type ReassembledFrame,
} from "./omi-protocol";
export {
  createPendantAudioDecoder,
  type PendantAudioDecoder,
} from "./opus-frame-decoder";
export { usePendant, type UsePendantOptions, type UsePendantResult } from "./usePendant";
