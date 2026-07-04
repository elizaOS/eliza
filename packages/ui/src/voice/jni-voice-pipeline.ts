/**
 * In-process JNI voice pipeline (the normal Android APK).
 *
 * On the normal `ai.elizaos.app` Android build the four fused voice
 * classifiers (Silero VAD, openWakeWord, WeSpeaker speaker encoder, pyannote
 * diarizer) run INSIDE the Capacitor/bionic app process via the `ElizaVoice`
 * JNI host — NOT the embedded musl bun agent. This module is the WebView-side
 * driver: it pumps the native `audioFrame` PCM stream straight into the JNI
 * pipeline (which runs the VAD hot-loop + turn segmentation natively, zero
 * per-window bridge chatter) and surfaces a turn-level result (speaker
 * embedding + diariz segments) to the ambient-gate layer.
 *
 * This replaces the {@link AudioFramePump} bun-agent transport
 * (`POST /api/voice/audio-frames` → `LiveDiarizationSession`) for the JNI host:
 * the same `AudioFrameConsumer` → attribution → voiceTurnSignal contract, but
 * the native ops execute in-process instead of over an HTTP hop to the musl
 * agent. The speaker-match-against-enrolled-profiles + the ambient gate stay in
 * JS (per-turn, infrequent); only the heavy forward passes are native.
 *
 *   startAudioFrames() → `audioFrame` events → batch (~1 s) →
 *     ElizaVoice.pipelineProcess (native VAD + segmentation + speaker + diariz)
 *       → onCompletedPcmTurn? (ASR/text/TTS) + onTurn(JniAttributedTurn)
 *       → buildVoiceTurnSignal → VOICE_DM
 *
 * It is native-only: construction throws off Android (no `ElizaVoice` plugin),
 * and the caller gates it behind `isPlatform("android") && isNativePlatform()`.
 */

import { logger } from "@elizaos/logger";
import {
  EchoReferenceBuffer,
  NlmsEchoCanceller,
  platformPlaybackDelaySamples,
} from "@elizaos/shared/voice/aec";
import type {
  ElizaVoicePluginLike,
  ElizaVoiceTurn,
  TalkModeAudioFrameEvent,
  TalkModePlaybackFrameEvent,
  TalkModePluginLike,
} from "../bridge/native-plugins";
import {
  type BuildVoiceTurnSignalContext,
  buildVoiceTurnSignal,
  type VoiceTurnSignal,
  type VoiceTurnSpeakerAttribution,
} from "./voice-turn-signal";

/** Max audioFrames buffered before a pipeline feed is forced (≈ 1 s @ 20 ms). */
const MAX_BATCH_FRAMES = 49;
/** Feed cadence in ms (a partial batch is fed even below the size cap). */
const FEED_INTERVAL_MS = 250;
const PIPELINE_SAMPLE_RATE = 16_000;
const ANDROID_PLAYBACK_DELAY_SAMPLES = platformPlaybackDelaySamples(
  "android",
  PIPELINE_SAMPLE_RATE,
);

/**
 * One native-attributed turn surfaced to the ambient-gate layer. The PCM-derived
 * speaker embedding + diariz frame count come straight from the JNI host; the
 * `signal` is the ambient gate's verdict for this turn (built from the supplied
 * `transcript`, the speaker attribution, and any wake-word hit).
 */
export interface JniAttributedTurn {
  turnId: string;
  /** Total turn samples segmented by the native VAD. */
  samples: number;
  durationMs: number;
  /** L2 norm of the 256-d speaker embedding (≈ 1.0 for a real embedding). */
  embeddingNorm: number;
  /** The decoded 256-d speaker embedding (empty when the turn was too short). */
  embedding: Float32Array;
  /** Per-frame pyannote powerset labels for the 5 s diariz window. */
  diarizLabels: Int8Array;
  /** Distinct diariz classes that fired (1 ≈ single speaker). */
  diarizDistinctClasses: number;
  /** The ambient-gate verdict for this turn. */
  signal: VoiceTurnSignal;
}

export type JniTurnListener = (turn: JniAttributedTurn) => void;

export interface JniCompletedPcmTurn {
  turnId: string;
  audio: {
    pcm: Float32Array;
    sampleRate: number;
  };
  signal: VoiceTurnSignal;
}

export type JniCompletedPcmTurnListener = (
  turn: JniCompletedPcmTurn,
) => void | Promise<void>;

/**
 * Resolves the enrolled-entity attribution for a turn's speaker embedding. The
 * caller injects this so the embedding→entity match (and the enrolled-speaker
 * set) stay where the profile store lives, not in the WebView pump. Returns
 * `null` to mean "no attribution" (the gate then fails open). When omitted the
 * pipeline surfaces turns with no speaker attribution (transcript gate only).
 */
export type SpeakerResolver = (
  embedding: Float32Array,
) => Promise<VoiceTurnSpeakerAttribution | null>;

export type SelfVoiceSimilarityResolver = (
  embedding: Float32Array,
) => Promise<number | null | undefined> | number | null | undefined;

export type SelfVoiceContextProvider =
  | Pick<
      BuildVoiceTurnSignalContext,
      "agentSpeaking" | "recentAgentReply" | "replyAgeMs"
    >
  | (() =>
      | Pick<
          BuildVoiceTurnSignalContext,
          "agentSpeaking" | "recentAgentReply" | "replyAgeMs"
        >
      | Promise<
          Pick<
            BuildVoiceTurnSignalContext,
            "agentSpeaking" | "recentAgentReply" | "replyAgeMs"
          >
        >);

export interface JniVoicePipelineOptions {
  /** Override the on-device bundle dir (else the app's eliza-1/bundle default). */
  bundleDir?: string;
  /** Resolves a turn's speaker embedding to an enrolled entity (optional). */
  resolveSpeaker?: SpeakerResolver;
  /** Resolves a turn's embedding against the agent-TTS voice centroid. */
  resolveSelfVoiceSimilarity?: SelfVoiceSimilarityResolver;
  /** Supplies reply recency / playback state for acoustic self-voice gating. */
  selfVoiceContext?: SelfVoiceContextProvider;
  /** Entity ids the agent answers to without a wake word (owner + enrolled). */
  knownSpeakerEntityIds?: readonly string[];
  /**
   * Optional handoff for the segmented PCM turn. When present, the native
   * bridge requests the completed turn PCM and dispatches it here so the host
   * can queue it through the fused ASR → text → TTS device voice path.
   */
  onCompletedPcmTurn?: JniCompletedPcmTurnListener;
}

function base64ToFloat32(b64: string): Float32Array {
  if (!b64) return new Float32Array(0);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(
    bytes.buffer,
    bytes.byteOffset,
    Math.floor(bytes.byteLength / 4),
  );
}

function base64ToInt8(b64: string): Int8Array {
  if (!b64) return new Int8Array(0);
  const bin = atob(b64);
  const out = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1)
    out[i] = (bin.charCodeAt(i) << 24) >> 24;
  return out;
}

function base64Pcm16ToFloat32(b64: string, channels = 1): Float32Array {
  if (!b64) return new Float32Array(0);
  const bin = atob(b64);
  const channelCount = Math.max(1, Math.floor(channels));
  const samples = Math.floor(bin.length / (2 * channelCount));
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    let mixed = 0;
    for (let ch = 0; ch < channelCount; ch += 1) {
      const offset = (i * channelCount + ch) * 2;
      const lo = bin.charCodeAt(offset);
      const hi = bin.charCodeAt(offset + 1);
      const signed = (((hi << 8) | lo) << 16) >> 16;
      mixed += Math.max(-1, Math.min(1, signed / 32768));
    }
    out[i] = mixed / channelCount;
  }
  return out;
}

function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  const sourceRate = Math.max(1, Math.floor(fromRate || toRate));
  if (input.length === 0 || sourceRate === toRate) return input;
  const outLength = Math.max(
    1,
    Math.round((input.length * toRate) / sourceRate),
  );
  const out = new Float32Array(outLength);
  const ratio = sourceRate / toRate;
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(input.length - 1, left + 1);
    const frac = pos - left;
    out[i] = (input[left] ?? 0) * (1 - frac) + (input[right] ?? 0) * frac;
  }
  return out;
}

function decodePcm16VoiceFrame(
  event: Pick<
    TalkModeAudioFrameEvent | TalkModePlaybackFrameEvent,
    "pcm16" | "sampleRate" | "channels"
  >,
): Float32Array {
  return resampleLinear(
    base64Pcm16ToFloat32(event.pcm16, event.channels),
    event.sampleRate,
    PIPELINE_SAMPLE_RATE,
  );
}

function float32ToBase64Pcm16(samples: Float32Array): string {
  if (samples.length === 0) return "";
  let bin = "";
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const signed =
      clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    const value = signed < 0 ? signed + 65536 : signed;
    bin += String.fromCharCode(value & 0xff, (value >> 8) & 0xff);
  }
  return btoa(bin);
}

/**
 * Concatenate a batch of `audioFrame` payloads (each base64 LE-s16) into one
 * base64 LE-s16 blob for a single `pipelineProcess` call. Decoding to bytes and
 * re-encoding once per batch (not per frame) keeps the bridge call count to one
 * per ~1 s of audio.
 */
function concatFramesToBase64(frames: TalkModeAudioFrameEvent[]): string {
  let total = 0;
  const decoded: Uint8Array[] = [];
  for (const f of frames) {
    const bin = atob(f.pcm16);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    decoded.push(bytes);
    total += bytes.length;
  }
  const merged = new Uint8Array(total);
  let cursor = 0;
  for (const d of decoded) {
    merged.set(d, cursor);
    cursor += d.length;
  }
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < merged.length; i += CHUNK) {
    out += String.fromCharCode.apply(
      null,
      Array.from(merged.subarray(i, i + CHUNK)),
    );
  }
  return btoa(out);
}

/**
 * Drives the Android `audioFrame` → in-process JNI voice pipeline. One instance
 * per capture session.
 */
export class JniVoicePipeline {
  private readonly talkmode: TalkModePluginLike;
  private readonly voice: ElizaVoicePluginLike;
  private readonly options: JniVoicePipelineOptions;
  private readonly turnListeners = new Set<JniTurnListener>();

  private ctxHandle: string | null = null;
  private pipelineHandle: string | null = null;
  private removeListener: (() => void) | null = null;
  private removePlaybackListener: (() => void) | null = null;
  private feedTimer: ReturnType<typeof setInterval> | null = null;
  private buffer: TalkModeAudioFrameEvent[] = [];
  private feeding: Promise<void> = Promise.resolve();
  private readonly echoReference = new EchoReferenceBuffer({
    capacitySamples: PIPELINE_SAMPLE_RATE * 3,
    sampleRateHz: PIPELINE_SAMPLE_RATE,
  });
  private readonly echoCanceller = new NlmsEchoCanceller({
    residualSuppression: true,
  });
  private running = false;

  framesSent = 0;
  playbackFramesReceived = 0;
  lastEchoErleDb = 0;
  turnsObserved = 0;

  constructor(
    talkmode: TalkModePluginLike,
    voice: ElizaVoicePluginLike,
    options: JniVoicePipelineOptions = {},
  ) {
    this.talkmode = talkmode;
    this.voice = voice;
    this.options = options;
  }

  get isRunning(): boolean {
    return this.running;
  }

  onTurn(listener: JniTurnListener): () => void {
    this.turnListeners.add(listener);
    return () => this.turnListeners.delete(listener);
  }

  /** Open the native pipeline, subscribe to `audioFrame`, and start capture. */
  async start(): Promise<{ started: boolean; error?: string }> {
    if (this.running) return { started: true };
    if (typeof this.talkmode.startAudioFrames !== "function") {
      return { started: false, error: "startAudioFrames not supported" };
    }
    const abi = await this.voice.voiceAbiVersion();
    if (!abi.loaded || abi.vad !== 1 || abi.speaker !== 1 || abi.diariz !== 1) {
      return {
        started: false,
        error: `fused voice runtime unavailable (loaded=${abi.loaded} vad=${abi.vad} speaker=${abi.speaker} diariz=${abi.diariz})`,
      };
    }
    const ctx = await this.voice.contextCreate(
      this.options.bundleDir ? { bundleDir: this.options.bundleDir } : {},
    );
    this.ctxHandle = ctx.handle;
    const pl = await this.voice.pipelineOpen({ ctx: ctx.handle });
    this.pipelineHandle = pl.handle;

    const handle = await this.talkmode.addListener(
      "audioFrame",
      (event: TalkModeAudioFrameEvent) => this.onFrame(event),
    );
    this.removeListener = () => {
      void handle.remove();
    };
    const playbackHandle = await this.talkmode.addListener(
      "playbackFrame",
      (event: TalkModePlaybackFrameEvent) => this.onPlaybackFrame(event),
    );
    this.removePlaybackListener = () => {
      void playbackHandle.remove();
    };

    const result = await this.talkmode.startAudioFrames({
      sampleRate: PIPELINE_SAMPLE_RATE,
      frameMs: 20,
    });
    if (!result.started) {
      this.removeListener?.();
      this.removeListener = null;
      this.removePlaybackListener?.();
      this.removePlaybackListener = null;
      await this.teardownNative();
      return { started: false, error: result.error };
    }
    this.running = true;
    this.feedTimer = setInterval(() => {
      void this.feed();
    }, FEED_INTERVAL_MS);
    return { started: true };
  }

  /** Stop capture, flush the open turn, and release native handles. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.feedTimer) {
      clearInterval(this.feedTimer);
      this.feedTimer = null;
    }
    if (typeof this.talkmode.stopAudioFrames === "function") {
      await this.talkmode.stopAudioFrames();
    }
    this.removeListener?.();
    this.removeListener = null;
    this.removePlaybackListener?.();
    this.removePlaybackListener = null;
    await this.feed();
    await this.feeding;
    if (this.pipelineHandle) {
      const flushed = await this.voice.pipelineFlush({
        handle: this.pipelineHandle,
        includePcm: Boolean(this.options.onCompletedPcmTurn),
      });
      await this.emitTurns(flushed.turns);
    }
    await this.teardownNative();
    this.echoReference.reset();
    this.echoCanceller.reset();
  }

  private async teardownNative(): Promise<void> {
    if (this.pipelineHandle) {
      await this.voice.pipelineClose({ handle: this.pipelineHandle });
      this.pipelineHandle = null;
    }
    if (this.ctxHandle) {
      await this.voice.contextDestroy({ handle: this.ctxHandle });
      this.ctxHandle = null;
    }
  }

  private onFrame(event: TalkModeAudioFrameEvent): void {
    if (!this.running) return;
    this.buffer.push(event);
    if (this.buffer.length >= MAX_BATCH_FRAMES) void this.feed();
  }

  private onPlaybackFrame(event: TalkModePlaybackFrameEvent): void {
    if (!this.running) return;
    if (event.frameIndex === 0) {
      this.echoReference.reset();
      this.echoCanceller.reset();
    }
    const playback = decodePcm16VoiceFrame(event);
    if (playback.length === 0) return;
    this.echoReference.pushAt(event.timestamp, playback);
    this.playbackFramesReceived += 1;
  }

  /** Feed the buffered batch into the native pipeline. Serialized + ordered. */
  private async feed(): Promise<void> {
    if (this.buffer.length === 0) return;
    const frames = this.buffer;
    this.buffer = [];
    this.feeding = this.feeding.then(() => this.process(frames));
    return this.feeding;
  }

  private async process(frames: TalkModeAudioFrameEvent[]): Promise<void> {
    if (frames.length === 0 || !this.pipelineHandle) return;
    const pcm16 = this.cancelEchoForBatch(frames);
    this.framesSent += frames.length;
    const res = await this.voice.pipelineProcess({
      handle: this.pipelineHandle,
      pcm16,
      includePcm: Boolean(this.options.onCompletedPcmTurn),
    });
    await this.emitTurns(res.turns);
  }

  private cancelEchoForBatch(frames: TalkModeAudioFrameEvent[]): string {
    const rawPcm16 = concatFramesToBase64(frames);
    if (this.playbackFramesReceived === 0) return rawPcm16;

    const near = base64Pcm16ToFloat32(rawPcm16);
    if (near.length === 0) return rawPcm16;
    const firstTimestamp =
      typeof frames[0]?.timestamp === "number" ? frames[0].timestamp : NaN;
    const far = Number.isFinite(firstTimestamp)
      ? this.echoReference.referenceAt(
          firstTimestamp,
          near.length,
          ANDROID_PLAYBACK_DELAY_SAMPLES,
        )
      : this.echoReference.referenceFor(
          near.length,
          ANDROID_PLAYBACK_DELAY_SAMPLES,
        );
    let cleaned = near;
    if (far.some((sample) => sample !== 0)) {
      cleaned = this.echoCanceller.process(near, far);
    } else {
      this.echoCanceller.observeFarEndSilence(near);
    }
    this.lastEchoErleDb = this.echoCanceller.lastErleDb;
    return float32ToBase64Pcm16(cleaned);
  }

  private async emitTurns(turns: ElizaVoiceTurn[]): Promise<void> {
    for (const raw of turns) {
      const embedding = base64ToFloat32(raw.embedding);
      const attribution =
        embedding.length > 0 && this.options.resolveSpeaker
          ? await this.options.resolveSpeaker(embedding)
          : null;
      const selfVoiceSimilarity =
        embedding.length > 0 && this.options.resolveSelfVoiceSimilarity
          ? await this.options.resolveSelfVoiceSimilarity(embedding)
          : undefined;
      const selfVoiceContext = await this.resolveSelfVoiceContext();
      // Transcript is the ASR path's concern; the ambient gate's audio-frame
      // inputs (speaker identity, wake word) are what this pipeline supplies.
      // An empty transcript degrades to the conservative transcript gate, which
      // the diarization speaker gate then refines.
      const signal = buildVoiceTurnSignal("", {
        ...selfVoiceContext,
        ...(attribution ? { speaker: attribution } : {}),
        ...(this.options.knownSpeakerEntityIds
          ? { knownSpeakerEntityIds: this.options.knownSpeakerEntityIds }
          : {}),
        ...(typeof selfVoiceSimilarity === "number" &&
        Number.isFinite(selfVoiceSimilarity)
          ? { selfVoiceSimilarity }
          : {}),
      });
      this.turnsObserved += 1;
      const turn: JniAttributedTurn = {
        turnId: raw.turnId,
        samples: raw.samples,
        durationMs: raw.durationMs,
        embeddingNorm: raw.embNorm,
        embedding,
        diarizLabels: base64ToInt8(raw.labels),
        diarizDistinctClasses: raw.diarizDistinctClasses,
        signal,
      };
      this.dispatchCompletedPcmTurn(raw, signal);
      for (const listener of this.turnListeners) listener(turn);
    }
  }

  private async resolveSelfVoiceContext(): Promise<
    Pick<
      BuildVoiceTurnSignalContext,
      "agentSpeaking" | "recentAgentReply" | "replyAgeMs"
    >
  > {
    const provider = this.options.selfVoiceContext;
    if (!provider) return {};
    return typeof provider === "function" ? await provider() : provider;
  }

  private dispatchCompletedPcmTurn(
    raw: ElizaVoiceTurn,
    signal: VoiceTurnSignal,
  ): void {
    const listener = this.options.onCompletedPcmTurn;
    if (!listener) return;
    const pcm = base64ToFloat32(raw.pcm ?? "");
    if (pcm.length === 0) return;
    void Promise.resolve(
      listener({
        turnId: raw.turnId,
        audio: {
          pcm,
          sampleRate:
            typeof raw.pcmSampleRate === "number" ? raw.pcmSampleRate : 16_000,
        },
        signal,
      }),
    ).catch((error) => {
      // error-policy:J7 a turn-listener failure must not kill the voice
      // pipeline loop; it is logged with the turn id
      logger.warn(
        { error, turnId: raw.turnId },
        "[JniVoicePipeline] completed PCM turn listener failed",
      );
    });
  }
}
