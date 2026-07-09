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
import {
  createPendantLatencyTrace,
  type PendantLatencyClock,
  type PendantLatencySink,
  type PendantLatencyTrace,
} from "./performance/pendant-latency";
import { isPendantSupported, selectPendantTransport } from "./select-transport";

const ignorePendantDisconnect = (): void => undefined;

class PendantConnectCancelledError extends Error {
  constructor() {
    super("Pendant connection attempt was cancelled");
    this.name = "PendantConnectCancelledError";
  }
}

export type PendantStatus =
  | "unsupported"
  | "idle"
  | "requesting"
  | "connecting"
  | "connected"
  | "listening" // audio frames arriving, VAD idle (no speech yet)
  | "hearing" // VAD sees speech in the current utterance
  | "transcribing"
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
  /** Last error message, when `status === "error"`. */
  error: string | null;
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
  /** Per-step connect timeout (ms). Defaults to {@link DEFAULT_STEP_TIMEOUT_MS}. */
  stepTimeoutMs?: number;
  /**
   * Transport factory override (for tests). Defaults to
   * {@link selectPendantTransport}, which picks native BLE on Android and Web
   * Bluetooth elsewhere.
   */
  createTransport?: () => PendantTransport | null;
  /** Privacy-safe performance mark sink. Never receives transcript/audio/device identifiers. */
  latencySink?: PendantLatencySink;
  /** Deterministic clock for latency tests and replay harnesses. */
  latencyClock?: PendantLatencyClock;
}

/** Custom window event the shell listens for to route a pendant turn to chat. */
export const PENDANT_VOICE_TRANSCRIPT_EVENT =
  "eliza:pendant:voice-transcript" as const;

export interface PendantVoiceTranscriptDetail {
  text: string;
  /** Privacy-safe sequence used to correlate downstream performance marks. */
  utteranceSeq?: number;
}

/** Dispatch a finalized pendant transcript for the shell to send as VOICE_DM. */
export function dispatchPendantVoiceTranscript(
  text: string,
  utteranceSeq?: number,
): void {
  if (typeof window === "undefined") return;
  const trimmed = text.trim();
  if (!trimmed) return;
  window.dispatchEvent(
    new CustomEvent<PendantVoiceTranscriptDetail>(
      PENDANT_VOICE_TRANSCRIPT_EVENT,
      { detail: { text: trimmed, utteranceSeq } },
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
  private frameSeq = 0;
  /** Logical frame assigned to the notification currently being buffered. */
  private notificationFrameSeq = 0;
  private hasBufferedNotificationFrame = false;
  private utteranceSeq = 0;
  private generation = 0;
  private attemptId = 0;
  private connectInFlight: {
    readonly generation: number;
    readonly promise: Promise<void>;
  } | null = null;
  private activeAsr: AbortController | null = null;
  private readonly latency: PendantLatencyTrace;

  private state: PendantState = {
    status: "idle",
    connectStep: "idle",
    deviceName: null,
    batteryPercent: null,
    codecId: null,
    lastTranscript: null,
    droppedPackets: 0,
    error: null,
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
    // decoder, listeners, queued PCM, and in-flight ASR. The hook intentionally
    // retains this connection object so a later connect() can reuse it.
    this.stopPipeline();
    const transport = this.transport;
    this.transport = null;
    transport?.onDisconnected(ignorePendantDisconnect);
    void transport?.disconnect().catch(() => {
      // error-policy:J6 best-effort teardown after the link is already gone.
    });
    if (this.state.status !== "error") {
      this.patch({
        status: "idle",
        connectStep: "idle",
        batteryPercent: null,
        codecId: null,
        deviceName: this.state.deviceName,
      });
    }
  };

  constructor(private readonly opts: PendantConnectionOptions) {
    this.latency = createPendantLatencyTrace({
      sink: opts.latencySink,
      clock: opts.latencyClock,
    });
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

  private resetReassembly(): void {
    this.reassembler.reset();
    this.notificationFrameSeq = this.frameSeq;
    this.hasBufferedNotificationFrame = false;
  }

  private resetDetector(): void {
    this.detector = createLocalAsrAutoStopDetector({
      silenceMs: this.opts.vadSilenceMs,
      speechRmsThreshold: this.opts.vadSpeechRmsThreshold,
    });
    this.utterance = [];
    this.utteranceSamples = 0;
    this.sawSpeech = false;
    this.utteranceSeq += 1;
  }

  private stopPipeline(): void {
    this.generation += 1;
    this.attemptId += 1;
    this.activeAsr?.abort();
    this.activeAsr = null;
    this.decoder?.free();
    this.decoder = null;
    this.detector = null;
    this.utterance = [];
    this.utteranceSamples = 0;
    this.sawSpeech = false;
    this.resetReassembly();
    this.latency.reset();
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
    const current = this.connectInFlight;
    if (current?.generation === this.generation) return current.promise;
    const promise = this.connectOnce();
    const inFlight = { generation: this.generation, promise };
    this.connectInFlight = inFlight;
    try {
      await promise;
    } finally {
      if (this.connectInFlight === inFlight) this.connectInFlight = null;
    }
  }

  private async connectOnce(): Promise<void> {
    if (
      this.state.status === "requesting" ||
      this.state.status === "connecting" ||
      this.state.status === "connected" ||
      this.state.status === "listening" ||
      this.state.status === "hearing" ||
      this.state.status === "transcribing"
    ) {
      return;
    }
    this.stopPipeline();
    const generation = this.generation;
    let activeAttemptId = ++this.attemptId;
    const transport = (this.opts.createTransport ?? selectPendantTransport)();
    if (!transport) {
      this.patch({
        status: "unsupported",
        error: "Bluetooth is not available in this environment.",
      });
      return;
    }
    this.transport = transport;
    let activeTransport = transport;
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
        await this.bringUp(transport, generation, activeAttemptId);
        if (!this.isCurrentAttempt(generation, activeAttemptId)) {
          await this.teardownCancelledAttempt(transport);
          return;
        }
      } catch (err) {
        if (!isStepTimeout(err)) throw err;
        // eslint-disable-next-line no-console
        console.warn(
          `[pendant] ${err.message} — disconnecting and retrying once`,
        );
        this.attemptId += 1;
        await this.partialTeardown(activeTransport);
        if (this.transport === activeTransport) this.transport = null;
        // Give the stack a beat to fully drop the link before reconnecting.
        await new Promise((r) => setTimeout(r, 400));
        if (generation !== this.generation) {
          if (this.transport === null) this.settleCancelledConnect();
          return;
        }
        const retryTransport = (
          this.opts.createTransport ?? selectPendantTransport
        )();
        if (!retryTransport) throw err;
        this.transport = retryTransport;
        activeTransport = retryTransport;
        activeAttemptId = ++this.attemptId;
        retryTransport.onDisconnected(this.onDisconnected);
        this.patch({ status: "requesting", connectStep: "idle" });
        await this.bringUp(retryTransport, generation, activeAttemptId);
        if (!this.isCurrentAttempt(generation, activeAttemptId)) {
          await this.teardownCancelledAttempt(retryTransport);
          return;
        }
      }

      this.patch({ status: "listening", connectStep: "done" });
    } catch (err) {
      if (generation !== this.generation) {
        await this.teardownCancelledAttempt(activeTransport);
        return;
      }
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
  private async bringUp(
    transport: PendantTransport,
    generation: number,
    attemptId: number,
  ): Promise<void> {
    const { deviceName } = await this.step("gatt-connect", () =>
      transport.requestAndConnect(),
    );
    this.assertCurrentAttempt(generation, attemptId);
    this.patch({
      status: "connecting",
      deviceName: deviceName ?? "omi pendant",
    });

    const codecId = await this.step("codec-read", () => transport.readCodec());
    this.assertCurrentAttempt(generation, attemptId);

    const decoder = await this.step("decoder-init", async () => {
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
    if (!this.isCurrentAttempt(generation, attemptId)) {
      decoder.free();
      throw new PendantConnectCancelledError();
    }
    this.decoder = decoder;

    this.resetReassembly();
    this.resetDetector();
    await this.step("start-notifications", () =>
      transport.startAudio((payload) => {
        if (this.isCurrentAttempt(generation, attemptId))
          this.onAudioPayload(payload);
      }),
    );
    this.assertCurrentAttempt(generation, attemptId);

    // Battery (best-effort — not all builds expose it; never fatal).
    const battery = await this.step("battery", () =>
      transport.startBattery((percent) => {
        if (this.isCurrentAttempt(generation, attemptId))
          this.onBattery(percent);
      }),
    );
    this.assertCurrentAttempt(generation, attemptId);
    if (battery !== null) this.patch({ batteryPercent: battery });

    this.patch({ codecId });
  }

  private isCurrentAttempt(generation: number, attemptId: number): boolean {
    return generation === this.generation && attemptId === this.attemptId;
  }

  private assertCurrentAttempt(generation: number, attemptId: number): void {
    if (!this.isCurrentAttempt(generation, attemptId))
      throw new PendantConnectCancelledError();
  }

  /**
   * Release everything a partial/failed connect left live — the transport, the
   * decoder, and refs — WITHOUT touching status (so a retry can re-run cleanly,
   * and the terminal catch can set the final status). Safe to call more than
   * once.
   */
  private settleCancelledConnect(): void {
    if (this.state.status === "error") return;
    this.patch({
      status: "idle",
      connectStep: "idle",
      batteryPercent: null,
      codecId: null,
      error: null,
    });
  }

  private async teardownCancelledAttempt(
    transport: PendantTransport,
  ): Promise<void> {
    await this.partialTeardown(transport);
    if (this.transport === transport) this.transport = null;
    // A newer reconnect owns a different transport and its state must win.
    if (this.transport === null) this.settleCancelledConnect();
  }

  private async partialTeardown(
    transport: PendantTransport | null = this.transport,
  ): Promise<void> {
    try {
      transport?.onDisconnected(ignorePendantDisconnect);
      await transport?.disconnect();
    } catch {
      /* best-effort */
    }
    if (this.transport === transport) {
      this.decoder?.free();
      this.decoder = null;
      this.resetReassembly();
    }
  }

  private handleNotification(notification: Uint8Array): void {
    if (!this.decoder || !this.detector) return;
    if (notification.length > 3 && notification[2] === 0) {
      if (this.hasBufferedNotificationFrame) this.notificationFrameSeq += 1;
      this.hasBufferedNotificationFrame = true;
    }
    this.latency.mark("ble.notification", {
      utteranceSeq: this.utteranceSeq,
      frameSeq: this.notificationFrameSeq,
      bytes: notification.byteLength,
    });
    const frames = this.reassembler.push(notification);
    for (const frame of frames) {
      const frameSeq = this.frameSeq;
      const frameUtteranceSeq = this.utteranceSeq;
      this.latency.mark("reassembly.frame", {
        utteranceSeq: frameUtteranceSeq,
        frameSeq,
        packetIndex: frame.packetIndex,
        bytes: frame.data.byteLength,
        droppedBefore: frame.droppedBefore,
      });
      if (frame.droppedBefore > 0) {
        this.latency.count("dropped_packets", frame.droppedBefore);
        this.patch({
          droppedPackets: this.state.droppedPackets + frame.droppedBefore,
        });
      }
      this.latency.mark("decode.start", {
        utteranceSeq: this.utteranceSeq,
        frameSeq,
        bytes: frame.data.byteLength,
      });
      const pcm = this.decoder.decodeFrame(frame.data);
      this.latency.mark("decode.end", {
        utteranceSeq: this.utteranceSeq,
        frameSeq,
        samples: pcm.length,
      });
      this.frameSeq += 1;
      if (pcm.length > 0) this.feedVad(pcm, frameSeq);
      this.latency.completeFrame(frameUtteranceSeq, frameSeq);
    }
  }

  private feedVad(pcm: Float32Array, frameSeq?: number): void {
    if (!this.detector) return;
    const update = this.detector(pcm);
    if (update.shouldBuffer) {
      this.utterance.push(pcm);
      this.utteranceSamples += pcm.length;
      if (!this.sawSpeech) {
        this.sawSpeech = true;
        this.latency.mark("vad.speech", {
          utteranceSeq: this.utteranceSeq,
          frameSeq,
          samples: pcm.length,
        });
        if (this.state.status === "listening")
          this.patch({ status: "hearing" });
      }
    }
    if (update.shouldStop) {
      this.latency.mark("vad.pending", {
        utteranceSeq: this.utteranceSeq,
        pendingCount: 1,
      });
      // Snapshot this utterance and re-arm immediately so audio during
      // transcription becomes the NEXT utterance (no dropped turns). Chain the
      // async transcription onto `finalizing` so concurrent utterances are
      // transcribed + dispatched strictly in order (never out of order).
      const utteranceSeq = this.utteranceSeq;
      const chunks = this.utterance;
      const total = this.utteranceSamples;
      this.resetDetector();
      const generation = this.generation;
      this.finalizing = this.finalizing.then(() =>
        this.finalizeUtterance(chunks, total, utteranceSeq, generation),
      );
    }
  }

  private async finalizeUtterance(
    chunks: Float32Array[],
    total: number,
    utteranceSeq: number,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation || total === 0) {
      this.latency.completeUtterance(utteranceSeq);
      return;
    }
    const pcm = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      pcm.set(c, off);
      off += c.length;
    }
    // Guard against a spurious near-silent segment burning an ASR round-trip.
    if (isSilentPcmAudio(pcm)) {
      this.latency.completeUtterance(utteranceSeq);
      return;
    }

    this.latency.mark("wav.encode.start", { utteranceSeq, samples: total });
    const wav = encodeMonoPcm16Wav(pcm, OMI_OPUS_SAMPLE_RATE_HZ);
    this.latency.mark("wav.encode.end", {
      utteranceSeq,
      bytes: wav.byteLength,
      samples: total,
    });
    const wasStatus = this.state.status;
    const abortController = new AbortController();
    this.activeAsr = abortController;
    this.patch({ status: "transcribing" });
    try {
      this.latency.mark("asr.request", {
        utteranceSeq,
        bytes: wav.byteLength,
      });
      const { text } = await transcribeLocalInferenceWav(wav, {
        signal: abortController.signal,
      });
      if (generation !== this.generation) return;
      this.latency.mark("asr.resolve", { utteranceSeq });
      dispatchPendantVoiceTranscript(text, utteranceSeq);
      this.latency.mark("segment.dispatch", { utteranceSeq });
      this.patch({ lastTranscript: text });
      this.opts.onTranscript?.(text);
    } catch {
      // Empty transcript / ASR error / disconnect abort: silently drop this turn.
    } finally {
      if (this.activeAsr === abortController) this.activeAsr = null;
      this.latency.completeUtterance(utteranceSeq);
      if (generation === this.generation) {
        // Return to the ambient listening state (or hearing if speech already
        // resumed while we were transcribing).
        const next =
          wasStatus === "error"
            ? "error"
            : this.sawSpeech
              ? "hearing"
              : "listening";
        if (this.state.status === "transcribing") this.patch({ status: next });
      }
    }
  }

  /** Tear down: stop notifications, disconnect GATT, free the decoder. */
  async disconnect(): Promise<void> {
    // Invalidate queued/in-flight ASR before awaiting transport teardown. A user
    // who disconnects must not receive a transcript after the UI returns idle.
    this.stopPipeline();
    try {
      this.transport?.onDisconnected(ignorePendantDisconnect);
      await this.transport?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.transport = null;
    this.patch({
      status: "idle",
      connectStep: "idle",
      batteryPercent: null,
      codecId: null,
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
