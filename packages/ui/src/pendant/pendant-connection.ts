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
import type { PendantTransport } from "./pendant-transport";
import { isUserCancelled } from "./pendant-transport";
import { isPendantSupported, selectPendantTransport } from "./select-transport";
import {
  dispatchPendantTranscriptSegment,
  normalizePendantAsrWords,
  type PendantTranscriptSegmentDetail,
} from "./transcript-segment-event";

export type PendantStatus =
  | "unsupported"
  | "idle"
  | "requesting"
  | "connecting"
  | "connected"
  | "listening" // audio frames arriving, VAD idle (no speech yet)
  | "hearing" // VAD sees speech in the current utterance
  | "transcribing"
  | "paused" // ambient capture paused by the user (frames ignored)
  | "error";

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
   * lifecycle (pending → resolved/dropped). Distinct from {@link onTranscript},
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
}

/** Custom window event the shell listens for to route a pendant turn to chat. */
export const PENDANT_VOICE_TRANSCRIPT_EVENT =
  "eliza:pendant:voice-transcript" as const;

export interface PendantVoiceTranscriptDetail {
  text: string;
}

function formatPendantAsrError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Pendant ASR failed: ${detail}`;
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
    // A remote disconnect (device powered off / out of range) must release the
    // decoder and reset refs — not just detach — so we don't leak the wasm
    // decoder until an explicit disconnect() that may never come.
    this.decoder?.free();
    this.decoder = null;
    this.reassembler.reset();
    this.paused = false;
    this.resetDetector();
    if (this.state.status !== "error") {
      this.patch({
        status: "idle",
        connectStep: "idle",
        deviceName: this.state.deviceName,
        paused: false,
      });
    }
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
    // eslint-disable-next-line no-console
    console.info(`[pendant] step:${name} …`);
    try {
      const result = await withStepTimeout(name, work(), this.stepTimeoutMs);
      const t1 =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      // eslint-disable-next-line no-console
      console.info(`[pendant] step:${name} ok (${Math.round(t1 - t0)}ms)`);
      return result;
    } catch (err) {
      const t1 =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      // eslint-disable-next-line no-console
      console.warn(
        `[pendant] step:${name} FAILED (${Math.round(t1 - t0)}ms):`,
        err instanceof Error ? err.message : err,
      );
      throw err;
    }
  }

  /** Request a device, connect GATT, subscribe to audio + battery. */
  async connect(): Promise<void> {
    const transport = (this.opts.createTransport ?? selectPendantTransport)();
    if (!transport) {
      this.patch({
        status: "unsupported",
        error: "Bluetooth is not available in this environment.",
      });
      return;
    }
    this.transport = transport;
    transport.onDisconnected(this.onDisconnected);

    try {
      this.patch({ status: "requesting", connectStep: "idle", error: null });

      // Run the full bring-up with one automatic retry: macOS Chrome frequently
      // hangs `getPrimaryService` (and occasionally `startNotifications`) on the
      // FIRST attempt when service discovery races the fresh connect; a full
      // disconnect + reconnect almost always clears it. A single step-timeout
      // triggers exactly one clean retry before we surface an error. (The retry
      // rebuilds the transport since device selection is not repeatable.)
      try {
        await this.bringUp(transport);
      } catch (err) {
        if (!isStepTimeout(err)) throw err;
        // eslint-disable-next-line no-console
        console.warn(
          `[pendant] ${err.message} — disconnecting and retrying once`,
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
      const message =
        err instanceof Error ? err.message : "Failed to connect to pendant";
      // Tear down anything a partial setup left live so a failed connect never
      // leaks a GATT link, active notifications, or the decoder.
      await this.partialTeardown();
      this.transport = null;
      // A user cancelling the chooser is idle, not error.
      if (isUserCancelled(err)) {
        this.patch({ status: "idle", connectStep: "idle", error: null });
        return;
      }
      this.patch({ status: "error", connectStep: "idle", error: message });
    }
  }

  /**
   * One attempt at the full bring-up: request/connect → codec → decoder → audio
   * notifications → battery. Every await is wrapped in a step-named timeout via
   * {@link step}. The `requestAndConnect` step folds device selection + GATT
   * connect (Web Bluetooth couples them behind one gesture; native scans then
   * connects) so the trace is identical across platforms.
   */
  private async bringUp(transport: PendantTransport): Promise<void> {
    const { deviceName } = await this.step("gatt-connect", () =>
      transport.requestAndConnect(),
    );
    this.patch({
      status: "connecting",
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
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`audio decoder failed to load: ${detail}`);
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
    try {
      await this.transport?.disconnect();
    } catch {
      /* best-effort */
    }
    this.decoder?.free();
    this.decoder = null;
    this.reassembler.reset();
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
      const pcm = this.decoder.decodeFrame(frame.data);
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
      this.emitSegment({ ...segment, status: "dropped" });
      return;
    }

    const wav = encodeMonoPcm16Wav(pcm, OMI_OPUS_SAMPLE_RATE_HZ);
    const wasStatus = this.state.status;
    this.patch({ status: "transcribing" });
    try {
      const { text, words } = await transcribeLocalInferenceWav(wav);
      dispatchPendantVoiceTranscript(text);
      this.patch({ lastTranscript: text, error: null });
      this.emitSegment({
        ...segment,
        status: "resolved",
        text,
        words: normalizePendantAsrWords(words, segment.durationMs),
      });
      this.opts.onTranscript?.(text);
    } catch (err) {
      // ASR failure is non-fatal for ambient capture, but it must stay visible
      // so the transcript surface does not look healthy while segments drop.
      this.patch({ error: formatPendantAsrError(err) });
      this.emitSegment({ ...segment, status: "dropped" });
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
    } catch {
      /* already disconnected */
    }
    this.decoder?.free();
    this.decoder = null;
    this.transport = null;
    this.reassembler.reset();
    this.paused = false;
    this.patch({
      status: "idle",
      connectStep: "idle",
      batteryPercent: null,
      codecId: null,
      paused: false,
    });
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

export { isPendantSupported } from "./select-transport";
// Re-export for existing importers that pulled availability from this module.
export { isWebBluetoothAvailable } from "./web-bluetooth-transport";
