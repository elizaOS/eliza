/**
 * Kokoro-82M TTS backend.
 *
 * Implements the same `OmniVoiceBackend + StreamingTtsBackend` seam that
 * `FfiOmniVoiceBackend` (the OmniVoice path) satisfies, so a
 * `VoiceScheduler` instance does not need to know which TTS family it is
 * driving. The runtime selection layer (`runtime-selection.ts`) picks
 * between this and `FfiOmniVoiceBackend` based on hardware tier and the
 * caller's first-audio-latency target.
 *
 * The actual model inference is delegated to a `KokoroRuntime` instance
 * (ONNX / GGUF / mock) — this class owns:
 *   - phonemizer resolution + per-phrase phonemize call,
 *   - voice-pack resolution against `SpeakerPreset.voiceId`,
 *   - streaming-protocol bookkeeping (cancel signal polling, final tail).
 *
 * No fallback sludge: if the runtime is unavailable, the backend throws
 * on first synthesis rather than emitting silent zero PCM (AGENTS.md §3).
 */

import type {
  AudioChunk,
  OmniVoiceBackend,
  Phrase,
  SpeakerPreset,
  StreamingTtsBackend,
  TtsPcmChunk,
} from "../types";
import type { KokoroRuntime } from "./kokoro-runtime";
import { resolvePhonemizer } from "./phonemizer";
import type {
  KokoroBackendOptions,
  KokoroPhonemizer,
  KokoroVoicePack,
} from "./types";
import { resolveKokoroVoiceOrDefault } from "./voices";

export interface KokoroTtsBackendDeps extends KokoroBackendOptions {
  /** The concrete model runner. Wire `KokoroOnnxRuntime` in production
   *  and `KokoroMockRuntime` in tests. */
  runtime: KokoroRuntime;
}

/**
 * `KokoroTtsBackend` is a streaming-only TTS backend (the model has no
 * cheaper non-streaming path — ONNX still produces the full waveform in
 * one forward, but we surface it as one body chunk + tail so the
 * scheduler protocol is identical for both backends).
 */
export class KokoroTtsBackend implements OmniVoiceBackend, StreamingTtsBackend {
  readonly id = "kokoro" as const;
  private readonly runtime: KokoroRuntime;
  private readonly defaultVoiceId: string;
  private readonly streamingChunkSamples: number;
  private phonemizer: KokoroPhonemizer | null = null;
  private readonly phonemizerOverride?: KokoroPhonemizer;

  constructor(deps: KokoroTtsBackendDeps) {
    this.runtime = deps.runtime;
    this.defaultVoiceId = deps.defaultVoiceId;
    this.streamingChunkSamples =
      deps.streamingChunkSamples ?? Math.floor(deps.layout.sampleRate / 4);
    this.phonemizerOverride = deps.phonemizer;
  }

  /** Native sample rate of the model output (24 kHz for Kokoro v1.0). */
  get sampleRate(): number {
    return this.runtime.sampleRate;
  }

  /** Always true — `KokoroTtsBackend` satisfies `StreamingTtsBackend`. */
  supportsStreamingTts(): boolean {
    return true;
  }

  /**
   * One-shot synthesis. Drives the streaming path internally and
   * concatenates chunks. Cancellation observed at chunk boundaries.
   */
  async synthesize(args: {
    phrase: Phrase;
    preset: SpeakerPreset;
    cancelSignal: { cancelled: boolean };
    onKernelTick?: () => void;
  }): Promise<AudioChunk> {
    const collected: Float32Array[] = [];
    let total = 0;
    await this.synthesizeStream({
      phrase: args.phrase,
      preset: args.preset,
      cancelSignal: args.cancelSignal,
      onKernelTick: args.onKernelTick,
      onChunk: ({ pcm, isFinal }) => {
        args.onKernelTick?.();
        if (!isFinal && pcm.length > 0) {
          collected.push(pcm);
          total += pcm.length;
        }
        return args.cancelSignal.cancelled;
      },
    });
    const merged = new Float32Array(total);
    let off = 0;
    for (const part of collected) {
      merged.set(part, off);
      off += part.length;
    }
    return {
      phraseId: args.phrase.id,
      fromIndex: args.phrase.fromIndex,
      toIndex: args.phrase.toIndex,
      pcm: merged,
      sampleRate: this.runtime.sampleRate,
    };
  }

  async synthesizeStream(args: {
    phrase: Phrase;
    preset: SpeakerPreset;
    cancelSignal: { cancelled: boolean };
    onChunk: (chunk: TtsPcmChunk) => boolean | undefined;
    onKernelTick?: () => void;
  }): Promise<{ cancelled: boolean }> {
    const voice = this.resolveVoice(args.preset);
    const phonemizer = await this.ensurePhonemizer();
    args.onKernelTick?.();
    const phonemes = await phonemizer.phonemize(args.phrase.text, voice.lang);
    if (args.cancelSignal.cancelled) {
      args.onChunk({
        pcm: new Float32Array(0),
        sampleRate: this.runtime.sampleRate,
        isFinal: true,
      });
      return { cancelled: true };
    }

    // The runtime emits one (or a few) body chunks. We re-chunk to
    // `streamingChunkSamples` so the scheduler's ring buffer sees a
    // continuous trickle even when ONNX returns the whole waveform at
    // once — this is how Kokoro's ~97ms TTFB becomes audible to the
    // listener before the full phrase finishes decoding.
    const limit = this.streamingChunkSamples;
    let cancelled = false;
    const result = await this.runtime.synthesize({
      phonemes,
      voice,
      cancelSignal: args.cancelSignal,
      onChunk: ({ pcm, isFinal }) => {
        args.onKernelTick?.();
        if (cancelled || args.cancelSignal.cancelled) {
          cancelled = true;
          return true;
        }
        if (pcm.length === 0) {
          // Pass through tail markers from the runtime — the final tail is
          // emitted by us below, so swallow runtime-side finals to avoid
          // double-tails.
          if (!isFinal) return false;
          return false;
        }
        for (let off = 0; off < pcm.length; off += limit) {
          if (args.cancelSignal.cancelled) {
            cancelled = true;
            return true;
          }
          const end = Math.min(pcm.length, off + limit);
          const slice = pcm.subarray(off, end);
          const want = args.onChunk({
            pcm: slice,
            sampleRate: this.runtime.sampleRate,
            isFinal: false,
          });
          if (want === true || args.cancelSignal.cancelled) {
            cancelled = true;
            return true;
          }
        }
        return false;
      },
    });
    args.onChunk({
      pcm: new Float32Array(0),
      sampleRate: this.runtime.sampleRate,
      isFinal: true,
    });
    return { cancelled: cancelled || result.cancelled };
  }

  dispose(): void {
    this.runtime.dispose();
  }

  private resolveVoice(preset: SpeakerPreset): KokoroVoicePack {
    // The scheduler's `SpeakerPreset.voiceId` is the canonical caller
    // hook for picking a Kokoro voice; an unknown id falls back to the
    // configured default rather than throwing (so OmniVoice-authored
    // presets still produce audio when routed through Kokoro).
    const id = preset.voiceId || this.defaultVoiceId;
    return resolveKokoroVoiceOrDefault(id);
  }

  private async ensurePhonemizer(): Promise<KokoroPhonemizer> {
    if (this.phonemizer) return this.phonemizer;
    this.phonemizer = await resolvePhonemizer(this.phonemizerOverride);
    return this.phonemizer;
  }
}
