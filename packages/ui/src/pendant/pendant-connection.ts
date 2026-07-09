/**
 * Web Bluetooth connection to the omi DevKit1 pendant → the eliza voice loop.
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
 *                                                   surfaces post to on sol-dev)
 *     → dispatchPendantVoiceTranscript           → useShellController sends it as
 *                                                  a VOICE_DM so the reply is
 *                                                  spoken back — full voice loop.
 *
 * Web Bluetooth is available on Chrome/Edge desktop + Android Chrome; it is
 * NOT available on iOS Safari / installed PWA. `isWebBluetoothAvailable()`
 * gates the UI so the connect affordance only appears where it can work. The
 * iOS path (Capacitor BLE plugin in the native shell) is documented as the
 * follow-up in PENDANT-BRIDGE-REPORT.md.
 */

import {
  createLocalAsrAutoStopDetector,
  encodeMonoPcm16Wav,
  isSilentPcmAudio,
} from "../voice/local-asr-capture";
import { transcribeLocalInferenceWav } from "../voice/local-asr-transcribe";
import {
  createPendantAudioDecoder,
  type PendantAudioDecoder,
} from "./opus-frame-decoder";
import {
  BATTERY_LEVEL_CHAR_UUID,
  BATTERY_SERVICE_UUID,
  OMI_AUDIO_CODEC_CHAR_UUID,
  OMI_AUDIO_DATA_CHAR_UUID,
  OMI_AUDIO_SERVICE_UUID,
  OMI_CODEC,
  OMI_NAME_PREFIXES,
  type OmiCodecId,
  OMI_OPUS_SAMPLE_RATE_HZ,
  OmiFrameReassembler,
} from "./omi-protocol";

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
}

/** True when the browser exposes the Web Bluetooth API. */
export function isWebBluetoothAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof (navigator as Navigator & { bluetooth?: unknown }).bluetooth ===
      "object" &&
    (navigator as Navigator & { bluetooth?: { requestDevice?: unknown } })
      .bluetooth?.requestDevice !== undefined
  );
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
 */
export class PendantConnection {
  private device: BluetoothDevice | null = null;
  private audioChar: BluetoothRemoteGATTCharacteristic | null = null;
  private batteryChar: BluetoothRemoteGATTCharacteristic | null = null;
  private decoder: PendantAudioDecoder | null = null;
  private readonly reassembler = new OmiFrameReassembler();

  // Utterance accumulation.
  private utterance: Float32Array[] = [];
  private utteranceSamples = 0;
  private detector: ((pcm: Float32Array, t?: number) => { shouldBuffer: boolean; shouldStop: boolean }) | null = null;
  private sawSpeech = false;

  private state: PendantState = {
    status: "idle",
    deviceName: null,
    batteryPercent: null,
    codecId: null,
    lastTranscript: null,
    droppedPackets: 0,
    error: null,
  };

  /** True while an utterance is being transcribed — serializes finalizations. */
  private finalizing: Promise<void> = Promise.resolve();

  private readonly onAudioNotify = (event: Event): void => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const value = target.value;
    if (!value) return;
    // Respect the DataView's window into its ArrayBuffer — a bare
    // `new Uint8Array(value.buffer)` would read stale/extra bytes when the view
    // does not span the whole buffer.
    this.handleNotification(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  };

  private readonly onBatteryNotify = (event: Event): void => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const pct = target.value?.getUint8(0);
    if (typeof pct === "number") this.patch({ batteryPercent: pct });
  };

  private readonly onDisconnected = (): void => {
    this.cleanupListeners();
    // A remote disconnect (device powered off / out of range) must release the
    // decoder and reset refs too — not just detach listeners — so we don't leak
    // the wasm decoder until an explicit disconnect() that may never come.
    this.decoder?.free();
    this.decoder = null;
    this.audioChar = null;
    this.batteryChar = null;
    this.reassembler.reset();
    if (this.state.status !== "error") {
      this.patch({ status: "idle", deviceName: this.state.deviceName });
    }
  };

  constructor(private readonly opts: PendantConnectionOptions) {
    if (!isWebBluetoothAvailable()) {
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

  private resetDetector(): void {
    this.detector = createLocalAsrAutoStopDetector({
      silenceMs: this.opts.vadSilenceMs,
      speechRmsThreshold: this.opts.vadSpeechRmsThreshold,
    });
    this.utterance = [];
    this.utteranceSamples = 0;
    this.sawSpeech = false;
  }

  /** Request a device, connect GATT, subscribe to audio + battery. */
  async connect(): Promise<void> {
    if (!isWebBluetoothAvailable()) {
      this.patch({ status: "unsupported", error: "Web Bluetooth is not available in this browser." });
      return;
    }
    try {
      this.patch({ status: "requesting", error: null });
      const bluetooth = (navigator as Navigator & { bluetooth: Bluetooth }).bluetooth;
      const device = await bluetooth.requestDevice({
        // Accept by advertised name prefix ("Friend" today, "eliza" soon) AND
        // by the audio service so a renamed device still matches.
        filters: [
          ...OMI_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
          { services: [OMI_AUDIO_SERVICE_UUID] },
        ],
        optionalServices: [OMI_AUDIO_SERVICE_UUID, BATTERY_SERVICE_UUID],
      });
      this.device = device;
      this.patch({ status: "connecting", deviceName: device.name ?? "omi pendant" });

      device.addEventListener("gattserverdisconnected", this.onDisconnected);
      const server = await device.gatt?.connect();
      if (!server) throw new Error("GATT server unavailable");

      // Audio service + characteristics.
      const audioService = await server.getPrimaryService(OMI_AUDIO_SERVICE_UUID);
      const codecId = await this.readCodec(audioService);
      this.decoder = await createPendantAudioDecoder(codecId);
      await this.decoder.ready;

      this.audioChar = await audioService.getCharacteristic(OMI_AUDIO_DATA_CHAR_UUID);
      this.reassembler.reset();
      this.resetDetector();
      this.audioChar.addEventListener("characteristicvaluechanged", this.onAudioNotify);
      await this.audioChar.startNotifications();

      // Battery (best-effort — not all builds expose it).
      await this.subscribeBattery(server);

      this.patch({ status: "listening", codecId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect to pendant";
      // Tear down anything a partial setup left live so a failed connect never
      // leaks a GATT link, active notifications, listeners, or the decoder.
      this.cleanupListeners();
      try {
        this.device?.gatt?.disconnect();
      } catch {
        /* best-effort */
      }
      this.decoder?.free();
      this.decoder = null;
      this.audioChar = null;
      this.batteryChar = null;
      this.device = null;
      this.reassembler.reset();
      // A user cancelling the chooser throws NotFoundError — treat as idle, not error.
      if (err instanceof DOMException && err.name === "NotFoundError") {
        this.patch({ status: "idle", error: null });
        return;
      }
      this.patch({ status: "error", error: message });
    }
  }

  private async readCodec(
    audioService: BluetoothRemoteGATTService,
  ): Promise<OmiCodecId> {
    try {
      const codecChar = await audioService.getCharacteristic(OMI_AUDIO_CODEC_CHAR_UUID);
      const value = await codecChar.readValue();
      const raw = value.getUint8(0);
      return raw as OmiCodecId;
    } catch {
      // Codec characteristic missing/unreadable → assume the DK1 Opus default.
      return OMI_CODEC.OPUS_16K;
    }
  }

  private async subscribeBattery(server: BluetoothRemoteGATTServer): Promise<void> {
    try {
      const batteryService = await server.getPrimaryService(BATTERY_SERVICE_UUID);
      this.batteryChar = await batteryService.getCharacteristic(BATTERY_LEVEL_CHAR_UUID);
      const initial = await this.batteryChar.readValue();
      this.patch({ batteryPercent: initial.getUint8(0) });
      this.batteryChar.addEventListener("characteristicvaluechanged", this.onBatteryNotify);
      await this.batteryChar.startNotifications();
    } catch {
      // No battery service — leave batteryPercent null.
    }
  }

  private handleNotification(notification: Uint8Array): void {
    if (!this.decoder || !this.detector) return;
    const frames = this.reassembler.push(notification);
    for (const frame of frames) {
      if (frame.droppedBefore > 0) {
        this.patch({ droppedPackets: this.state.droppedPackets + frame.droppedBefore });
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
        if (this.state.status === "listening") this.patch({ status: "hearing" });
      }
    }
    if (update.shouldStop) {
      // Snapshot this utterance and re-arm immediately so audio during
      // transcription becomes the NEXT utterance (no dropped turns). Chain the
      // async transcription onto `finalizing` so concurrent utterances are
      // transcribed + dispatched strictly in order (never out of order).
      const chunks = this.utterance;
      const total = this.utteranceSamples;
      this.resetDetector();
      this.finalizing = this.finalizing.then(() =>
        this.finalizeUtterance(chunks, total),
      );
    }
  }

  private async finalizeUtterance(
    chunks: Float32Array[],
    total: number,
  ): Promise<void> {
    if (total === 0) return;
    const pcm = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      pcm.set(c, off);
      off += c.length;
    }
    // Guard against a spurious near-silent segment burning an ASR round-trip.
    if (isSilentPcmAudio(pcm)) return;

    const wav = encodeMonoPcm16Wav(pcm, OMI_OPUS_SAMPLE_RATE_HZ);
    const wasStatus = this.state.status;
    this.patch({ status: "transcribing" });
    try {
      const { text } = await transcribeLocalInferenceWav(wav);
      dispatchPendantVoiceTranscript(text);
      this.patch({ lastTranscript: text });
      this.opts.onTranscript?.(text);
    } catch {
      // Empty transcript / ASR error — silently drop this turn (the mic path
      // surfaces these as toasts; the pendant is ambient, so we stay quiet and
      // just keep listening).
    } finally {
      // Return to the ambient listening state (or hearing if speech already
      // resumed while we were transcribing).
      const next = wasStatus === "error" ? "error" : this.sawSpeech ? "hearing" : "listening";
      if (this.state.status === "transcribing") this.patch({ status: next });
    }
  }

  private cleanupListeners(): void {
    this.audioChar?.removeEventListener("characteristicvaluechanged", this.onAudioNotify);
    this.batteryChar?.removeEventListener("characteristicvaluechanged", this.onBatteryNotify);
    this.device?.removeEventListener("gattserverdisconnected", this.onDisconnected);
  }

  /** Tear down: stop notifications, disconnect GATT, free the decoder. */
  async disconnect(): Promise<void> {
    this.cleanupListeners();
    // Flush the final in-flight frame (no following packet will close it) so a
    // trailing utterance still gets transcribed on a clean disconnect.
    if (this.decoder) {
      for (const frame of this.reassembler.flush()) {
        const pcm = this.decoder.decodeFrame(frame.data);
        if (pcm.length > 0) this.feedVad(pcm);
      }
    }
    try {
      await this.audioChar?.stopNotifications();
    } catch {
      /* already gone */
    }
    try {
      this.device?.gatt?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.decoder?.free();
    this.decoder = null;
    this.audioChar = null;
    this.batteryChar = null;
    this.device = null;
    this.reassembler.reset();
    this.patch({ status: "idle", batteryPercent: null, codecId: null });
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
