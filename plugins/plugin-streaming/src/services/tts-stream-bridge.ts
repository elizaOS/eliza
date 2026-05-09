/**
 * TTS Stream Bridge — generates TTS audio server-side and pipes PCM data
 * into FFmpeg's audio track for RTMP streaming.
 *
 * Uses pipe:3 (a 4th stdio fd) as the audio input to FFmpeg. Writes PCM
 * silence when idle and decoded TTS audio when speaking. This avoids FIFO
 * complexity and works cross-platform.
 *
 * @module services/tts-stream-bridge
 */

import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { logger } from "@elizaos/core";
import type { TtsConfig, TtsProvider } from "@elizaos/shared";
import { sanitizeSpeechText } from "@elizaos/shared";

const TAG = "[TtsStreamBridge]";

// PCM format: signed 16-bit little-endian, 24 kHz, mono
const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const CHUNK_MS = 50;
/** Bytes per tick: 24000 * 2 * 1 * 50/1000 = 2400 */
const CHUNK_BYTES =
  (SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_MS) / 1000;

const ELEVENLABS_TIMEOUT_MS = 20_000;
const OPENAI_TIMEOUT_MS = 20_000;

/** Resolved TTS configuration for a speak() call. */
export interface ResolvedTtsConfig {
  provider: TtsProvider;
  elevenlabs?: {
    apiKey: string;
    voiceId: string;
    modelId: string;
    voiceSettings?: Record<string, unknown>;
  };
  openai?: {
    apiKey: string;
    model: string;
    voice: string;
  };
  edge?: {
    voice: string;
  };
}

/** Public interface for the TTS stream bridge. */
export interface ITtsStreamBridge {
  attach(stream: Writable): void;
  detach(): void;
  isAttached(): boolean;
  isSpeaking(): boolean;
  speak(text: string, config: ResolvedTtsConfig): Promise<boolean>;
}

class TtsStreamBridge implements ITtsStreamBridge {
  private writeStream: Writable | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private pcmQueue: Buffer[] = [];
  private _speaking = false;
  private silenceChunk: Buffer;

  constructor() {
    // Pre-allocate a silence chunk (all zeros = silence in s16le)
    this.silenceChunk = Buffer.alloc(CHUNK_BYTES, 0);
  }

  /** Attach the bridge to an FFmpeg stdio pipe (pipe:3). */
  attach(stream: Writable): void {
    this.detach();
    this.writeStream = stream;
    stream.on("error", (err) => {
      logger.warn(`${TAG} Write stream error: ${err.message}`);
    });
    // Start the tick loop — writes PCM chunks every CHUNK_MS
    this.tickTimer = setInterval(() => this.tick(), CHUNK_MS);
    logger.info(`${TAG} Attached to FFmpeg audio pipe`);
  }

  /** Detach from FFmpeg — stops tick loop and clears queue. */
  detach(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.writeStream = null;
    this.pcmQueue = [];
    this._speaking = false;
  }

  /** Whether the bridge is currently attached to an FFmpeg process. */
  isAttached(): boolean {
    return this.writeStream !== null;
  }

  /** Whether TTS audio is currently being played. */
  isSpeaking(): boolean {
    return this._speaking;
  }

  /**
   * Generate TTS for the given text and queue PCM audio for playback.
   * Non-blocking — queues audio and returns immediately after generation.
   */
  async speak(text: string, config: ResolvedTtsConfig): Promise<boolean> {
    if (!this.writeStream) {
      logger.warn(`${TAG} Cannot speak — not attached to FFmpeg`);
      return false;
    }

    const speakableText = sanitizeSpeechText(text);
    if (!speakableText) return false;

    try {
      logger.info(
        `${TAG} Generating TTS (${config.provider}, ${speakableText.length} chars)`,
      );
      const mp3 = await this.generateTts(speakableText, config);
      if (!mp3 || mp3.length === 0) {
        logger.warn(`${TAG} TTS returned empty audio`);
        return false;
      }

      const pcm = await this.decodeMp3ToPcm(mp3);
      if (!pcm || pcm.length === 0) {
        logger.warn(`${TAG} PCM decode returned empty buffer`);
        return false;
      }

      // Split PCM into CHUNK_BYTES-sized buffers for smooth playback
      const chunks: Buffer[] = [];
      for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
        const end = Math.min(i + CHUNK_BYTES, pcm.length);
        const chunk = Buffer.alloc(CHUNK_BYTES, 0);
        pcm.copy(chunk, 0, i, end);
        chunks.push(chunk);
      }

      this.pcmQueue.push(...chunks);
      this._speaking = true;
      logger.info(
        `${TAG} Queued ${chunks.length} PCM chunks (${(pcm.length / SAMPLE_RATE / BYTES_PER_SAMPLE).toFixed(1)}s)`,
      );
      return true;
    } catch (err) {
      logger.error(`${TAG} TTS generation failed: ${String(err)}`);
      return false;
    }
  }

  /** Called every CHUNK_MS — writes next PCM chunk (TTS or silence) to FFmpeg. */
  private tick(): void {
    if (!this.writeStream) return;

    let chunk: Buffer;
    if (this.pcmQueue.length > 0) {
      chunk = this.pcmQueue.shift() as Buffer;
      if (this.pcmQueue.length === 0) {
        this._speaking = false;
        logger.info(`${TAG} Finished speaking`);
      }
    } else {
      chunk = this.silenceChunk;
    }

    try {
      this.writeStream.write(chunk);
    } catch {
      // Stream may have been closed — detach will handle cleanup
    }
  }

  // ── TTS generation ─────────────────────────────────────────────────────

  private async generateTts(
    text: string,
    config: ResolvedTtsConfig,
  ): Promise<Buffer> {
    switch (config.provider) {
      case "elevenlabs":
        return this.generateElevenlabs(text, config);
      case "openai":
        return this.generateOpenai(text, config);
      case "edge":
        return this.generateEdge(text, config);
      default:
        throw new Error(`Unknown TTS provider: ${config.provider}`);
    }
  }

  private async generateElevenlabs(
    text: string,
    config: ResolvedTtsConfig,
  ): Promise<Buffer> {
    const el = config.elevenlabs;
    if (!el?.apiKey) throw new Error("ElevenLabs API key not available");

    const voiceId = el.voiceId || "EXAVITQu4vr4xnSDxMaL";
    const modelId = el.modelId || "eleven_flash_v2_5";
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_22050_32`;

    const payload: Record<string, unknown> = {
      text,
      model_id: modelId,
    };
    if (el.voiceSettings && Object.keys(el.voiceSettings).length > 0) {
      payload.voice_settings = el.voiceSettings;
    }

    const resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "xi-api-key": el.apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify(payload),
      },
      ELEVENLABS_TIMEOUT_MS,
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`ElevenLabs ${resp.status}: ${body.slice(0, 200)}`);
    }

    return Buffer.from(await resp.arrayBuffer());
  }

  private async generateOpenai(
    text: string,
    config: ResolvedTtsConfig,
  ): Promise<Buffer> {
    const oai = config.openai;
    if (!oai?.apiKey) throw new Error("OpenAI API key not available");

    const model = oai.model || "tts-1";
    const voice = oai.voice || "alloy";

    const resp = await fetchWithTimeout(
      "https://api.openai.com/v1/audio/speech",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${oai.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: text,
          voice,
          response_format: "mp3",
        }),
      },
      OPENAI_TIMEOUT_MS,
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`OpenAI TTS ${resp.status}: ${body.slice(0, 200)}`);
    }

    return Buffer.from(await resp.arrayBuffer());
  }

  private async generateEdge(
    text: string,
    config: ResolvedTtsConfig,
  ): Promise<Buffer> {
    // Edge TTS requires node-edge-tts package — optional dependency
    try {
      // Use a variable so Vite's static analysis doesn't try to resolve this optional dep
      const edgeTtsModule = "node-edge-tts";
      const { MsEdgeTTS } = await import(edgeTtsModule);
      const tts = new MsEdgeTTS();
      const voice = config.edge?.voice || "en-US-AriaNeural";
      await tts.setMetadata(voice, "audio-24khz-48kbitrate-mono-mp3");
      const readable = tts.toStream(text);

      return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        readable.on("data", (chunk: Buffer) => chunks.push(chunk));
        readable.on("end", () => resolve(Buffer.concat(chunks)));
        readable.on("error", reject);
      });
    } catch (err) {
      throw new Error(
        `Edge TTS failed (node-edge-tts may not be installed): ${String(err)}`,
      );
    }
  }

  // ── MP3 → PCM decode ──────────────────────────────────────────────────

  /** Decode MP3 audio to raw s16le PCM using an FFmpeg subprocess. */
  private decodeMp3ToPcm(mp3: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const proc = spawn(
        "ffmpeg",
        [
          "-i",
          "pipe:0",
          "-f",
          "s16le",
          "-ar",
          String(SAMPLE_RATE),
          "-ac",
          String(CHANNELS),
          "pipe:1",
        ],
        { stdio: ["pipe", "pipe", "ignore"] },
      );

      const chunks: Buffer[] = [];
      proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      proc.on("close", (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(new Error(`FFmpeg decode exited with code ${code}`));
        }
      });
      proc.on("error", reject);
      proc.stdin?.write(mp3);
      proc.stdin?.end();
    });
  }
}

// ── Helper ────────────────────────────────────────────────────────────────

function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

// ── Config resolution ─────────────────────────────────────────────────────

/** Helper to check if a string looks like a redacted secret placeholder. */
function isRedactedSecret(val: string): boolean {
  return /^\*+$/.test(val) || val === "REDACTED" || val === "[REDACTED]";
}

/**
 * Resolve TTS configuration from eliza config, finding the best available
 * provider with valid API keys.
 */
export function resolveTtsConfig(
  ttsConfig: TtsConfig | undefined,
): ResolvedTtsConfig | null {
  if (!ttsConfig) return null;

  const preferredProvider = ttsConfig.provider || "elevenlabs";

  // Try providers in preference order: configured → elevenlabs → openai → edge
  const providers: TtsProvider[] = [preferredProvider];
  if (!providers.includes("elevenlabs")) providers.push("elevenlabs");
  if (!providers.includes("openai")) providers.push("openai");
  if (!providers.includes("edge")) providers.push("edge");

  for (const provider of providers) {
    switch (provider) {
      case "elevenlabs": {
        const el = ttsConfig.elevenlabs;
        const apiKey = resolveKey(el?.apiKey, "ELEVENLABS_API_KEY");
        if (apiKey) {
          return {
            provider: "elevenlabs",
            elevenlabs: {
              apiKey,
              voiceId: el?.voiceId || "EXAVITQu4vr4xnSDxMaL",
              modelId: el?.modelId || "eleven_flash_v2_5",
              voiceSettings: el?.voiceSettings
                ? { ...el.voiceSettings }
                : undefined,
            },
          };
        }
        break;
      }
      case "openai": {
        const oai = ttsConfig.openai;
        const apiKey = resolveKey(oai?.apiKey, "OPENAI_API_KEY");
        if (apiKey) {
          return {
            provider: "openai",
            openai: {
              apiKey,
              model: oai?.model || "tts-1",
              voice: oai?.voice || "alloy",
            },
          };
        }
        break;
      }
      case "edge": {
        // Edge TTS always works (no API key needed)
        return {
          provider: "edge",
          edge: {
            voice: ttsConfig.edge?.voice || "en-US-AriaNeural",
          },
        };
      }
    }
  }

  return null;
}

function resolveKey(
  configKey: string | undefined,
  envVar: string,
): string | null {
  const ck = configKey?.trim();
  if (ck && !isRedactedSecret(ck)) return ck;
  const ev = process.env[envVar]?.trim();
  if (ev && !isRedactedSecret(ev)) return ev;

  const explicitCloudTts = process.env.ELIZAOS_CLOUD_USE_TTS === "true";
  const legacyCloudTts =
    process.env.ELIZAOS_CLOUD_USE_TTS === undefined &&
    process.env.ELIZAOS_CLOUD_ENABLED === "true" &&
    process.env.ELIZA_CLOUD_TTS_DISABLED !== "true";
  if (explicitCloudTts || legacyCloudTts) {
    const cloudKey = process.env.ELIZAOS_CLOUD_API_KEY?.trim();
    if (cloudKey && !isRedactedSecret(cloudKey)) {
      return cloudKey;
    }
  }

  return null;
}

/**
 * Get a summary of available TTS providers and their status.
 */
export function getTtsProviderStatus(ttsConfig: TtsConfig | undefined): {
  configuredProvider: string | null;
  hasApiKey: boolean;
  resolvedProvider: string | null;
} {
  const resolved = resolveTtsConfig(ttsConfig);
  return {
    configuredProvider: ttsConfig?.provider || null,
    hasApiKey: resolved ? resolved.provider !== "edge" : false,
    resolvedProvider: resolved?.provider || null,
  };
}

// Module singleton
export const ttsStreamBridge = new TtsStreamBridge();
