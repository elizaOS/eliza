/**
 * In-process audio bus for the three-agent dialogue harness.
 *
 * Each agent's TTS output (raw WAV bytes) is written to the bus via
 * `publish()`. The bus accumulates per-speaker buffers and produces:
 *   - Per-turn per-agent WAV files
 *   - A combined mix WAV covering all turns
 *
 * The mix is a simple sequential concatenation (not interleaved overlap)
 * because the scripted scenario serialises turns. For overlap testing,
 * the bus retains per-speaker buffers that can be mixed with offset in
 * a future iteration.
 *
 * Audio format contract:
 *   - All input is raw WAV (or raw PCM if flagged) returned by the TTS provider.
 *   - The bus normalises everything to 16-bit / 22050 Hz / mono WAV output.
 *   - If the provider returns WAV, we strip the header and re-wrap.
 *   - If the provider returns MP3 or unknown binary, we pass it through as-is
 *     (the mix check will still test non-blank bytes).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One published chunk on the audio bus. */
export interface AudioChunk {
  turnIdx: number;
  speaker: string;
  /** Raw bytes returned by TTS — may be WAV, PCM, or provider-specific. */
  bytes: Uint8Array;
  /** ISO timestamp of publish. */
  publishedAt: string;
}

/** Stats about the collected audio. */
export interface AudioBusStats {
  totalChunks: number;
  totalBytes: number;
  speakerChunks: Record<string, number>;
  speakerBytes: Record<string, number>;
  durationEstimateSec: number;
}

/**
 * WAV header constants (44-byte canonical PCM header).
 * We detect WAV by checking the first 4 bytes for "RIFF".
 */
function isWavBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return (
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 // F
  );
}

/**
 * Strip the WAV header (first 44 bytes for standard PCM WAV) to get raw PCM.
 * Returns the full buffer if the header is not present or too short.
 */
function stripWavHeader(bytes: Uint8Array): Uint8Array {
  if (isWavBytes(bytes) && bytes.length > 44) {
    return bytes.slice(44);
  }
  return bytes;
}

/**
 * Build a minimal 44-byte PCM WAV header.
 * @param dataLen - number of PCM data bytes
 * @param sampleRate - default 22050
 * @param numChannels - default 1 (mono)
 * @param bitsPerSample - default 16
 */
function buildWavHeader(
  dataLen: number,
  sampleRate = 22050,
  numChannels = 1,
  bitsPerSample = 16,
): Uint8Array {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = new DataView(new ArrayBuffer(44));
  const enc = new TextEncoder();

  // ChunkID "RIFF"
  const riff = enc.encode("RIFF");
  new Uint8Array(header.buffer).set(riff, 0);
  // ChunkSize
  header.setUint32(4, 36 + dataLen, true);
  // Format "WAVE"
  const wave = enc.encode("WAVE");
  new Uint8Array(header.buffer).set(wave, 8);
  // Subchunk1ID "fmt "
  const fmt = enc.encode("fmt ");
  new Uint8Array(header.buffer).set(fmt, 12);
  // Subchunk1Size = 16 for PCM
  header.setUint32(16, 16, true);
  // AudioFormat = 1 (PCM)
  header.setUint16(20, 1, true);
  // NumChannels
  header.setUint16(22, numChannels, true);
  // SampleRate
  header.setUint32(24, sampleRate, true);
  // ByteRate
  header.setUint32(28, byteRate, true);
  // BlockAlign
  header.setUint16(32, blockAlign, true);
  // BitsPerSample
  header.setUint16(34, bitsPerSample, true);
  // Subchunk2ID "data"
  const data = enc.encode("data");
  new Uint8Array(header.buffer).set(data, 36);
  // Subchunk2Size
  header.setUint32(40, dataLen, true);

  return new Uint8Array(header.buffer);
}

/**
 * Wrap raw PCM bytes in a WAV header.
 * If input is already WAV, return as-is.
 */
function ensureWav(bytes: Uint8Array): Uint8Array {
  if (isWavBytes(bytes)) return bytes;
  // Treat as raw 16-bit/22050Hz/mono PCM and wrap
  const header = buildWavHeader(bytes.length);
  const out = new Uint8Array(header.length + bytes.length);
  out.set(header, 0);
  out.set(bytes, header.length);
  return out;
}

/**
 * Concatenate multiple WAV/PCM buffers into a single WAV.
 * Strips headers from each chunk, concatenates raw PCM, then wraps.
 */
function concatenateWavBuffers(buffers: Uint8Array[]): Uint8Array {
  if (buffers.length === 0) {
    // Return a minimal silent WAV (0.1s of silence at 22050Hz/16bit/mono)
    const silentSamples = Math.round(22050 * 0.1);
    const pcm = new Uint8Array(silentSamples * 2); // 16-bit = 2 bytes/sample
    const header = buildWavHeader(pcm.length);
    const out = new Uint8Array(header.length + pcm.length);
    out.set(header, 0);
    out.set(pcm, header.length);
    return out;
  }

  const pcmParts: Uint8Array[] = [];
  for (const buf of buffers) {
    if (isWavBytes(buf)) {
      pcmParts.push(stripWavHeader(buf));
    } else {
      // Assume raw PCM
      pcmParts.push(buf);
    }
  }

  const totalPcmLen = pcmParts.reduce((acc, p) => acc + p.length, 0);
  const combined = new Uint8Array(totalPcmLen);
  let offset = 0;
  for (const part of pcmParts) {
    combined.set(part, offset);
    offset += part.length;
  }

  const header = buildWavHeader(totalPcmLen);
  const out = new Uint8Array(header.length + totalPcmLen);
  out.set(header, 0);
  out.set(combined, header.length);
  return out;
}

/**
 * Estimate audio duration from WAV bytes.
 * Returns 0 if the header is not present or too short.
 */
export function estimateWavDurationSec(bytes: Uint8Array): number {
  if (!isWavBytes(bytes) || bytes.length < 44) {
    // Assume 16-bit / 22050 Hz / mono for raw PCM
    return bytes.length / (22050 * 2);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = view.getUint32(24, true);
  const numChannels = view.getUint16(22, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataSize = view.getUint32(40, true);
  if (sampleRate === 0 || numChannels === 0 || bitsPerSample === 0) return 0;
  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = dataSize / (numChannels * bytesPerSample);
  return totalSamples / sampleRate;
}

/**
 * Check whether a WAV/PCM buffer has meaningful audio signal
 * (RMS above a noise floor threshold).
 */
export function isAudioNonBlank(
  bytes: Uint8Array,
  noiseFloor = 0.005,
): boolean {
  if (bytes.length < 10) return false;
  const pcm = isWavBytes(bytes) ? stripWavHeader(bytes) : bytes;
  if (pcm.length < 4) return false;

  // Interpret as 16-bit signed samples (little-endian)
  let sumSq = 0;
  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount === 0) return false;

  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < sampleCount; i++) {
    const sample = view.getInt16(i * 2, true) / 32768.0;
    sumSq += sample * sample;
  }
  const rms = Math.sqrt(sumSq / sampleCount);
  return rms > noiseFloor;
}

/**
 * The audio bus accumulates all published chunks and can flush
 * them to disk in structured form.
 */
export class AudioBus {
  private readonly chunks: AudioChunk[] = [];

  /** Publish a chunk of TTS audio from a named speaker. */
  publish(turnIdx: number, speaker: string, bytes: Uint8Array): void {
    this.chunks.push({
      turnIdx,
      speaker,
      bytes,
      publishedAt: new Date().toISOString(),
    });
  }

  /** All chunks in publish order. */
  getAllChunks(): readonly AudioChunk[] {
    return this.chunks;
  }

  /** Chunks for a specific speaker. */
  getSpeakerChunks(speaker: string): AudioChunk[] {
    return this.chunks.filter((c) => c.speaker === speaker);
  }

  /** All distinct speakers seen on the bus. */
  getSpeakers(): string[] {
    return [...new Set(this.chunks.map((c) => c.speaker))];
  }

  /**
   * Flush all audio to disk:
   *   - `turns/<turnIdx>-<speaker>.wav` for each chunk
   *   - `mix.wav` — sequential concatenation of all chunks
   */
  flush(outputDir: string): { turnFiles: string[]; mixFile: string } {
    mkdirSync(join(outputDir, "turns"), { recursive: true });

    const turnFiles: string[] = [];

    for (const chunk of this.chunks) {
      const filename = `${String(chunk.turnIdx).padStart(3, "0")}-${chunk.speaker}.wav`;
      const filePath = join(outputDir, "turns", filename);
      const wavBytes = ensureWav(chunk.bytes);
      writeFileSync(filePath, wavBytes);
      turnFiles.push(filePath);
    }

    // Mix = sequential concatenation
    const allBuffers = this.chunks.map((c) => c.bytes);
    const mixWav = concatenateWavBuffers(allBuffers);
    const mixFile = join(outputDir, "mix.wav");
    writeFileSync(mixFile, mixWav);

    return { turnFiles, mixFile };
  }

  /** Compute stats about the collected audio. */
  stats(): AudioBusStats {
    const speakerChunks: Record<string, number> = {};
    const speakerBytes: Record<string, number> = {};
    let totalBytes = 0;

    for (const chunk of this.chunks) {
      speakerChunks[chunk.speaker] = (speakerChunks[chunk.speaker] ?? 0) + 1;
      speakerBytes[chunk.speaker] =
        (speakerBytes[chunk.speaker] ?? 0) + chunk.bytes.length;
      totalBytes += chunk.bytes.length;
    }

    // Estimate duration from all PCM bytes assuming 16-bit/22050Hz/mono
    const totalPcmBytes = this.chunks.reduce((acc, c) => {
      const pcm = isWavBytes(c.bytes) ? stripWavHeader(c.bytes) : c.bytes;
      return acc + pcm.length;
    }, 0);
    const durationEstimateSec = totalPcmBytes / (22050 * 2);

    return {
      totalChunks: this.chunks.length,
      totalBytes,
      speakerChunks,
      speakerBytes,
      durationEstimateSec,
    };
  }
}
