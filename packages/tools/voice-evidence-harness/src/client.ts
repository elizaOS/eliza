/**
 * Harness voice-session client. Speaks the §7 contract against the reference
 * server: mints (locally, via the server handle), opens WS, sends `hello`,
 * streams the fixture PCM as 80 ms / 2560-byte binary frames, records every
 * s2c control/audio event, collects the downlink PCM into a playable WAV, and
 * (for barge-in) fires `barge_in` at a controlled moment then asserts silence.
 *
 * This is the "client side" of the both-side evidence the DoD requires.
 */

import { DEEPGRAM_FLUX_CHUNK_BYTES } from "@harness-adapters/deepgram-flux.ts";
import type { Evidence } from "./evidence.ts";
import { frameFixedChunks } from "./wav.ts";

export interface ClientRunOptions {
  wsUrl: string;
  token: string;
  uplinkPcm: Uint8Array; // linear16 mono 16k body
  evidence: Evidence;
  /** if set, send barge_in this many ms after the first downlink audio frame */
  bargeInAfterFirstAudioMs?: number;
  /** cap the run so error paths don't hang */
  maxRunMs?: number;
}

export interface ClientRunResult {
  downlinkPcm: Uint8Array;
  downlinkFrameCount: number;
  postBargeInFrameCount: number;
  sawReady: boolean;
  sawSttFinal: boolean;
  sawSpeakingStart: boolean;
  sawInterrupted: boolean;
  errors: Array<{ code: string; retryable: boolean }>;
  bargeInSentMonoMs: number | null;
  firstSilenceAfterBargeInMonoMs: number | null;
}

interface HarnessWebSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  addEventListener(type: "error" | "close", listener: () => void): void;
}

function isHarnessWebSocket(value: unknown): value is HarnessWebSocket {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "binaryType") === "string" &&
    typeof Reflect.get(value, "readyState") === "number" &&
    typeof Reflect.get(value, "send") === "function" &&
    typeof Reflect.get(value, "close") === "function" &&
    typeof Reflect.get(value, "addEventListener") === "function"
  );
}

function openHarnessWebSocket(url: string): HarnessWebSocket {
  const ctor: unknown = globalThis.WebSocket;
  if (typeof ctor !== "function") {
    throw new Error("WebSocket is unavailable in this runtime");
  }
  const socket: unknown = Reflect.construct(ctor, [url]);
  if (!isHarnessWebSocket(socket)) {
    throw new Error(
      "WebSocket runtime does not expose the required client API",
    );
  }
  return socket;
}

export async function runClient(
  opts: ClientRunOptions,
): Promise<ClientRunResult> {
  const { evidence: ev } = opts;
  const ws = openHarnessWebSocket(opts.wsUrl);
  ws.binaryType = "arraybuffer";

  const downlinkChunks: Uint8Array[] = [];
  const result: ClientRunResult = {
    downlinkPcm: new Uint8Array(0),
    downlinkFrameCount: 0,
    postBargeInFrameCount: 0,
    sawReady: false,
    sawSttFinal: false,
    sawSpeakingStart: false,
    sawInterrupted: false,
    errors: [],
    bargeInSentMonoMs: null,
    firstSilenceAfterBargeInMonoMs: null,
  };

  let bargeInSent = false;
  let lastFrameMonoMs: number | null = null;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const maxRunMs = opts.maxRunMs ?? 45_000;
  const guard = setTimeout(() => {
    ev.log("client", "warn", "max run time reached, closing");
    finish();
  }, maxRunMs);

  function finish() {
    clearTimeout(guard);
    try {
      ws.close();
    } catch (ignoredError) {
      void ignoredError;
      /* noop */
    }
    resolveDone();
  }

  ws.addEventListener("open", async () => {
    ev.log("client", "info", "ws open");
    const hello = {
      t: "hello",
      token: opts.token,
      protocol: 1,
      uplinkCodec: "pcm16",
      downlinkCodec: "pcm16",
      sampleRate: 16000,
    };
    ev.wsEvent("c2s", "json", hello);
    ws.send(JSON.stringify(hello));
    ev.mark("ws_hello");
  });

  ws.addEventListener("message", async (event: MessageEvent) => {
    const data = (event as MessageEvent).data;
    // binary downlink audio
    if (data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(data);
      const monoMs = performance.now() - ev.startMono;
      if (result.sawInterrupted) {
        result.postBargeInFrameCount++;
        ev.log(
          "client",
          "error",
          "downlink frame AFTER interrupt (should be zero)",
          {
            byteLength: bytes.byteLength,
          },
        );
      }
      downlinkChunks.push(bytes);
      result.downlinkFrameCount++;
      lastFrameMonoMs = monoMs;
      ev.wsEvent("s2c", "binary", {
        kind: "audio_frame",
        byteLength: bytes.byteLength,
        frameNo: result.downlinkFrameCount,
      });
      if (result.downlinkFrameCount === 1) {
        ev.mark("tts_first_frame");
        // schedule barge-in relative to first audio if configured
        if (opts.bargeInAfterFirstAudioMs !== undefined && !bargeInSent) {
          setTimeout(() => sendBargeIn(), opts.bargeInAfterFirstAudioMs);
        }
      }
      return;
    }
    // JSON control
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(data));
    } catch (ignoredError) {
      void ignoredError;
      ev.log("client", "warn", "unparseable control frame");
      return;
    }
    ev.wsEvent("s2c", "json", msg);
    const t = msg.t as string;
    switch (t) {
      case "ready":
        result.sawReady = true;
        ev.mark("ready");
        ev.log("client", "info", "ready", { sessionId: msg.sessionId });
        await pumpUplink();
        break;
      case "stt_partial":
        ev.mark("stt_first_partial");
        ev.log("client", "info", "stt_partial", { text: msg.text });
        break;
      case "stt_final":
        result.sawSttFinal = true;
        ev.mark("stt_final");
        ev.log("client", "info", "stt_final", { text: msg.text });
        break;
      case "llm_first_text":
        ev.mark("llm_first_text");
        break;
      case "speaking_start":
        result.sawSpeakingStart = true;
        ev.log("client", "info", "speaking_start");
        break;
      case "speaking_end":
        ev.mark("tts_complete");
        ev.log("client", "info", "speaking_end");
        // baseline turn done
        if (!opts.bargeInAfterFirstAudioMs) setTimeout(finish, 300);
        break;
      case "interrupted":
        result.sawInterrupted = true;
        result.firstSilenceAfterBargeInMonoMs =
          performance.now() - ev.startMono;
        ev.mark("interrupt_to_silence");
        ev.log("client", "info", "interrupted", { reason: msg.reason });
        // give a short window to catch any (illegal) trailing frames, then finish
        setTimeout(finish, 800);
        break;
      case "error":
        result.errors.push({
          code: String(msg.code),
          retryable: Boolean(msg.retryable),
        });
        ev.log("client", "error", "server error event", {
          code: msg.code,
          retryable: msg.retryable,
        });
        // error-path scenario: end shortly after the error is surfaced
        setTimeout(finish, 500);
        break;
    }
  });

  ws.addEventListener("error", () => {
    ev.log("client", "error", "ws transport error");
  });
  ws.addEventListener("close", () => {
    ev.log("client", "info", "ws close");
    finish();
  });

  async function pumpUplink() {
    const { chunks, paddedBytes } = frameFixedChunks(
      opts.uplinkPcm,
      DEEPGRAM_FLUX_CHUNK_BYTES,
    );
    ev.log("client", "info", "streaming uplink", {
      chunks: chunks.length,
      paddedTailBytes: paddedBytes,
    });
    // Realtime pacing: each 2560-byte chunk is exactly 80 ms of 16 kHz linear16
    // audio. Pacing at ~50 ms/chunk (1.6x realtime) keeps Flux's semantic turn
    // detector honest (it needs a plausible audio timeline to fire end-of-turn)
    // while keeping the run short/cheap.
    for (const chunk of chunks) {
      if (ws.readyState !== 1) break;
      ws.send(chunk);
      ev.wsEvent("c2s", "binary", {
        kind: "audio_chunk",
        byteLength: chunk.byteLength,
      });
      await sleep(50);
    }
    // Flux's SEMANTIC turn detector fires end-of-turn on end-of-speech (trailing
    // silence). Synthetic fixtures have no trailing silence, so we append ~1.2 s
    // of real linear16 silence frames to let Flux detect the turn boundary
    // naturally (this is what a real mic stream does between utterances).
    const silence = new Uint8Array(DEEPGRAM_FLUX_CHUNK_BYTES); // all-zero = digital silence
    for (let i = 0; i < 15; i++) {
      if (ws.readyState !== 1) break;
      ws.send(silence);
      ev.wsEvent("c2s", "binary", {
        kind: "silence_chunk",
        byteLength: silence.byteLength,
      });
      await sleep(50);
    }
    // signal end of audio so Flux flushes/finalizes the turn (CloseStream)
    if (ws.readyState === 1) {
      const end = { t: "end_audio" };
      ev.wsEvent("c2s", "json", end);
      ws.send(JSON.stringify(end));
    }
  }

  function sendBargeIn() {
    if (bargeInSent || ws.readyState !== 1) return;
    bargeInSent = true;
    result.bargeInSentMonoMs = performance.now() - ev.startMono;
    ev.mark("interrupt_requested");
    const b = { t: "barge_in" };
    ev.wsEvent("c2s", "json", b);
    ws.send(JSON.stringify(b));
    ev.log("client", "info", "barge_in sent");
  }

  await done;
  result.downlinkPcm = concat(downlinkChunks);
  void lastFrameMonoMs;
  return result;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
