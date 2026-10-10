import {
  type BrowserTranscript,
  type SpeechProgress,
  type SpeechWorkerMessage,
  speechError,
} from "./speech-protocol.ts";

const cancelled = () =>
  new DOMException("Transcription cancelled", "AbortError");
/** Host inputs: where the build's model manifest is served, and how to start the worker. */
export type BrowserSpeechRecognizerHost = {
  /** Absolute URL of the build's speech manifest (see speech-protocol SpeechManifest). */
  manifestUrl: () => string;
  /** A new dedicated worker running installSpeechWorker with the host's ONNX Runtime. */
  createWorker: () => Worker;
  /** Idle time before a loaded model is released. Default five minutes. */
  idleMs?: number;
};
/**
 * Owns the speech worker. One request at a time; cancelling terminates the worker, which
 * stops model download and inference immediately and makes late results impossible.
 * A finished request leaves the verified model loaded for the next recording, until it has been
 * idle for idleMs; then the worker is terminated so an unused model never stays resident.
 */
export class BrowserSpeechRecognizer {
  private worker?: Worker;
  private active?: { id: string; reject: (error: unknown) => void };
  private idle?: ReturnType<typeof setTimeout>;
  private readonly manifestUrl: () => string;
  private readonly create: () => Worker;
  private readonly idleMs: number;
  constructor(host: BrowserSpeechRecognizerHost) {
    this.manifestUrl = host.manifestUrl;
    this.create = host.createWorker;
    this.idleMs = host.idleMs ?? 5 * 60_000;
  }
  private clearIdle() {
    if (this.idle !== undefined) clearTimeout(this.idle);
    this.idle = undefined;
  }
  private scheduleIdle() {
    this.clearIdle();
    if (!this.worker) return;
    this.idle = setTimeout(() => {
      this.idle = undefined;
      if (!this.active) {
        this.worker?.terminate();
        this.worker = undefined;
      }
    }, this.idleMs);
  }
  /** Stop the current request, if any. Its worker is terminated; an idle model stays loaded. */
  stop() {
    if (this.active) this.cancel();
  }
  get busy() {
    return !!this.active;
  }
  /** Stop the current request (if any) and discard the loaded model. */
  cancel() {
    this.clearIdle();
    const active = this.active;
    this.active = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    active?.reject(cancelled());
  }
  transcribe(
    samples: Float32Array,
    signal: AbortSignal,
    progress: (value: SpeechProgress) => void = () => {},
  ): Promise<BrowserTranscript> {
    if (signal.aborted) return Promise.reject(cancelled());
    // A replacement request retires the previous one; an idle worker keeps its model.
    if (this.active) this.cancel();
    this.clearIdle();
    return new Promise<BrowserTranscript>((resolve, reject) => {
      const id = crypto.randomUUID();
      let worker: Worker;
      const finish = (error?: unknown, value?: BrowserTranscript) => {
        if (this.active?.id !== id) return;
        this.active = undefined;
        signal.removeEventListener("abort", abort);
        worker.onmessage = null;
        worker.onerror = null;
        if (error) {
          // A failed load is not retained; a later attempt starts a fresh worker.
          if (
            (error as { code?: string }).code === "model-load-failed" ||
            error instanceof DOMException
          ) {
            worker.terminate();
            if (this.worker === worker) this.worker = undefined;
          }
          reject(error);
        } else if (value) resolve(value);
        else reject(speechError("recognition-failed", "Missing transcript"));
        this.scheduleIdle();
      };
      const abort = () => {
        if (this.active?.id === id) this.cancel();
      };
      try {
        worker = this.worker ??= this.create();
      } catch (error) {
        reject(
          speechError(
            "model-load-failed",
            error instanceof Error
              ? error.message
              : "Speech worker unavailable",
          ),
        );
        return;
      }
      this.active = {
        id,
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      };
      signal.addEventListener("abort", abort, { once: true });
      worker.onmessage = (event: MessageEvent<SpeechWorkerMessage>) => {
        const message = event.data;
        if (message?.id !== id || this.active?.id !== id) return;
        if (message.type === "progress") {
          const { type: _type, id: _id, ...value } = message;
          progress(value as SpeechProgress);
          return;
        }
        if (message.type === "error") {
          finish(speechError(message.code, message.message));
          return;
        }
        const { type: _type, id: _id, ...result } = message;
        if (
          typeof result.text !== "string" ||
          typeof result.noSpeech !== "boolean"
        )
          finish(speechError("recognition-failed", "Malformed transcript"));
        else finish(undefined, result);
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        finish(
          speechError(
            "model-load-failed",
            event.message || "Speech worker failed",
          ),
        );
      };
      let manifestUrl: string;
      try {
        manifestUrl = this.manifestUrl();
      } catch {
        finish(
          speechError("model-load-failed", "Speech model location unavailable"),
        );
        return;
      }
      try {
        const copy = samples.slice();
        worker.postMessage(
          { type: "transcribe", id, manifestUrl, samples: copy },
          [copy.buffer],
        );
      } catch (error) {
        finish(
          speechError(
            "model-load-failed",
            error instanceof Error
              ? error.message
              : "Speech worker unavailable",
          ),
        );
      }
    });
  }
}
