import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import type { XRAudioHeader } from "../protocol/xr.ts";

// Prepend a RIFF/WAV header so Whisper can decode raw Float32 PCM.
function pcmF32ToWav(pcmData: Buffer, sampleRate: number): Buffer {
  const channels = 1; // ScriptProcessorNode fallback is always mono
  const dataSize = pcmData.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // IEEE_FLOAT
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 4, 28);
  header.writeUInt16LE(channels * 4, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmData]);
}

// Accumulate up to FLUSH_AFTER_MS of audio then transcribe.
// Also flush if no chunk arrives within SILENCE_GAP_MS (end-of-utterance).
const FLUSH_AFTER_MS = 2000;
const SILENCE_GAP_MS = 1500;

export interface PendingTranscription {
  chunks: Buffer[];
  firstTs: number;
  lastTs: number;
  encoding: XRAudioHeader["encoding"];
  sampleRate: number;
  silenceTimer?: ReturnType<typeof setTimeout>;
}

export class AudioPipeline {
  private pending = new Map<string, PendingTranscription>();

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly onTranscript: (
      connectionId: string,
      text: string,
    ) => Promise<void>,
  ) {}

  push(connectionId: string, header: XRAudioHeader, chunk: Buffer): void {
    let state = this.pending.get(connectionId);
    if (!state) {
      state = {
        chunks: [],
        firstTs: header.ts,
        lastTs: header.ts,
        encoding: header.encoding,
        sampleRate: header.sampleRate,
      };
      this.pending.set(connectionId, state);
    }

    state.chunks.push(chunk);
    state.lastTs = header.ts;

    // Reset silence timer on each incoming chunk
    if (state.silenceTimer) clearTimeout(state.silenceTimer);
    state.silenceTimer = setTimeout(
      () => void this.flush(connectionId),
      SILENCE_GAP_MS,
    );

    // Also flush if we've accumulated enough audio
    if (state.lastTs - state.firstTs >= FLUSH_AFTER_MS) {
      void this.flush(connectionId);
    }
  }

  async flush(connectionId: string): Promise<void> {
    const state = this.pending.get(connectionId);
    if (!state || state.chunks.length === 0) return;

    if (state.silenceTimer) {
      clearTimeout(state.silenceTimer);
      state.silenceTimer = undefined;
    }
    this.pending.delete(connectionId);

    const combined = Buffer.concat(state.chunks);
    if (combined.length < 512) return; // too small to be real speech

    // pcm-f32 is raw Float32 samples (mono, from ScriptProcessorNode fallback).
    // Whisper expects a valid audio container — wrap with a WAV header.
    const audioBuffer =
      state.encoding === "pcm-f32"
        ? pcmF32ToWav(combined, state.sampleRate)
        : combined;

    try {
      const transcript = await this.runtime.useModel(
        ModelType.TRANSCRIPTION,
        audioBuffer,
      );
      const text = typeof transcript === "string" ? transcript.trim() : "";
      if (text.length > 0) {
        await this.onTranscript(connectionId, text);
      }
    } catch (err) {
      // log but don't crash the pipeline
      console.error("[plugin-facewear/xr] transcription error:", err);
    }
  }

  clear(connectionId: string): void {
    const state = this.pending.get(connectionId);
    if (state?.silenceTimer) clearTimeout(state.silenceTimer);
    this.pending.delete(connectionId);
  }
}
