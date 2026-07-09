/**
 * Pendant connection: the omi DevKit1 pendant → the eliza voice loop.
 *
 * Pipeline (all pieces verified against firmware + the existing voice stack):
 *
 *   BLE notify (3-byte-headed Opus frames)      omi-protocol.ts (reassembler)
 *     → OmiFrameReassembler                     → complete Opus frames
 *     → PendantAudioDecoder.decodeFrame          → Float32 PCM @ 16 kHz mono
 *     → VAD utterance segmenter                  (createLocalAsrAutoStopDetector,
 *                                                  the SAME detector the mic uses)
 *     → encodeMonoPcm16Wav                       → WAV bytes
 *     → transcribeLocalInferenceWav              → transcript text
 *                                                  (the SAME ASR client + route
 *                                                   the composer/hands-free mic
 *                                                   surfaces post to)
 *     → dispatchPendantVoiceTranscript           → useShellController sends it as
 *                                                  a VOICE_DM so the reply is
 *                                                  spoken back — full voice loop.
 *
 * The BLE layer is abstracted behind {@link PendantTransport} so this whole
 * pipeline is platform-agnostic: {@link WebBluetoothPendantTransport} on Chrome
 * (desktop / Android), {@link NativeBlePendantTransport} in the packaged Android
 * app (the Light Phone III). {@link selectPendantTransport} picks the right one;
 * the connectStep trace + per-step timeouts + one-retry logic are identical on
 * both paths.
 */

import { ElizaError, logger } from "@elizaos/core";
import {
  createLocalAsrAutoStopDetector,
  encodeMonoPcm16Wav,
  isSilentPcmAudio,
} from "../voice/local-asr-capture";
import { transcribeLocalInferenceWav } from "../voice/local-asr-transcribe";
import {
  DEFAULT_STEP_TIMEOUT_MS,
  isStepTimeout,
  type PendantConnectStep,
  withStepTimeout,
} from "./connect-timeout";
import {
  OMI_OPUS_SAMPLE_RATE_HZ,
  type OmiCodecId,
  OmiFrameReassembler,
} from "./omi-protocol";
import {
  createPendantAudioDecoder,
  type PendantAudioDecoder,
} from "./opus-frame-decoder";
import {
  classifyPendantConnectionError,
  createPendantError,
  type PendantTypedError,
} from "./pendant-errors";
import type { PendantStatus } from "./pendant-status";
import type { PendantTransport } from "./pendant-transport";
import { isUserCancelled } from "./pendant-transport";
import { isPendantSupported, selectPendantTransport } from "./select-transport";
import {
  dispatchPendantTranscriptSegment,
  normalizePendantAsrWords,
  type PendantTranscriptSegmentDetail,
} from "./transcript-segment-event";

export interface PendantState {
  status: PendantStatus;
  /**
   * Which connect step is in flight while `status === "connecting"` (surfaced
   * in the UI as small mono text so a stall is diagnosable, not a dead hang).
   */
  connectStep: PendantConnectStep;
  /** Human-readable device name from the BLE advertisement, when known. */
  deviceName: string | null;
  /** Battery percent (0-100) from the standard BAS, or null if unread. */
  batteryPercent: number | null;
  /** Reported codec id (20 = Opus, the DK1 default). */
  codecId: OmiCodecId | null;
  /** Last transcript that was dispatched into the chat. */
  lastTranscript: string | null;
  /** Cumulative count of BLE audio packets dropped (loss accounting). */
  droppedPackets: number;
  /** Last connection failure or non-fatal ASR warning shown in the transcript UI. */
  error: string | null;
  /** Stable typed error contract for recovery logic and UI state. */
  typedError: PendantTypedError | null;
  /**
   * True while ambient capture is paused. When paused, audio frames are still
   * received (the BLE link stays up + battery still updates) but are dropped
   * before the VAD, so no segments are produced.
   */
  paused: boolean;
}

export interface PendantConnectionOptions {
  /** Called on every state change so the UI can render live. */
  onState: (state: PendantState) => void;
  /** Called with each finalized transcript (already dispatched to chat). */
  onTranscript?: (text: string) => void;
  /** VAD silence window (ms) before an utterance is considered ended. */
  vadSilenceMs?: number;
  /** VAD RMS speech threshold. */
  vadSpeechRmsThreshold?: number;
  /**
   * Called for each ambient-transcript segment as it moves through its
   * lifecycle (pending → resolved/failed/discarded). Distinct from {@link onTranscript},
   * which only fires on a resolved turn (and drives the VOICE_DM send). The
   * transcript surface listens to this for interim state; if omitted the
   * segment window events are still dispatched globally.
   */
  onSegment?: (detail: PendantTranscriptSegmentDetail) => void;
  /** Per-step connect timeout (ms). Defaults to {@link DEFAULT_STEP_TIMEOUT_MS}. */
  stepTimeoutMs?: number;
  /**
   * Transport factory override (for tests). Defaults to
   * {@link selectPendantTransport}, which picks native BLE on Android and Web
   * Bluetooth elsewhere.
   */
  createTransport?: () => PendantTransport | null;
  /** Maximum spontaneous mid-session reconnect attempts. */
  reconnectMaxAttempts?: number;
  /** Delay between spontaneous mid-session reconnect attempts. */
  reconnectDelayMs?: number;
}

/** Custom window event the shell listens for to route a pendant turn to chat. */
export const PENDANT_VOICE_TRANSCRIPT_EVENT =
  "eliza:pendant:voice-transcript" as const;

export interface PendantVoiceTranscriptDetail {
  text: string;
}

/** Dispatch a finalized pendant transcript for the shell to send as VOICE_DM. */
export function dispatchPendantVoiceTranscript(text: string): void {
  if (typeof window === "undefined") return;
  const trimmed = text.trim();
  if (!trimmed) return;
  window.dispatchEvent(
    new CustomEvent<PendantVoiceTranscriptDetail>(
      PENDANT_VOICE_TRANSCRIPT_EVENT,
      { detail: { text: trimmed } },
    ),
  );
}

/**
 * A live pendant connection. Construct via {@link connectPendant}; call
 * {@link PendantConnection.disconnect} to tear down.
 *
 * The BLE specifics live in a {@link PendantTransport} — this class owns the
 * connect orchestration (steps, timeouts, retry) and the audio pipeline only.
 */
export class PendantConnection {
  private transport: PendantTransport | null = null;
  private decoder: PendantAudioDecoder | null = null;
  private readonly reassembler = new OmiFrameReassembler();

  // Utterance accumulation.
  private utterance: Float32Array[] = [];
  private utteranceSamples = 0;
  private detector:
    | ((
        pcm: Float32Array,
        t?: number,
      ) => {
        shouldBuffer: boolean;
        shouldStop: boolean;
      })
    | null = null;
  private sawSpeech = false;

  /** Ambient capture paused by the user (frames dropped before the VAD). */
  private paused = false;
  private reconnectAttempts = 0;
  private intentionalDisconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tie-breaker for segment ids that already include wall-clock timing. */
  private segmentSeq = 0;
  private state: PendantState = {
    status: "idle",
    connectStep: "idle",
    deviceName: null,
    batteryPercent: null,
    codecId: null,
    lastTranscript: null,
    droppedPackets: 0,
    error: null,
    typedError: null,
    paused: false,
  };

  /** True while an utterance is being transcribed — serializes finalizations. */
  private finalizing: Promise<void> = Promise.resolve();

  private readonly onAudioPayload = (payload: Uint8Array): void => {
    this.handleNotification(payload);
  };

  private readonly onBattery = (percent: number): void => {
    this.patch({ batteryPercent: percent });
  };

  private readonly onDisconnected = (): void => {
    const transport = this.transport;
    if (!transport) return;
    this.releaseConnectionRefs();
    if (this.intentionalDisconnect || this.state.status === "error") return;
    if (transport.kind === "web-bluetooth") {
      const typedError = createPendantError("pendant-lost");
      this.transport = null;
      this.patch({
        status: "error",
        connectStep: "idle",
        error: typedError.message,
        typedError,
        paused: false,
      });
      return;
    }
    this.beginReconnect();
  };

  constructor(private readonly opts: PendantConnectionOptions) {
    if (!isPendantSupported()) {
      this.state.status = "unsupported";
    }
  }

  getState(): PendantState {
    return this.state;
  }

  private patch(next: Partial<PendantState>): void {
    this.state = { ...this.state, ...next };
    this.opts.onState(this.state);
  }

  private emitSegment(detail: PendantTranscriptSegmentDetail): void {
    dispatchPendantTranscriptSegment(detail);
    this.opts.onSegment?.(detail);
  }

  private commitSegment(detail: PendantTranscriptSegmentDetail): void {
    this.emitSegment(detail);
    if (detail.status !== "resolved") return;
    const text = detail.text?.trim() ?? "";
    if (!text) return;
    dispatchPendantVoiceTranscript(text);
    this.opts.onTranscript?.(text);
  }

  private resetDetector(): void {
    this.detector = createLocalAsrAutoStopDetector({
      silenceMs: this.opts.vadSilenceMs,
      speechRmsThreshold: this.opts.vadSpeechRmsThreshold,
    });
    this.utterance = [];
    this.utteranceSamples = 0;
    this.sawSpeech = false;
  }

  /** Per-step timeout for the connect sequence (ms). */
  private get stepTimeoutMs(): number {
    return this.opts.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  }

  private get reconnectMaxAttempts(): number {
    return this.opts.reconnectMaxAttempts ?? 3;
  }

  private get reconnectDelayMs(): number {
    return this.opts.reconnectDelayMs ?? 750;
  }

  /**
   * Advance the UI trace + console log for a connect step, then run its awaited
   * work under a step-named timeout so a hung BLE op lands in a real error
   * ("timed out at ...") instead of hanging "connecting" forever.
   */
  private async step<T>(
    name: PendantConnectStep,
    work: () => PromiseLike<T>,
  ): Promise<T> {
    this.patch({ connectStep: name });
    const t0 =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    logger.info(`[PendantConnection] step:${name} …`);
    try {
      const result = await withStepTimeout(name, work(), this.stepTimeoutMs);
      const t1 =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      logger.info(
        `[PendantConnection] step:${name} ok (${Math.round(t1 - t0)}ms)`,
      );
      return result;
    } catch (cause) {
      const t1 =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      logger.warn(
        { cause },
        `[PendantConnection] step:${name} failed (${Math.round(t1 - t0)}ms)`,
      );
      if (isStepTimeout(cause)) throw cause;
      // error-policy:J2 Step context identifies which BLE boundary failed.
      throw new ElizaError(`Pendant connection failed during ${name}.`, {
        code: "PENDANT_CONNECT_STEP_FAILED",
        cause,
        context: { step: name },
        severity: "ephemeral",
      });
    }
  }

  /** Request a device, connect GATT, subscribe to audio + battery. */
  async connect(): Promise<void> {
    const transport = (this.opts.createTransport ?? selectPendantTransport)();
    if (!transport) {
      this.patch({
        status: "unsupported",
        error: "Bluetooth is not available in this environment.",
        typedError: createPendantError(
          "connection",
          "Bluetooth is not available in this environment.",
        ),
      });
      return;
    }
    this.clearReconnectTimer();
    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;
    this.transport = transport;
    transport.onDisconnected(this.onDisconnected);

    try {
      this.patch({
        status: "requesting",
        connectStep: "idle",
        error: null,
        typedError: null,
      });

      // Run the full bring-up with one automatic retry: macOS Chrome frequently
      // hangs `getPrimaryService` (and occasionally `startNotifications`) on the
      // FIRST attempt when service discovery races the fresh connect; a full
      // disconnect + reconnect almost always clears it. A single step-timeout
      // triggers exactly one clean retry before we surface an error. (The retry
      // rebuilds the transport since device selection is not repeatable.)
      try {
        await this.bringUp(transport);
      } catch (err) {
        // error-policy:J4 A timed-out first GATT discovery gets one visible bounded retry.
        if (!isStepTimeout(err)) throw err;
        logger.warn(
          { error: err },
          `[PendantConnection] ${err.message} — disconnecting and retrying once`,
        );
        await this.partialTeardown();
        // Give the stack a beat to fully drop the link before reconnecting.
        await new Promise((r) => setTimeout(r, 400));
        const retryTransport = (
          this.opts.createTransport ?? selectPendantTransport
        )();
        if (!retryTransport) throw err;
        this.transport = retryTransport;
        retryTransport.onDisconnected(this.onDisconnected);
        this.patch({ status: "requesting", connectStep: "idle" });
        await this.bringUp(retryTransport);
      }

      this.patch({ status: "listening", connectStep: "done" });
    } catch (err) {
      // error-policy:J4 The connection boundary translates failures into the typed UI state.
      const typedError = classifyPendantConnectionError(err);
      // Tear down anything a partial setup left live so a failed connect never
      // leaks a GATT link, active notifications, or the decoder.
      await this.partialTeardown();
      this.transport = null;
      // A user cancelling the chooser is idle, not error.
      if (isUserCancelled(err)) {
        this.patch({
          status: "idle",
          connectStep: "idle",
          error: null,
          typedError: null,
        });
        return;
      }
      this.patch({
        status: "error",
        connectStep: "idle",
        error: typedError.message,
        typedError,
      });
    }
  }

  private beginReconnect(): void {
    const typedError = createPendantError("pendant-lost");
    this.patch({
      status: "reconnecting",
      connectStep: "idle",
      error: typedError.message,
      typedError,
      paused: false,
    });
    this.scheduleReconnectAttempt();
  }

  private scheduleReconnectAttempt(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectOnce();
    }, this.reconnectDelayMs);
  }

  private async reconnectOnce(): Promise<void> {
    if (this.intentionalDisconnect || this.state.status !== "reconnecting") {
      return;
    }
    if (this.reconnectAttempts >= this.reconnectMaxAttempts) {
      const typedError = createPendantError("reconnect-exhausted");
      this.patch({
        status: "error",
        connectStep: "idle",
        error: typedError.message,
        typedError,
      });
      return;
    }
    this.reconnectAttempts += 1;
    const transport = (this.opts.createTransport ?? selectPendantTransport)();
    if (!transport) {
      const typedError = createPendantError("reconnect-exhausted");
      this.patch({
        status: "error",
        connectStep: "idle",
        error: typedError.message,
        typedError,
      });
      return;
    }
    this.transport = transport;
    transport.onDisconnected(this.onDisconnected);
    try {
      await this.bringUp(transport, "reconnecting");
      this.reconnectAttempts = 0;
      this.patch({
        status: "listening",
        connectStep: "done",
        error: null,
        typedError: null,
      });
    } catch (error) {
      // error-policy:J4 A failed reconnect remains visible and advances the bounded retry state.
      logger.warn({ error }, "[PendantConnection] Reconnect attempt failed");
      await this.partialTeardown();
      this.transport = null;
      this.patch({ status: "reconnecting", connectStep: "idle" });
      this.scheduleReconnectAttempt();
    }
  }

  private isPauseableStatus(): boolean {
    return (
      this.state.status === "connected" ||
      this.state.status === "listening" ||
      this.state.status === "hearing" ||
      this.state.status === "transcribing"
    );
  }

  /**
   * One attempt at the full bring-up: request/connect → codec → decoder → audio
   * notifications → battery. Every await is wrapped in a step-named timeout via
   * {@link step}. The `requestAndConnect` step folds device selection + GATT
   * connect (Web Bluetooth couples them behind one gesture; native scans then
   * connects) so the trace is identical across platforms.
   */
  private async bringUp(
    transport: PendantTransport,
    status: "connecting" | "reconnecting" = "connecting",
  ): Promise<void> {
    const { deviceName } = await this.step("gatt-connect", () =>
      transport.requestAndConnect(),
    );
    this.patch({
      status,
      deviceName: deviceName ?? "omi pendant",
    });

    const codecId = await this.step("codec-read", () => transport.readCodec());

    this.decoder = await this.step("decoder-init", async () => {
      // The opus wasm is inlined in the decoder module, but the dynamic import
      // still resolves a lazy JS chunk from the static /assets/ dist. If that
      // fetch 404s the await would hang, so surface it as a named failure.
      try {
        const dec = await createPendantAudioDecoder(codecId);
        await dec.ready;
        return dec;
      } catch (cause) {
        // error-policy:J2 Decoder initialization context is preserved for the UI boundary.
        throw new ElizaError("Pendant audio decoder failed to load.", {
          code: "PENDANT_AUDIO_DECODER_INIT_FAILED",
          cause,
          context: { codecId },
          severity: "fatal",
        });
      }
    });

    this.reassembler.reset();
    this.resetDetector();
    await this.step("start-notifications", () =>
      transport.startAudio(this.onAudioPayload),
    );

    // Battery (best-effort — not all builds expose it; never fatal).
    const battery = await this.step("battery", () =>
      transport.startBattery(this.onBattery),
    );
    if (battery !== null) this.patch({ batteryPercent: battery });

    this.patch({ codecId });
  }

  /**
   * Release everything a partial/failed connect left live — the transport, the
   * decoder, and refs — WITHOUT touching status (so a retry can re-run cleanly,
   * and the terminal catch can set the final status). Safe to call more than
   * once.
   */
  private async partialTeardown(): Promise<void> {
    const wasIntentional = this.intentionalDisconnect;
    this.intentionalDisconnect = true;
    try {
      await this.transport?.disconnect();
    } catch (error) {
      // error-policy:J6 Partial-connect teardown must continue releasing local decoder state.
      logger.debug(
        { error },
        "[PendantConnection] Partial transport teardown failed",
      );
    }
    this.intentionalDisconnect = wasIntentional;
    this.releaseConnectionRefs();
  }

  private releaseConnectionRefs(): void {
    this.decoder?.free();
    this.decoder = null;
    this.reassembler.reset();
    this.paused = false;
    this.resetDetector();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private handleNotification(notification: Uint8Array): void {
    if (!this.decoder || !this.detector) return;
    if (this.paused) return;
    const frames = this.reassembler.push(notification);
    for (const frame of frames) {
      if (frame.droppedBefore > 0) {
        this.patch({
          droppedPackets: this.state.droppedPackets + frame.droppedBefore,
        });
      }
      let pcm: Float32Array;
      try {
        pcm = this.decoder.decodeFrame(frame.data);
      } catch (error) {
        // error-policy:J4 A corrupt frame is counted and surfaced without killing ambient capture.
        const typedError = createPendantError(
          "connection",
          error instanceof Error ? error.message : "Audio frame decode failed.",
        );
        this.patch({
          droppedPackets: this.state.droppedPackets + 1,
          error: typedError.message,
          typedError,
        });
        continue;
      }
      if (pcm.length === 0) continue;
      this.feedVad(pcm);
    }
  }

  private feedVad(pcm: Float32Array): void {
    if (!this.detector) return;
    const update = this.detector(pcm);
    if (update.shouldBuffer) {
      this.utterance.push(pcm);
      this.utteranceSamples += pcm.length;
      if (!this.sawSpeech) {
        this.sawSpeech = true;
        if (this.state.status === "listening")
          this.patch({ status: "hearing" });
      }
    }
    if (update.shouldStop) {
      // Snapshot this utterance and re-arm immediately so audio during
      // transcription becomes the NEXT utterance (no dropped turns). Chain the
      // async transcription onto `finalizing` so concurrent utterances are
      // transcribed + dispatched strictly in order (never out of order).
      const chunks = this.utterance;
      const total = this.utteranceSamples;
      const segment = this.createPendingSegment(total);
      if (segment) this.emitSegment(segment);
      this.resetDetector();
      if (segment) {
        this.finalizing = this.finalizing.then(() =>
          this.finalizeUtterance(chunks, total, segment),
        );
      }
    }
  }

  private createPendingSegment(
    totalSamples: number,
  ): PendantTranscriptSegmentDetail | null {
    if (totalSamples === 0) return null;
    const durationMs = Math.round(
      (totalSamples / OMI_OPUS_SAMPLE_RATE_HZ) * 1000,
    );
    const endedAt = Date.now();
    const startedAt = endedAt - durationMs;
    return {
      id: `pendant-segment-${startedAt}-${endedAt}-${++this.segmentSeq}`,
      status: "pending",
      startedAt,
      endedAt,
      durationMs,
    };
  }

  private async finalizeUtterance(
    chunks: Float32Array[],
    total: number,
    segment: PendantTranscriptSegmentDetail,
  ): Promise<void> {
    if (total === 0) return;
    const pcm = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      pcm.set(c, off);
      off += c.length;
    }
    if (isSilentPcmAudio(pcm)) {
      this.commitSegment({
        ...segment,
        status: "discarded",
        discardReason: "silence",
      });
      return;
    }

    const wav = encodeMonoPcm16Wav(pcm, OMI_OPUS_SAMPLE_RATE_HZ);
    const wasStatus = this.state.status;
    this.patch({ status: "transcribing" });
    try {
      const { text, words } = await transcribeLocalInferenceWav(wav);
      const resolvedSegment: PendantTranscriptSegmentDetail = {
        ...segment,
        status: "resolved",
        text,
        words: normalizePendantAsrWords(words, segment.durationMs),
      };
      this.patch({ lastTranscript: text, error: null, typedError: null });
      this.commitSegment(resolvedSegment);
    } catch (error) {
      // error-policy:J4 Failed ASR becomes an explicit failed transcript segment.
      // ASR failure is non-fatal for ambient capture, but it must stay visible
      // so the transcript surface does not look healthy while segments drop.
      const typedError = createPendantError("asr-failed");
      logger.warn({ error }, "[PendantConnection] Ambient ASR segment failed");
      this.patch({ error: typedError.message, typedError });
      this.commitSegment({
        ...segment,
        status: "failed",
        failureReason: "asr-failed",
        warning: typedError.message,
      });
    } finally {
      // Return to the ambient listening state (or hearing if speech already
      // resumed while we were transcribing).
      const next =
        wasStatus === "error"
          ? "error"
          : this.paused
            ? "paused"
            : this.sawSpeech
              ? "hearing"
              : "listening";
      if (this.state.status === "transcribing") this.patch({ status: next });
    }
  }

  /** Pause ambient capture without disconnecting BLE or battery notifications. */
  pause(): void {
    if (this.paused) return;
    if (!this.transport || !this.decoder || !this.isPauseableStatus()) return;
    this.paused = true;
    this.reassembler.reset();
    this.resetDetector();
    this.patch({ paused: true, status: "paused" });
  }

  /** Resume feeding decoded pendant audio into VAD. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.resetDetector();
    if (this.transport && this.decoder) {
      this.patch({ paused: false, status: "listening" });
    } else {
      this.patch({ paused: false, status: this.state.status });
    }
  }

  /** Tear down: stop notifications, disconnect GATT, free the decoder. */
  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.clearReconnectTimer();
    // Flush the final in-flight frame (no following packet will close it) so a
    // trailing utterance still gets transcribed on a clean disconnect.
    if (this.decoder) {
      for (const frame of this.reassembler.flush()) {
        const pcm = this.decoder.decodeFrame(frame.data);
        if (pcm.length > 0) this.feedVad(pcm);
      }
    }
    try {
      await this.transport?.disconnect();
    } catch (error) {
      // error-policy:J6 User-requested teardown still releases local state after transport loss.
      logger.debug(
        { error },
        "[PendantConnection] Transport already disconnected",
      );
    }
    this.releaseConnectionRefs();
    this.transport = null;
    this.patch({
      status: "idle",
      connectStep: "idle",
      batteryPercent: null,
      codecId: null,
      error: null,
      typedError: null,
      paused: false,
    });
    this.intentionalDisconnect = false;
  }
}

/** Convenience: build + connect a pendant in one call. */
export async function connectPendant(
  opts: PendantConnectionOptions,
): Promise<PendantConnection> {
  const conn = new PendantConnection(opts);
  await conn.connect();
  return conn;
}

export type { PendantStatus } from "./pendant-status";
export { isPendantSupported } from "./select-transport";
// Re-export for existing importers that pulled availability from this module.
export { isWebBluetoothAvailable } from "./web-bluetooth-transport";
