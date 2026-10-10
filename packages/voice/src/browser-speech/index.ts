/**
 * In-browser English speech recognition: Whisper tiny.en over ONNX Runtime Web in a dedicated
 * worker, with self-hosted, hash-verified model files and no upload. Host inputs: the model
 * manifest URL, the worker factory and the ONNX Runtime module. See README.md.
 */

export type {
  BrowserTranscript,
  SpeechErrorCode,
  SpeechFile,
  SpeechManifest,
  SpeechProgress,
  SpeechWorkerMessage,
  SpeechWorkerRequest,
} from "./speech-protocol.ts";
export { speechError } from "./speech-protocol.ts";
export type { BrowserSpeechRecognizerHost } from "./speech-recognizer.ts";
export { BrowserSpeechRecognizer } from "./speech-recognizer.ts";
export type { SpeechOnnxRuntime, SpeechWorkerScope } from "./speech-worker.ts";
export { installSpeechWorker } from "./speech-worker.ts";
export type {
  WhisperCheck,
  WhisperGeneration,
  WhisperModels,
  WhisperRuntime,
  WhisperSession,
  WhisperTensor,
  WhisperTranscript,
} from "./whisper-engine.ts";
export {
  audioActivity,
  createTokenDecoder,
  createWhisperRecognizer,
  logMelSpectrogram,
  logProbability,
  melFilterBank,
  noSpeechDecision,
  repeatingTail,
  selectToken,
  silentRecording,
  WHISPER,
} from "./whisper-engine.ts";
