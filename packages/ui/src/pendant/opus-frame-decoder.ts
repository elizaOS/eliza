/**
 * Opus → PCM16 decoder for the omi pendant audio stream.
 *
 * The DK1 firmware emits **raw Opus frames** (10 ms, 16 kHz mono — see
 * `omi-protocol.ts`), NOT an Ogg-Opus container. We decode them with
 * `opus-decoder` (libopus compiled to WebAssembly, wasm embedded inline as
 * base64 — no third-party `.wasm` asset to serve, which matters for the static
 * nginx-hosted dist). Its `decodeFrame(Uint8Array)` takes exactly one raw Opus
 * packet and returns Float32 PCM, which is precisely our frame shape.
 *
 * The decoder is loaded lazily (dynamic import) so its ~90 KB wasm payload only
 * lands when a pendant is actually connected, and so SSR / test environments
 * without `WebAssembly` never pull it in at module eval time.
 *
 * Verified end-to-end: a 16 kHz mono `libopus -frame_duration 10 -application
 * lowdelay` stream demuxed to raw frames decodes cleanly through this path
 * (non-silent tone recovered at the correct sample rate).
 */

import { ElizaError, logger } from "@elizaos/core";
import {
  OMI_CODEC,
  OMI_OPUS_CHANNELS,
  OMI_OPUS_SAMPLE_RATE_HZ,
  type OmiCodecId,
} from "./omi-protocol";

/** Minimal shape of the `opus-decoder` main-thread decoder we rely on. */
interface OpusDecoderLike {
  ready: Promise<void>;
  decodeFrame(frame: Uint8Array): {
    channelData: Float32Array[];
    samplesDecoded: number;
  };
  free(): void;
  reset(): Promise<void>;
}

export interface PendantAudioDecoder {
  /** Resolves once the underlying codec is ready to decode. */
  readonly ready: Promise<void>;
  /** Decode one wire frame → mono Float32 PCM @ 16 kHz. */
  decodeFrame(frame: Uint8Array): Float32Array;
  /** Release native resources. */
  free(): void;
}

/**
 * Build a decoder for the codec the pendant reports.
 *
 * - `OPUS_16K` (the DK1 default): libopus-wasm frame decoder.
 * - `PCM_16K` / `PCM_8K`: interpret payloads as little-endian int16 PCM and
 *   normalise to Float32 (no codec needed — a fallback for PCM firmware builds).
 * - `MU_LAW_8K`: G.711 µ-law expansion to Float32.
 */
export async function createPendantAudioDecoder(
  codecId: OmiCodecId,
): Promise<PendantAudioDecoder> {
  if (codecId === OMI_CODEC.OPUS_16K) {
    return createOpusDecoder();
  }
  if (codecId === OMI_CODEC.PCM_16K || codecId === OMI_CODEC.PCM_8K) {
    return createPcm16Decoder();
  }
  if (codecId === OMI_CODEC.MU_LAW_8K) {
    return createMuLawDecoder();
  }
  throw new ElizaError("Pendant reported an unsupported audio codec.", {
    code: "PENDANT_AUDIO_CODEC_UNSUPPORTED",
    context: { codecId },
    severity: "fatal",
  });
}

async function createOpusDecoder(): Promise<PendantAudioDecoder> {
  // Dynamic import keeps the wasm out of the initial bundle graph.
  const mod = (await import("opus-decoder")) as {
    OpusDecoder: new (opts: {
      sampleRate: number;
      channels: number;
    }) => OpusDecoderLike;
  };
  const decoder = new mod.OpusDecoder({
    sampleRate: OMI_OPUS_SAMPLE_RATE_HZ,
    channels: OMI_OPUS_CHANNELS,
  });
  const ready = decoder.ready;
  await ready;
  return {
    ready: Promise.resolve(),
    decodeFrame(frame: Uint8Array): Float32Array {
      if (frame.length === 0) return EMPTY;
      const result = decoder.decodeFrame(frame);
      const channel = result.channelData[0];
      if (!channel) {
        throw new ElizaError(
          "Pendant Opus decoder returned no audio channel.",
          {
            code: "PENDANT_AUDIO_DECODE_FAILED",
            context: { frameBytes: frame.byteLength },
            severity: "ephemeral",
          },
        );
      }
      return channel;
    },
    free() {
      try {
        decoder.free();
      } catch (error) {
        // error-policy:J6 Decoder release is best-effort after the stream has stopped.
        logger.debug(
          { error },
          "[PendantAudioDecoder] Decoder was already released",
        );
      }
    },
  };
}

function createPcm16Decoder(): PendantAudioDecoder {
  return {
    ready: Promise.resolve(),
    decodeFrame(frame: Uint8Array): Float32Array {
      const sampleCount = frame.length >> 1;
      if (sampleCount === 0) return EMPTY;
      const view = new DataView(
        frame.buffer,
        frame.byteOffset,
        sampleCount * 2,
      );
      const out = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        out[i] = view.getInt16(i * 2, true) / 0x8000;
      }
      return out;
    },
    free() {},
  };
}

function createMuLawDecoder(): PendantAudioDecoder {
  // Precompute the 256-entry µ-law → int16 table.
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    table[i] = sign ? -sample : sample;
  }
  return {
    ready: Promise.resolve(),
    decodeFrame(frame: Uint8Array): Float32Array {
      if (frame.length === 0) return EMPTY;
      const out = new Float32Array(frame.length);
      for (let i = 0; i < frame.length; i++) {
        out[i] = table[frame[i]] / 0x8000;
      }
      return out;
    },
    free() {},
  };
}

const EMPTY = new Float32Array(0);
