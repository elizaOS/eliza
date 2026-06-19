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

import { Capacitor, type PluginListenerHandle } from "@capacitor/core";

import type { AsrProvider } from "../api/client-types-config";
import {
  getTalkModePlugin,
  type TalkModeErrorEvent,
  type TalkModeTranscriptEvent,
} from "../bridge/native-plugins";
import {
  isLocalAsrCaptureSupported,
  type LocalAsrAutoStopOptions,
  type LocalAsrRecorder,
  startLocalAsrRecorder,
} from "./local-asr-capture";
import {
  isLocalInferenceAsrReady,
  transcribeLocalInferenceWav,
} from "./local-asr-transcribe";
import {
  getSpeechRecognitionCtor,
  type SpeechRecognitionInstance,
  type SpeechRecognitionResultEvent,
  TALKMODE_STOP_SETTLE_MS,
} from "./voice-chat-types";

/** Backend the factory ended up using for the current capture. */
export type VoiceCaptureBackend = "local-inference" | "browser" | "talkmode";

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
  /**
   * When the chosen backend is native `talkmode`, emit the latest interim
   * transcript as a FINAL segment on `stop()`. Set for push-to-talk dictation —
   * the press-release ends the turn, so the running text must be committed even
   * if the native silence-window final hasn't fired yet. Leave false for
   * hands-free "converse" capture, where finals arrive from the silence detector
   * and a manual stop must NOT submit a partial turn.
   */
  finalizeOnStop?: boolean;
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
  /**
   * Live amplitude analyser for the active capture, when the backend exposes
   * one (local-inference taps the mic stream). `null` for the browser
   * SpeechRecognition backend, which has no audio graph to read.
   */
  getAnalyser(): AnalyserNode | null;
}

/**
 * True on a native mobile platform whose `TalkMode` plugin is present. On
 * Android/iOS the OS speech recognizer (exposed by TalkMode) is the real STT
 * engine — it transcribes on-device with live INTERIM results — and the
 * local-inference whisper assets are not staged on mobile, so that path 502s.
 * `getNativePlugin` returns `{}` when the plugin is absent, hence the method
 * feature-check.
 */
function isNativeTalkModeCaptureAvailable(): boolean {
  if (typeof window === "undefined") return false;
  if (!Capacitor.isNativePlatform()) return false;
  const talkMode = getTalkModePlugin();
  return (
    typeof talkMode.start === "function" &&
    typeof talkMode.addListener === "function"
  );
}

async function resolveBackendKind(
  preferred: AsrProvider | "browser" | undefined,
): Promise<VoiceCaptureBackend> {
  if (preferred === "browser") {
    return "browser";
  }
  // Native mobile: the platform speech recognizer (TalkMode) is the working STT
  // path and the only one that streams interim transcripts. Prefer it ahead of
  // the local-inference probe — on mobile that probe can report ready while the
  // whisper assets are missing, then 502 at stop() with no recoverable fallback.
  if (isNativeTalkModeCaptureAvailable()) {
    return "talkmode";
  }
  // local-inference is the default elsewhere, but it needs BOTH the client
  // mic-capture primitives AND a server that can actually transcribe. Probe the
  // server's readiness (GET /api/asr/local-inference/status) so an unconfigured
  // box (no whisper model / native adapter) degrades to browser SpeechRecognition
  // instead of capturing audio it can only 502 on at stop().
  if (
    (preferred === "local-inference" || preferred === undefined) &&
    isLocalAsrCaptureSupported() &&
    (await isLocalInferenceAsrReady())
  ) {
    return "local-inference";
  }
  // Eliza-cloud / OpenAI providers go through the local-inference route
  // server-side today; until that changes, browser API is the only sane
  // client-side fallback.
  return "browser";
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
    finalizeOnStop = false,
  } = options;
  // Resolved on start() — the server-readiness probe is async, so the backend
  // choice is deferred from construction to the first start() call.
  let backendKind: VoiceCaptureBackend | null = null;

  let state: VoiceCaptureState = "idle";
  let active = false;
  let disposed = false;
  let recorder: LocalAsrRecorder | null = null;
  let recognition: SpeechRecognitionInstance | null = null;
  let browserStopWait: Promise<void> | null = null;
  let resolveBrowserStop: (() => void) | null = null;
  // Native TalkMode (Android/iOS SpeechRecognizer) capture state.
  let talkModeHandles: PluginListenerHandle[] = [];
  let lastTalkModeInterim = "";

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

  async function removeTalkModeHandles(): Promise<void> {
    const handles = talkModeHandles;
    talkModeHandles = [];
    for (const handle of handles) {
      try {
        await handle.remove();
      } catch {
        /* listener already gone — fine */
      }
    }
  }

  async function startTalkMode(): Promise<void> {
    const talkMode = getTalkModePlugin();
    let permissions = await talkMode.checkPermissions().catch(() => null);
    if (permissions?.speechRecognition === "not_supported") {
      throw new Error("Speech recognition is not available on this device");
    }
    if (permissions?.microphone === "prompt") {
      await talkMode.requestPermissions().catch(() => {});
      permissions = await talkMode.checkPermissions().catch(() => permissions);
    }
    lastTalkModeInterim = "";
    // The recognizer streams partials (`isFinal:false`) live + a final per
    // silence window; both route through onTranscript so the caller can show the
    // interim and act on the final (send / fill the draft).
    const transcriptHandle = await talkMode.addListener(
      "transcript",
      (event: TalkModeTranscriptEvent) => {
        const text = (event.transcript ?? "").trim();
        if (!text) return;
        const final = event.isFinal === true;
        lastTalkModeInterim = final ? "" : text;
        onTranscript({ text, final, backend: "talkmode" });
      },
    );
    const errorHandle = await talkMode.addListener(
      "error",
      (event: TalkModeErrorEvent & { recoverable?: boolean }) => {
        // The native recognizer self-heals from recoverable errors (it re-arms
        // continuously) — only a FATAL error (e.g. permission denied) ends the
        // session. Tearing the capture down on a recoverable error would drop
        // `recording` to false and make the shell's re-listen loop fire a second
        // `talkMode.start()` over the still-live session (ERROR_CLIENT churn).
        if (event.recoverable === false) {
          setState(
            "error",
            new Error(
              `Speech recognition error: ${event.message ?? event.code ?? "unknown"}`,
            ),
          );
        }
      },
    );
    talkModeHandles = [transcriptHandle, errorHandle];
    const result = await talkMode.start({
      config: {
        stt: { language: lang, modelSize: "base", sampleRate: 16000 },
        silenceWindowMs: 350,
        interruptOnSpeech: true,
      },
    });
    if (!result?.started) {
      await removeTalkModeHandles();
      throw new Error(result?.error ?? "Speech recognition failed to start");
    }
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
      backendKind = await resolveBackendKind(asrProvider);
      if (backendKind === "talkmode") {
        await startTalkMode();
      } else if (backendKind === "local-inference") {
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

    if (backendKind === "talkmode") {
      active = false;
      // Tear listeners down first so the native stop() can't slip in a late
      // final that double-submits.
      await removeTalkModeHandles();
      // Push-to-talk dictation: the release ends the turn, so commit the running
      // interim as the final even if the silence-window final never fired.
      const pending = lastTalkModeInterim;
      lastTalkModeInterim = "";
      if (finalizeOnStop && pending) {
        onTranscript({ text: pending, final: true, backend: "talkmode" });
      }
      await getTalkModePlugin()
        .stop()
        .catch(() => {});
      await new Promise((resolve) =>
        setTimeout(resolve, TALKMODE_STOP_SETTLE_MS),
      );
      setState("stopped");
      return;
    }

    if (backendKind === "local-inference") {
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
    if (talkModeHandles.length > 0) {
      void removeTalkModeHandles();
      void getTalkModePlugin()
        .stop?.()
        .catch(() => {});
      lastTalkModeInterim = "";
    }
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
    getAnalyser: () => recorder?.analyser ?? null,
  };
}
