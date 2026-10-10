/** Messages between the page and the in-browser speech worker, and the build's model manifest. */
export type SpeechFile = { path: string; bytes: number; sha256: string };
export type SpeechManifest = {
  version: 1;
  engine: "whisper";
  model: string;
  revision: string;
  language: "en";
  runtime: string;
  files: {
    encoder: SpeechFile;
    decoder: SpeechFile;
    vocab: SpeechFile;
    generation: SpeechFile;
    wasm: SpeechFile;
    glue: SpeechFile;
  };
};
export type SpeechProgress =
  | { phase: "download"; loaded: number; total: number }
  | { phase: "initialize" | "transcribe" };
export type SpeechWorkerRequest = {
  type: "transcribe";
  id: string;
  manifestUrl: string;
  samples: Float32Array;
};
export type BrowserTranscript = {
  text: string;
  noSpeech: boolean;
  engine: string;
  model: string;
  modelRevision: string;
  runtime: string;
  language: string;
};
export type SpeechWorkerMessage =
  | ({ type: "progress"; id: string } & SpeechProgress)
  | ({ type: "result"; id: string } & BrowserTranscript)
  | {
      type: "error";
      id: string;
      code: "model-load-failed" | "recognition-failed";
      message: string;
    };
/** Error codes surfaced to the recorder; each one has its own user-facing state. */
export type SpeechErrorCode =
  | "no-speech"
  | "model-load-failed"
  | "recognition-failed";
export function speechError(code: SpeechErrorCode, message: string) {
  return Object.assign(new Error(message), { code });
}
