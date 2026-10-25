/* v8 ignore start -- opt-in network adapters require live provider credentials @preserve */
/**
 * Live provider adapters for Deepgram Flux, Cerebras, and Cartesia Sonic 3.5.
 *
 * The adapters use the public API contracts directly and expose only IDs,
 * lengths, and timings to the benchmark report. Transcript/reply text is
 * returned in memory for chaining and is redacted from artifacts unless the
 * runner is explicitly invoked with `--unsafe-transcripts`.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { firstSpeakablePhrase } from "../speakable.ts";
import type {
  CorpusCase,
  LlmAdapter,
  LlmResult,
  SttAdapter,
  SttResult,
  TtsAdapter,
  TtsResult,
} from "../types.ts";

const DEFAULT_CEREBRAS_MODEL = "gemma-4-31b";
const DEFAULT_CARTESIA_MODEL = "sonic-3.5";
const DEFAULT_CARTESIA_VOICE_ID = "a0e99841-438c-4a64-b679-ae501e7d6091";

interface JsonRecord {
  [key: string]: unknown;
}

type SocketMessage = string | ArrayBuffer | Uint8Array;

interface MinimalWebSocket {
  binaryType: "arraybuffer";
  readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: SocketMessage; error?: unknown }) => void,
    options?: { once?: boolean },
  ): void;
}

interface WebSocketCtor {
  new (
    url: string,
    options?: { headers?: Record<string, string> },
  ): MinimalWebSocket;
}

export function createLiveAdapters(): {
  stt: SttAdapter;
  llm: LlmAdapter;
  tts: TtsAdapter;
} {
  assertEnv("DEEPGRAM_API_KEY");
  assertEnv("CEREBRAS_API_KEY");
  assertEnv("CARTESIA_API_KEY");
  return {
    stt: new DeepgramFluxAdapter(),
    llm: new CerebrasAdapter(),
    tts: new CartesiaAdapter(),
  };
}

class DeepgramFluxAdapter implements SttAdapter {
  readonly name = "deepgram-flux";

  async transcribe(input: {
    traceId: string;
    corpus: CorpusCase;
    signal: AbortSignal;
    audioDir?: string;
  }): Promise<SttResult> {
    const audio = await loadAudio(input.corpus, input.audioDir);
    const url = new URL(
      process.env.DEEPGRAM_FLUX_URL ?? "wss://api.deepgram.com/v2/listen",
    );
    url.searchParams.set(
      "model",
      process.env.DEEPGRAM_FLUX_MODEL ?? "flux-general-en",
    );
    url.searchParams.set("encoding", audio.encoding);
    url.searchParams.set("sample_rate", String(audio.sampleRateHz));
    url.searchParams.set("eager_eot_threshold", "0.5");
    url.searchParams.set("eot_threshold", "0.5");
    url.searchParams.set("eot_timeout_ms", "1000");
    url.searchParams.set("tag", input.traceId);

    const ws = newWebSocket(url.toString(), {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      "X-Eliza-Voice-Trace-Id": input.traceId,
    });
    await waitForOpen(ws, input.signal);

    const start = Date.now();
    let eagerEndAtMs: number | null = null;
    let finalAtMs: number | null = null;
    let transcript = "";
    let requestId: string | undefined;

    const done = new Promise<void>((resolve, reject) => {
      input.signal.addEventListener(
        "abort",
        () => reject(new Error("Deepgram Flux transcription aborted")),
        { once: true },
      );
      ws.addEventListener("message", (event) => {
        const message = parseSocketJson(event.data);
        if (message.type === "TurnInfo") {
          requestId =
            typeof message.request_id === "string"
              ? message.request_id
              : requestId;
          const eventName = String(message.event ?? "");
          if (eventName === "EagerEndOfTurn" && eagerEndAtMs === null) {
            eagerEndAtMs = input.corpus.inputAudioMs + (Date.now() - start);
          }
          if (eventName === "EndOfTurn") {
            transcript =
              typeof message.transcript === "string" ? message.transcript : "";
            finalAtMs = input.corpus.inputAudioMs + (Date.now() - start);
            resolve();
          }
        }
        if (message.type === "Error") {
          reject(
            new Error(
              `Deepgram Flux error: ${String(message.description ?? message.code)}`,
            ),
          );
        }
      });
      ws.addEventListener("error", () =>
        reject(new Error("Deepgram Flux websocket error")),
      );
      ws.addEventListener("close", () => {
        if (finalAtMs === null)
          reject(new Error("Deepgram Flux websocket closed before EndOfTurn"));
      });
    });

    ws.send(audio.bytes);
    ws.send(JSON.stringify({ type: "CloseStream" }));
    await done.finally(() => ws.close(1000, "done"));
    if (finalAtMs === null)
      throw new Error("Deepgram Flux did not return EndOfTurn");
    return {
      transcript,
      transcriptChars: transcript.length,
      eagerEndAtMs: eagerEndAtMs ?? finalAtMs,
      finalAtMs,
      requestId,
    };
  }
}

class CerebrasAdapter implements LlmAdapter {
  readonly name = `cerebras-${DEFAULT_CEREBRAS_MODEL}`;

  async complete(input: {
    traceId: string;
    corpus: CorpusCase;
    transcript: string;
    admissionAtMs: number;
    signal: AbortSignal;
  }): Promise<LlmResult> {
    const url = `${(process.env.CEREBRAS_BASE_URL ?? "https://api.cerebras.ai/v1").replace(/\/+$/, "")}/chat/completions`;
    const started = Date.now();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}`,
        "Content-Type": "application/json",
        "X-Eliza-Voice-Trace-Id": input.traceId,
      },
      body: JSON.stringify({
        model: process.env.CEREBRAS_MODEL ?? DEFAULT_CEREBRAS_MODEL,
        stream: true,
        temperature: 0,
        max_completion_tokens: 96,
        messages: [
          {
            role: "system",
            content:
              "Answer as a concise voice assistant. Return one short, speakable sentence.",
          },
          { role: "user", content: input.transcript },
        ],
      }),
      signal: input.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(
        `Cerebras streaming request failed: HTTP ${response.status}`,
      );
    }
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let replyText = "";
    let firstTokenAtMs: number | null = null;
    const tokens: LlmResult["tokens"] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const parsed = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
          id?: string;
        };
        const token = parsed.choices?.[0]?.delta?.content;
        if (token) {
          const atMs = input.admissionAtMs + (Date.now() - started);
          firstTokenAtMs ??= atMs;
          replyText += token;
          tokens.push({ text: token, atMs });
        }
      }
    }
    if (firstTokenAtMs === null) {
      throw new Error("Cerebras stream completed without text tokens");
    }
    return {
      replyText: replyText.trim(),
      firstTokenAtMs,
      completeAtMs: input.admissionAtMs + (Date.now() - started),
      tokens,
    };
  }
}

class CartesiaAdapter implements TtsAdapter {
  readonly name = `cartesia-${DEFAULT_CARTESIA_MODEL}`;

  async synthesize(input: {
    traceId: string;
    text: string;
    requestAtMs: number;
    signal: AbortSignal;
    onAudioFrame(frame: TtsResult["frames"][number]): boolean;
  }): Promise<TtsResult> {
    const url = new URL(
      process.env.CARTESIA_TTS_WS_URL ?? "wss://api.cartesia.ai/tts/websocket",
    );
    url.searchParams.set(
      "cartesia_version",
      process.env.CARTESIA_VERSION ?? "2025-04-16",
    );
    const ws = newWebSocket(url.toString(), {
      Authorization: `Bearer ${process.env.CARTESIA_API_KEY}`,
      "Cartesia-Version": process.env.CARTESIA_VERSION ?? "2025-04-16",
      "X-Eliza-Voice-Trace-Id": input.traceId,
    });
    await waitForOpen(ws, input.signal);
    const started = Date.now();
    const frames: TtsResult["frames"] = [];
    const contextId = input.traceId;
    let cancelled = false;
    const done = new Promise<void>((resolve, reject) => {
      input.signal.addEventListener(
        "abort",
        () => reject(new Error("Cartesia synthesis aborted")),
        { once: true },
      );
      ws.addEventListener("message", (event) => {
        const message = parseSocketJson(event.data);
        const bytes = audioBytesFromCartesia(message);
        if (bytes > 0) {
          const frame = {
            atMs: input.requestAtMs + (Date.now() - started),
            bytes,
          };
          if (!input.onAudioFrame(frame)) {
            cancelled = true;
            ws.close(1000, "cancelled");
            resolve();
            return;
          }
          frames.push(frame);
        }
        if (message.type === "done" || message.done === true) resolve();
        if (message.type === "error") {
          reject(
            new Error(
              `Cartesia websocket error: ${String(message.error ?? message.message)}`,
            ),
          );
        }
      });
      ws.addEventListener("error", () =>
        reject(new Error("Cartesia websocket error")),
      );
      ws.addEventListener("close", () => resolve());
    });
    ws.send(
      JSON.stringify({
        model_id: process.env.CARTESIA_MODEL ?? DEFAULT_CARTESIA_MODEL,
        transcript: firstSpeakablePhrase(input.text),
        voice: {
          mode: "id",
          id: process.env.CARTESIA_VOICE_ID ?? DEFAULT_CARTESIA_VOICE_ID,
        },
        context_id: contextId,
        output_format: {
          container: "raw",
          encoding: "pcm_s16le",
          sample_rate: 16000,
        },
        continue: false,
      }),
    );
    await done.finally(() => ws.close(1000, "done"));
    if (frames.length === 0)
      throw new Error("Cartesia returned no audio frames");
    return {
      firstAudioAtMs: frames[0].atMs,
      frames,
      cancelled,
      requestId: contextId,
    };
  }
}

function assertEnv(name: string): void {
  if (!process.env[name]?.trim()) {
    throw new Error(`${name} is required for --mode=live`);
  }
}

async function loadAudio(
  corpus: CorpusCase,
  audioDir?: string,
): Promise<{ encoding: "linear16"; sampleRateHz: number; bytes: Uint8Array }> {
  if (corpus.audio) {
    return {
      encoding: corpus.audio.encoding,
      sampleRateHz: corpus.audio.sampleRateHz,
      bytes: Uint8Array.from(Buffer.from(corpus.audio.base64, "base64")),
    };
  }
  if (audioDir) {
    const bytes = await readFile(join(audioDir, `${corpus.id}.pcm`));
    return {
      encoding: "linear16",
      sampleRateHz: 16000,
      bytes: Uint8Array.from(bytes),
    };
  }
  throw new Error(
    `live mode needs audio bytes for ${corpus.id}; provide fixture audio or --audio-dir with ${corpus.id}.pcm`,
  );
}

function newWebSocket(
  url: string,
  headers: Record<string, string>,
): MinimalWebSocket {
  const Ctor = globalThis.WebSocket as unknown as WebSocketCtor | undefined;
  if (!Ctor) throw new Error("WebSocket is unavailable in this runtime");
  const ws = new Ctor(url, { headers });
  ws.binaryType = "arraybuffer";
  return ws;
}

function waitForOpen(ws: MinimalWebSocket, signal: AbortSignal): Promise<void> {
  if (ws.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new Error("websocket open aborted")),
      {
        once: true,
      },
    );
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error("websocket open failed")),
      {
        once: true,
      },
    );
  });
}

function parseSocketJson(data: SocketMessage | undefined): JsonRecord {
  if (typeof data === "string") return JSON.parse(data) as JsonRecord;
  if (data instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(data)) as JsonRecord;
  }
  if (data instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(data)) as JsonRecord;
  }
  return {};
}

function audioBytesFromCartesia(message: JsonRecord): number {
  const rawAudio = message.data ?? message.audio;
  if (typeof rawAudio === "string")
    return Buffer.byteLength(rawAudio, "base64");
  if (rawAudio instanceof Uint8Array) return rawAudio.byteLength;
  if (rawAudio instanceof ArrayBuffer) return rawAudio.byteLength;
  return 0;
}
/* v8 ignore stop -- @preserve */
