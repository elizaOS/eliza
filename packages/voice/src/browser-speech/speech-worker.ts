import type {
  SpeechManifest,
  SpeechWorkerMessage,
  SpeechWorkerRequest,
} from "./speech-protocol.ts";
import {
  createWhisperRecognizer,
  type WhisperGeneration,
  type WhisperRuntime,
} from "./whisper-engine.ts";

/** The parts of a dedicated worker scope this handler uses. */
export type SpeechWorkerScope = {
  postMessage(message: SpeechWorkerMessage, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<SpeechWorkerRequest>) => void,
  ): void;
};
/** Host input: ONNX Runtime Web's external-WebAssembly build (`onnxruntime-web/wasm`). */
export type SpeechOnnxRuntime = WhisperRuntime & {
  env: {
    wasm: {
      numThreads?: number;
      proxy?: boolean;
      wasmBinary?: ArrayBufferLike | Uint8Array;
      wasmPaths?: unknown;
    };
  };
};
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/**
 * Installs the transcription handler in a dedicated worker. The page owns cancellation by
 * terminating the worker; there is no cross-request state except the loaded model, which is
 * verified once, file by file, against the build's manifest (size and SHA-256). Model files are
 * fetched same-origin from the host's manifest location only; nothing is uploaded.
 */
export function installSpeechWorker(
  scope: SpeechWorkerScope,
  ort: SpeechOnnxRuntime,
  fetcher: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response> = (input, init) => fetch(input, init),
) {
  let recognizer:
    | Promise<{
        manifest: SpeechManifest;
        transcribe: (
          samples: Float32Array,
        ) => Promise<{ text: string; noSpeech: boolean }>;
      }>
    | undefined;
  const post = (message: SpeechWorkerMessage) => scope.postMessage(message);
  // Every model file, including the WebAssembly glue, must come from the manifest's own origin.
  const sameOrigin = (path: string, base: string) => {
    const url = new URL(path, base);
    if (url.origin !== new URL(base).origin)
      throw Error("Speech model file is not served by this host");
    return url;
  };
  async function fetchVerified(
    base: string,
    file: { path: string; bytes: number; sha256: string },
    progress: (bytes: number) => void,
  ) {
    const response = await fetcher(sameOrigin(file.path, base), {
      credentials: "same-origin",
      cache: "default",
    });
    if (!response.ok || !response.body)
      throw Error(`Speech model file unavailable (${response.status})`);
    const output = new Uint8Array(file.bytes),
      reader = response.body.getReader();
    let offset = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > file.bytes)
        throw Error("Speech model file is larger than recorded");
      output.set(value, offset);
      offset += value.length;
      progress(value.length);
    }
    if (offset !== file.bytes) throw Error("Speech model file is incomplete");
    if (hex(await crypto.subtle.digest("SHA-256", output)) !== file.sha256)
      throw Error("Speech model file failed verification");
    return output;
  }
  async function load(id: string, manifestUrl: string) {
    const response = await fetcher(manifestUrl, {
      credentials: "same-origin",
      cache: "no-cache",
    });
    if (!response.ok)
      throw Error("This build does not include the speech model");
    const manifest = (await response.json()) as SpeechManifest;
    if (
      manifest?.version !== 1 ||
      manifest.engine !== "whisper" ||
      manifest.language !== "en" ||
      !manifest.files
    )
      throw Error("Unsupported speech model manifest");
    const files = manifest.files,
      total = Object.values(files).reduce((sum, file) => sum + file.bytes, 0);
    let loaded = 0;
    sameOrigin(files.glue.path, manifestUrl);
    post({ type: "progress", id, phase: "download", loaded, total });
    const progress = (bytes: number) => {
      loaded += bytes;
      post({ type: "progress", id, phase: "download", loaded, total });
    };
    const [wasm, encoder, decoder, vocab, generation, glue] = await Promise.all(
      [
        files.wasm,
        files.encoder,
        files.decoder,
        files.vocab,
        files.generation,
        files.glue,
      ].map((file) => fetchVerified(manifestUrl, file, progress)),
    );
    post({ type: "progress", id, phase: "initialize" });
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmBinary = wasm.buffer;
    const glueUrl = URL.createObjectURL(
      new Blob([glue], { type: "text/javascript" }),
    );
    ort.env.wasm.wasmPaths = { mjs: glueUrl };
    const decodeJson = (bytes: Uint8Array) =>
      JSON.parse(new TextDecoder().decode(bytes));
    try {
      const engine = await createWhisperRecognizer(ort, {
        encoder,
        decoder,
        vocab: decodeJson(vocab) as Record<string, number>,
        generation: decodeJson(generation) as WhisperGeneration,
      });
      return {
        manifest,
        transcribe: (samples: Float32Array) => engine.transcribe(samples),
      };
    } finally {
      URL.revokeObjectURL(glueUrl);
    }
  }
  scope.addEventListener("message", (event) => {
    const request = event.data;
    if (request?.type !== "transcribe") return;
    const { id } = request;
    void (async () => {
      let stage: "load" | "transcribe" = "load";
      try {
        if (!recognizer) {
          recognizer = load(id, request.manifestUrl);
          recognizer.catch(() => {
            recognizer = undefined;
          });
        }
        const owned = await recognizer;
        stage = "transcribe";
        post({ type: "progress", id, phase: "transcribe" });
        const result = await owned.transcribe(request.samples);
        const { manifest } = owned;
        post({
          type: "result",
          id,
          text: result.noSpeech ? "" : result.text,
          noSpeech: result.noSpeech,
          engine: manifest.engine,
          model: manifest.model,
          modelRevision: manifest.revision,
          runtime: manifest.runtime,
          language: manifest.language,
        });
      } catch (error) {
        post({
          type: "error",
          id,
          code: stage === "load" ? "model-load-failed" : "recognition-failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
}
