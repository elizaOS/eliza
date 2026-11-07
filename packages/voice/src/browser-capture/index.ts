/**
 * Generic browser voice capture: MediaRecorder sessions with host microphone admission, and
 * bounded decoding to mono PCM / PCM16 WAV for speech recognition. See README.md.
 */
export type {
  AdmittedMicrophone,
  BrowserAudioCaptureHost,
} from "./audio-capture.ts";
export { BrowserAudioCapture } from "./audio-capture.ts";
export type { RecordingPcmLimits } from "./recording-pcm.ts";
export {
  decodeRecordingPcm,
  encodePcm16Wav,
  recordingPcmWav,
} from "./recording-pcm.ts";
