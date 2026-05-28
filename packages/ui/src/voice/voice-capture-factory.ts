/**
 * Hook-free voice capture factory.
 *
 * Carved out so surfaces that don't run inside `AppProvider` (e.g. the
 * desktop voice pill renderer process) can drive the same capture pipeline
 * the main chat composer uses without depending on React context.
 *
 * Pipeline:
 * 1. If `local-inference` ASR is available + supported in this renderer,
 *    capture mic audio via {@link startLocalAsrRecorder}, POST the WAV to
 *    `/api/asr/local-inference`, and emit the resulting transcript as one
 *    `final: true` segment on stop.
 * 2. Otherwise fall back to the browser SpeechRecognition API, emitting
 *    interim and final segments as they arrive.
 *
 * Mic permission + AudioContext + MediaStream lifecycle is owned by the
 * underlying primitives ({@link startLocalAsrRecorder} + browser
 * `SpeechRecognition`). This factory adds nothing on top besides routing.
 */

import type { AsrProvider } from "../api/client-types-config";
import {
  isLocalAsrCaptureSupported,
  type LocalAsrAutoStopOptions,
  type LocalAsrRecorder,
  startLocalAsrRecorder,
} from "./local-asr-capture";
import { transcribeLocalInferenceWav } from "./local-asr-transcribe";
import {
  getSpeechRecognitionCtor,
  type SpeechRecognitionInstance,
  type SpeechRecognitionResultEvent,
} from "./voice-chat-types";

/** Backend the factory ended up using for the current capture. */
export type VoiceCaptureBackend = "local-inference" | "browser";

/** Single transcript chunk delivered to the caller. */
export interface VoiceCaptureTranscriptSegment {
  /** Transcript text. Trimmed. */
  text: string;
  /**
   * `true` when the segment is finalized for the current capture turn.
   * Caller should treat finalized segments as the user message to send.
   * Interim segments are partial best-guesses; safe to display, not safe to send.
   */
  final: boolean;
  /** Which backend produced this segment. */
  backend: VoiceCaptureBackend;
}

/**
 * Lifecycle state reported via {@link VoiceCaptureFactoryOptions.onStateChange}.
 *
 * - `idle`: initial state, or after a clean `stop()`.
 * - `starting`: `start()` was called; awaiting mic permission / backend init.
 * - `listening`: mic open, capturing audio.
 * - `stopped`: caller asked us to stop and we drained cleanly.
 * - `error`: capture failed (permission denied, transcription error, etc.);
 *   the underlying `Error` is passed as the second argument.
 */
export type VoiceCaptureState =
  | "idle"
  | "starting"
  | "listening"
  | "stopped"
  | "error";

export interface VoiceCaptureFactoryOptions {
  /** Called when a transcript segment is produced. Interim and final both routed here. */
  onTranscript: (segment: VoiceCaptureTranscriptSegment) => void;
  /** Called when capture state changes. Optional. */
  onStateChange?: (state: VoiceCaptureState, error?: Error) => void;
  /**
   * Which ASR backend to prefer. Default: `local-inference` when supported,
   * with browser SpeechRecognition as automatic fallback.
   * Pass `browser` to force the browser API even when local-inference is
   * available (useful in tests / browsers without an Eliza API server).
   */
  asrProvider?: AsrProvider | "browser";
  /** Locale string forwarded to the browser SpeechRecognition API. Default `en-US`. */
  lang?: string;
  localAsrAutoStop?: LocalAsrAutoStopOptions;
}

export interface VoiceCaptureHandle {
  /**
   * Start capturing. Resolves once the backend is listening.
   * Rejects on mic permission denial / missing API support (after surfacing
   * the same error via `onStateChange("error", err)`).
   */
  start(): Promise<void>;
  /**
   * Stop capturing and drain the current turn.
   * For `local-inference`, this triggers the WAV → transcribe round trip and
   * emits a single final segment. For `browser`, this stops the recognizer
   * and waits for any in-flight final result to arrive.
   */
  stop(): Promise<void>;
  /** Release resources. Idempotent. Calls `stop()` if currently active. */
  dispose(): void;
  /** `true` while a capture is open (between successful `start` and `stop`). */
  isActive(): boolean;
}

interface ResolvedBackend {
  kind: VoiceCaptureBackend;
}

function resolveBackend(
  preferred: AsrProvider | "browser" | undefined,
): ResolvedBackend {
  if (preferred === "browser") {
    return { kind: "browser" };
  }
  // local-inference is the default, but it requires both the mic capture
  // primitives and (ultimately) a reachable /api/asr/local-inference. We
  // can only check the former here; if the round-trip fails at stop() the
  // caller is notified via onStateChange("error", err).
  if (preferred === "local-inference" || preferred === undefined) {
    if (isLocalAsrCaptureSupported()) {
      return { kind: "local-inference" };
    }
  }
  // Eliza-cloud / OpenAI providers go through the local-inference route
  // server-side today; until that changes, browser API is the only sane
  // client-side fallback.
  return { kind: "browser" };
}

export function createVoiceCapture(
  options: VoiceCaptureFactoryOptions,
): VoiceCaptureHandle {
  const {
    onTranscript,
    onStateChange,
    asrProvider,
    lang = "en-US",
    localAsrAutoStop,
  } = options;
  const backend = resolveBackend(asrProvider);

  let state: VoiceCaptureState = "idle";
  let active = false;
  let disposed = false;
  let recorder: LocalAsrRecorder | null = null;
  let recognition: SpeechRecognitionInstance | null = null;
  let browserStopWait: Promise<void> | null = null;
  let resolveBrowserStop: (() => void) | null = null;

  function setState(next: VoiceCaptureState, error?: Error): void {
    if (state === next) return;
    state = next;
    onStateChange?.(next, error);
  }

  async function startLocalInference(): Promise<void> {
    const next = await startLocalAsrRecorder({
      ...(localAsrAutoStop ? { autoStop: localAsrAutoStop } : {}),
      onAutoStop: () => {
        void stop();
      },
    });
    recorder = next;
    active = true;
    setState("listening");
  }

  function startBrowser(): void {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      throw new Error(
        "Browser SpeechRecognition API is not available in this renderer",
      );
    }
    const instance = new Ctor();
    instance.continuous = true;
    instance.interimResults = true;
    instance.lang = lang;

    instance.onresult = (event: SpeechRecognitionResultEvent) => {
      for (
        let index = event.resultIndex;
        index < event.results.length;
        index += 1
      ) {
        const result = event.results[index];
        if (!result) continue;
        const text = result[0]?.transcript?.trim() ?? "";
        if (!text) continue;
        onTranscript({ text, final: result.isFinal, backend: "browser" });
      }
    };
    instance.onerror = (event: { error: string }) => {
      const err = new Error(`SpeechRecognition error: ${event.error}`);
      setState("error", err);
    };
    instance.onend = () => {
      // The browser ended recognition for us — either because we asked, or
      // because the engine timed out. Resolve any pending stop() waiter.
      active = false;
      if (resolveBrowserStop) {
        const r = resolveBrowserStop;
        resolveBrowserStop = null;
        browserStopWait = null;
        r();
      }
    };

    recognition = instance;
    instance.start();
    active = true;
    setState("listening");
  }

  async function start(): Promise<void> {
    if (disposed) {
      throw new Error("VoiceCapture handle has been disposed");
    }
    if (active) return;
    setState("starting");
    try {
      if (backend.kind === "local-inference") {
        await startLocalInference();
      } else {
        startBrowser();
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setState("error", error);
      throw error;
    }
  }

  async function stop(): Promise<void> {
    if (!active && state !== "starting") return;

    if (backend.kind === "local-inference") {
      const current = recorder;
      recorder = null;
      active = false;
      if (!current) {
        setState("stopped");
        return;
      }
      try {
        const wav = await current.stop();
        const { text } = await transcribeLocalInferenceWav(wav);
        onTranscript({ text, final: true, backend: "local-inference" });
        setState("stopped");
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setState("error", error);
        throw error;
      }
      return;
    }

    const instance = recognition;
    if (!instance) {
      active = false;
      setState("stopped");
      return;
    }
    // The browser recognizer ends asynchronously via `onend`. Block until
    // it drains so callers can `await stop()` reliably.
    browserStopWait = new Promise<void>((resolve) => {
      resolveBrowserStop = resolve;
    });
    instance.stop();
    await browserStopWait;
    recognition = null;
    setState("stopped");
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (recorder) {
      recorder.cancel();
      recorder = null;
    }
    if (recognition) {
      try {
        recognition.abort();
      } finally {
        recognition = null;
      }
    }
    active = false;
    if (resolveBrowserStop) {
      const r = resolveBrowserStop;
      resolveBrowserStop = null;
      browserStopWait = null;
      r();
    }
    setState("idle");
  }

  return {
    start,
    stop,
    dispose,
    isActive: () => active,
  };
}
