import type { AsrProvider } from "../api/client-types-config";
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
export type VoiceCaptureState = "idle" | "starting" | "listening" | "stopped" | "error";
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
export declare function createVoiceCapture(options: VoiceCaptureFactoryOptions): VoiceCaptureHandle;
//# sourceMappingURL=voice-capture-factory.d.ts.map