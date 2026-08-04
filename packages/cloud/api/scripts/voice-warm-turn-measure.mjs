/**
 * Measures realtime voice warm-turn latency against an already-authorized
 * staging WebSocket without minting credentials or embedding provider keys.
 *
 * Operators provide a scoped voice-session token and a speech PCM fixture. The
 * script records client-observed `stt_final` -> `llm_first_text` -> first binary
 * audio timings and prints trace ids that line up with the existing
 * `[shared-runtime REST] stream pre-header timing` Worker logs.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const DEFAULT_TURNS = 20;
const DEFAULT_CHUNK_BYTES = 3200;
const DEFAULT_CHUNK_DELAY_MS = 100;
const DEFAULT_TURN_TIMEOUT_MS = 30_000;

function usage() {
  return `Usage: bun packages/cloud/api/scripts/voice-warm-turn-measure.mjs --ws-url <wss://.../api/v1/voice/session/ws?sessionId=...> --token <voice-session-jwt> --pcm <speech.pcm> [--turns 20] [--warmup 1]\n\nNo credentials are read from disk. This harness does not mint sessions, fund accounts, or bypass billing; run only against an already-authorized staging session whose spend has been separately approved.`;
}

function parseArgs(argv) {
  const args = {
    wsUrl: process.env.VOICE_STAGING_WS_URL ?? "",
    token: process.env.VOICE_SESSION_TOKEN ?? "",
    pcm: process.env.VOICE_PCM_FIXTURE ?? "",
    turns: Number(process.env.VOICE_MEASURE_TURNS ?? DEFAULT_TURNS),
    warmup: Number(process.env.VOICE_MEASURE_WARMUP ?? 1),
    chunkBytes: Number(process.env.VOICE_MEASURE_CHUNK_BYTES ?? DEFAULT_CHUNK_BYTES),
    chunkDelayMs: Number(process.env.VOICE_MEASURE_CHUNK_DELAY_MS ?? DEFAULT_CHUNK_DELAY_MS),
    turnTimeoutMs: Number(process.env.VOICE_MEASURE_TIMEOUT_MS ?? DEFAULT_TURN_TIMEOUT_MS),
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--ws-url":
        args.wsUrl = value ?? "";
        index += 1;
        break;
      case "--token":
        args.token = value ?? "";
        index += 1;
        break;
      case "--pcm":
        args.pcm = value ?? "";
        index += 1;
        break;
      case "--turns":
        args.turns = Number(value);
        index += 1;
        break;
      case "--warmup":
        args.warmup = Number(value);
        index += 1;
        break;
      case "--chunk-bytes":
        args.chunkBytes = Number(value);
        index += 1;
        break;
      case "--chunk-delay-ms":
        args.chunkDelayMs = Number(value);
        index += 1;
        break;
      case "--turn-timeout-ms":
        args.turnTimeoutMs = Number(value);
        index += 1;
        break;
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!args.wsUrl || !args.token || !args.pcm) {
    throw new Error("--ws-url, --token, and --pcm are required");
  }
  if (!Number.isInteger(args.turns) || args.turns < 20) {
    throw new Error("--turns must be an integer >= 20");
  }
  if (!Number.isInteger(args.warmup) || args.warmup < 0) {
    throw new Error("--warmup must be an integer >= 0");
  }
  if (!Number.isInteger(args.chunkBytes) || args.chunkBytes <= 0) {
    throw new Error("--chunk-bytes must be a positive integer");
  }
  if (!Number.isInteger(args.chunkDelayMs) || args.chunkDelayMs < 0) {
    throw new Error("--chunk-delay-ms must be an integer >= 0");
  }
  return args;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function summarize(samples) {
  const round = (value) => Math.round(value * 10) / 10;
  return {
    count: samples.length,
    p50Ms: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
    maxMs: round(Math.max(...samples)),
  };
}

function printHuman(result) {
  process.stdout.write(
    `[voice-warm-turn-measure] ${result.measuredTurns} warm turns against ${result.target}\n`,
  );
  process.stdout.write(`[voice-warm-turn-measure] fixture ${result.fixture}\n`);
  process.stdout.write(
    `[voice-warm-turn-measure] stt_final->llm_first_text p50=${result.summary.sttFinalToLlmFirstText.p50Ms}ms ` +
      `p95=${result.summary.sttFinalToLlmFirstText.p95Ms}ms max=${result.summary.sttFinalToLlmFirstText.maxMs}ms\n`,
  );
  process.stdout.write(
    `[voice-warm-turn-measure] llm_first_text->first_audio p50=${result.summary.llmFirstTextToFirstAudio.p50Ms}ms ` +
      `p95=${result.summary.llmFirstTextToFirstAudio.p95Ms}ms max=${result.summary.llmFirstTextToFirstAudio.maxMs}ms\n`,
  );
  process.stdout.write(
    `[voice-warm-turn-measure] stt_final->first_audio p50=${result.summary.sttFinalToFirstAudio.p50Ms}ms ` +
      `p95=${result.summary.sttFinalToFirstAudio.p95Ms}ms max=${result.summary.sttFinalToFirstAudio.maxMs}ms\n`,
  );
  process.stdout.write("\nturn\ttraceId\tstt->llm\tllm->audio\tstt->audio\n");
  for (const sample of result.samples) {
    process.stdout.write(
      `${sample.turn}\t${sample.traceId}\t${sample.sttFinalToLlmFirstTextMs}\t${sample.llmFirstTextToFirstAudioMs}\t${sample.sttFinalToFirstAudioMs}\n`,
    );
  }
  process.stdout.write(`\n${result.note}\n`);
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket open timed out"));
    }, 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.addEventListener("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function isBinaryMessage(data) {
  return (
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data) ||
    data instanceof Blob
  );
}

function messageText(data) {
  return typeof data === "string" ? data : Buffer.from(data).toString("utf8");
}

function waitForReady(ws, token) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("ready timed out")), 10_000);
    const onMessage = (event) => {
      if (isBinaryMessage(event.data)) return;
      const frame = JSON.parse(messageText(event.data));
      if (frame.t === "ready") {
        clearTimeout(timeout);
        ws.removeEventListener("message", onMessage);
        resolve(frame);
      }
      if (frame.t === "error") {
        clearTimeout(timeout);
        ws.removeEventListener("message", onMessage);
        reject(new Error(`ready failed: ${frame.code}`));
      }
    };
    ws.addEventListener("message", onMessage);
    ws.send(
      JSON.stringify({
        t: "hello",
        token,
        protocol: 1,
        uplinkCodec: "pcm16",
        downlinkCodec: "pcm16",
        sampleRate: 16000,
      }),
    );
  });
}

async function sendPcmTurn(ws, pcm, args) {
  ws.send(
    JSON.stringify({
      t: "audio_meta",
      seq: Date.now(),
      codec: "pcm16",
      sampleRate: 16000,
      channels: 1,
    }),
  );
  for (let offset = 0; offset < pcm.byteLength; offset += args.chunkBytes) {
    ws.send(
      pcm.subarray(offset, Math.min(offset + args.chunkBytes, pcm.byteLength)),
    );
    await delay(args.chunkDelayMs);
  }
  ws.send(JSON.stringify({ t: "end_audio" }));
}

function measureTurn(ws, turnIndex, counted, timeoutMs) {
  const state = {
    turnIndex,
    counted,
    traceId: null,
    sttFinalAt: 0,
    llmFirstTextAt: 0,
    firstAudioAt: 0,
    usageAt: 0,
    text: "",
  };
  return {
    state,
    promise: new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`turn ${turnIndex} timed out`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        ws.removeEventListener("message", onMessage);
      };
      const onMessage = (event) => {
        const now = performance.now();
        if (isBinaryMessage(event.data)) {
          if (state.sttFinalAt && !state.firstAudioAt) state.firstAudioAt = now;
          return;
        }
        const frame = JSON.parse(messageText(event.data));
        if (frame.t === "stt_final" && !state.sttFinalAt) {
          state.sttFinalAt = now;
          state.traceId = frame.traceId ?? null;
          state.text = frame.text ?? "";
        } else if (
          frame.t === "llm_first_text" &&
          state.sttFinalAt &&
          !state.llmFirstTextAt
        ) {
          state.llmFirstTextAt = now;
        } else if (frame.t === "usage" && state.sttFinalAt) {
          if (!state.llmFirstTextAt || !state.firstAudioAt) {
            cleanup();
            reject(
              new Error(
                `turn ${turnIndex} completed before llm_first_text and first audio`,
              ),
            );
            return;
          }
          state.usageAt = now;
          cleanup();
          resolve(state);
        } else if (frame.t === "error" && state.sttFinalAt) {
          cleanup();
          reject(new Error(`turn ${turnIndex} failed: ${frame.code}`));
        }
      };
      ws.addEventListener("message", onMessage);
    }),
  };
}

function normalizeSample(sample) {
  const round = (value) => Math.round(value * 10) / 10;
  return {
    turn: sample.turnIndex,
    traceId: sample.traceId,
    transcript: sample.text,
    sttFinalToLlmFirstTextMs: round(sample.llmFirstTextAt - sample.sttFinalAt),
    llmFirstTextToFirstAudioMs: round(sample.firstAudioAt - sample.llmFirstTextAt),
    sttFinalToFirstAudioMs: round(sample.firstAudioAt - sample.sttFinalAt),
    sttFinalToUsageMs: round(sample.usageAt - sample.sttFinalAt),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pcm = await readFile(args.pcm);
  const ws = await connect(args.wsUrl);
  try {
    const ready = await waitForReady(ws, args.token);
    const samples = [];
    for (let index = 0; index < args.warmup + args.turns; index += 1) {
      const turn = measureTurn(
        ws,
        index + 1,
        index >= args.warmup,
        args.turnTimeoutMs,
      );
      await sendPcmTurn(ws, pcm, args);
      const sample = await turn.promise;
      if (sample.counted) samples.push(normalizeSample(sample));
      await delay(250);
    }
    const result = {
      generatedAt: new Date().toISOString(),
      target: new URL(args.wsUrl).origin,
      fixture: basename(args.pcm),
      warmupTurns: args.warmup,
      measuredTurns: args.turns,
      readyTraceId: ready.traceId ?? null,
      note: "Correlate traceId/conversationId with Worker logs containing `[shared-runtime REST] stream pre-header timing` for bridge pre-header timings.",
      summary: {
        sttFinalToLlmFirstText: summarize(samples.map((sample) => sample.sttFinalToLlmFirstTextMs)),
        llmFirstTextToFirstAudio: summarize(samples.map((sample) => sample.llmFirstTextToFirstAudioMs)),
        sttFinalToFirstAudio: summarize(samples.map((sample) => sample.sttFinalToFirstAudioMs)),
      },
      samples,
    };
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printHuman(result);
    }
  } finally {
    ws.close(1000, "measurement_complete");
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
  process.exit(1);
});
