/**
 * Measures realtime voice warm-turn latency either against an already-
 * authorized staging WebSocket or the loopback development gateway. Local mode
 * mints scoped sessions in memory and rotates to a fresh conversation before
 * repeated-fixture policy or token expiry can bias the matrix; it never reads
 * a provider credential.
 *
 * The script records client-observed `stt_final` -> `llm_first_text` -> first
 * binary audio timings and prints trace ids that line up with the existing
 * `[shared-runtime REST] stream pre-header timing` Worker logs.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const DEFAULT_TURNS = 20;
const DEFAULT_CHUNK_BYTES = 3200;
const DEFAULT_CHUNK_DELAY_MS = 100;
const DEFAULT_TURN_TIMEOUT_MS = 30_000;
const DEFAULT_LOCAL_TURNS_PER_SESSION = 8;

function usage() {
  return `Usage:\n  staging: bun packages/cloud/api/scripts/voice-warm-turn-measure.mjs --ws-url <wss://.../api/v1/voice/session/ws?sessionId=...> --token <voice-session-jwt> --pcm <speech.pcm> [--turns 20] [--warmup 1]\n  local:   bun packages/cloud/api/scripts/voice-warm-turn-measure.mjs --local-origin <http://127.0.0.1:32338> --runtime-origin <http://127.0.0.1:2138> --pcm <speech.pcm> [--turns 20] [--warmup 1] [--local-turns-per-session 8]\n\nStaging mode never reads or mints credentials. Local mode rotates short-lived loopback sessions and fresh local conversations before repeated-fixture policy or the 120-second token ceiling can bias the latency sample.`;
}

export function parseArgs(argv, env = process.env) {
  const args = {
    wsUrl: env.VOICE_STAGING_WS_URL ?? "",
    token: env.VOICE_SESSION_TOKEN ?? "",
    localOrigin: env.VOICE_LOCAL_GATEWAY_ORIGIN ?? "",
    runtimeOrigin: env.VOICE_LOCAL_RUNTIME_ORIGIN ?? "http://127.0.0.1:2138",
    pcm: env.VOICE_PCM_FIXTURE ?? "",
    turns: Number(env.VOICE_MEASURE_TURNS ?? DEFAULT_TURNS),
    warmup: Number(env.VOICE_MEASURE_WARMUP ?? 1),
    chunkBytes: Number(env.VOICE_MEASURE_CHUNK_BYTES ?? DEFAULT_CHUNK_BYTES),
    chunkDelayMs: Number(
      env.VOICE_MEASURE_CHUNK_DELAY_MS ?? DEFAULT_CHUNK_DELAY_MS,
    ),
    turnTimeoutMs: Number(
      env.VOICE_MEASURE_TIMEOUT_MS ?? DEFAULT_TURN_TIMEOUT_MS,
    ),
    localTurnsPerSession: Number(
      env.VOICE_LOCAL_TURNS_PER_SESSION ?? DEFAULT_LOCAL_TURNS_PER_SESSION,
    ),
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
      case "--local-origin":
        args.localOrigin = value ?? "";
        index += 1;
        break;
      case "--runtime-origin":
        args.runtimeOrigin = value ?? "";
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
      case "--local-turns-per-session":
        args.localTurnsPerSession = Number(value);
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
  if (!args.pcm) throw new Error("--pcm is required");
  if (args.localOrigin) {
    for (const [flag, raw] of [
      ["--local-origin", args.localOrigin],
      ["--runtime-origin", args.runtimeOrigin],
    ]) {
      let target;
      try {
        target = new URL(raw);
      } catch {
        throw new Error(`${flag} must be a valid http:// or https:// URL`);
      }
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new Error(`${flag} must be a valid http:// or https:// URL`);
      }
    }
  } else {
    if (!args.wsUrl || !args.token) {
      throw new Error("--ws-url and --token are required in staging mode");
    }
    let target;
    try {
      target = new URL(args.wsUrl);
    } catch {
      throw new Error("--ws-url must be a valid ws:// or wss:// URL");
    }
    if (target.protocol !== "ws:" && target.protocol !== "wss:") {
      throw new Error("--ws-url must be a valid ws:// or wss:// URL");
    }
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
  if (!Number.isInteger(args.turnTimeoutMs) || args.turnTimeoutMs <= 0) {
    throw new Error("--turn-timeout-ms must be a positive integer");
  }
  if (
    !Number.isInteger(args.localTurnsPerSession) ||
    args.localTurnsPerSession < 1 ||
    args.localTurnsPerSession > 10
  ) {
    throw new Error(
      "--local-turns-per-session must be an integer from 1 to 10",
    );
  }
  return args;
}

async function readJsonResponse(response, label) {
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${label} returned invalid JSON`, { cause: error });
  }
}

/**
 * Mints one real loopback session against a fresh local conversation. The
 * scoped JWT remains in memory and is never printed or written to disk. Local
 * measurement rotates this session before the token ceiling or repeated-turn
 * dialogue policy can affect the requested sample count.
 */
export async function mintLocalMeasurementSession(
  { localOrigin, runtimeOrigin, turnIndex },
  fetchImpl = fetch,
) {
  const created = await readJsonResponse(
    await fetchImpl(new URL("/api/conversations", runtimeOrigin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: `voice-latency-${Date.now()}-${turnIndex}`,
        metadata: { scope: "general" },
      }),
    }),
    "local conversation create",
  );
  const conversationId = created?.conversation?.id;
  if (typeof conversationId !== "string" || !conversationId.trim()) {
    throw new Error("local conversation create returned no id");
  }

  const consent = await readJsonResponse(
    await fetchImpl(new URL("/api/v1/voice/session/consent", localOrigin), {
      method: "POST",
    }),
    "local voice consent",
  );
  if (typeof consent?.consentNonce !== "string" || !consent.consentNonce) {
    throw new Error("local voice consent returned no nonce");
  }

  const minted = await readJsonResponse(
    await fetchImpl(new URL("/api/v1/voice/session", localOrigin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId,
        consentNonce: consent.consentNonce,
        transport: "websocket",
      }),
    }),
    "local voice mint",
  );
  if (
    typeof minted?.wsUrl !== "string" ||
    !minted.wsUrl ||
    typeof minted?.token !== "string" ||
    !minted.token
  ) {
    throw new Error("local voice mint returned an incomplete session");
  }
  return { wsUrl: minted.wsUrl, token: minted.token };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
    ] ?? 0
  );
}

export function summarize(samples) {
  if (samples.length === 0) {
    throw new Error("cannot summarize an empty sample set");
  }
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
    `[voice-warm-turn-measure] stt_final->first_audible_audio p50=${result.summary.sttFinalToFirstAudio.p50Ms}ms ` +
      `p95=${result.summary.sttFinalToFirstAudio.p95Ms}ms max=${result.summary.sttFinalToFirstAudio.maxMs}ms\n`,
  );
  process.stdout.write(
    `[voice-warm-turn-measure] llm_first_text->answer_audio p50=${result.summary.llmFirstTextToAnswerAudio.p50Ms}ms ` +
      `p95=${result.summary.llmFirstTextToAnswerAudio.p95Ms}ms max=${result.summary.llmFirstTextToAnswerAudio.maxMs}ms\n`,
  );
  process.stdout.write(
    `[voice-warm-turn-measure] stt_final->answer_audio p50=${result.summary.sttFinalToAnswerAudio.p50Ms}ms ` +
      `p95=${result.summary.sttFinalToAnswerAudio.p95Ms}ms max=${result.summary.sttFinalToAnswerAudio.maxMs}ms\n`,
  );
  process.stdout.write(
    "\nturn\ttraceId\tstt->llm\tstt->audible\tllm->answer\tstt->answer\n",
  );
  for (const sample of result.samples) {
    process.stdout.write(
      `${sample.turn}\t${sample.traceId}\t${sample.sttFinalToLlmFirstTextMs}\t${sample.sttFinalToFirstAudioMs}\t${sample.llmFirstTextToAnswerAudioMs}\t${sample.sttFinalToAnswerAudioMs}\n`,
    );
  }
  process.stdout.write(`\n${result.note}\n`);
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const timeout = setTimeout(() => {
      ws.close();
      finish(() => reject(new Error("WebSocket open timed out")));
    }, 10_000);
    const onOpen = () => finish(() => resolve(ws));
    const onError = () =>
      finish(() => reject(new Error("WebSocket open failed")));
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
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

function controlFrame(data, context) {
  try {
    const frame = JSON.parse(messageText(data));
    if (!frame || typeof frame !== "object" || typeof frame.t !== "string") {
      throw new Error("missing control-frame type");
    }
    return frame;
  } catch (error) {
    throw new Error(`${context} received an invalid control frame`, {
      cause: error,
    });
  }
}

function waitForReady(ws, token) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(
      () => fail(new Error("ready timed out")),
      10_000,
    );
    const onMessage = (event) => {
      if (isBinaryMessage(event.data)) return;
      let frame;
      try {
        frame = controlFrame(event.data, "ready handshake");
      } catch (error) {
        fail(error);
        return;
      }
      if (frame.t === "ready") {
        cleanup();
        resolve(frame);
      }
      if (frame.t === "error") {
        fail(new Error(`ready failed: ${frame.code ?? "unknown"}`));
      }
    };
    const onError = () => fail(new Error("WebSocket failed before ready"));
    const onClose = () => fail(new Error("WebSocket closed before ready"));
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
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

export function measureTurn(ws, turnIndex, counted, timeoutMs) {
  const state = {
    turnIndex,
    counted,
    traceId: null,
    sttFinalAt: 0,
    llmFirstTextAt: 0,
    assistantOutputAt: 0,
    firstAudioAt: 0,
    firstAnswerAudioAt: 0,
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
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onClose);
      };
      const fail = (error) => {
        cleanup();
        reject(error);
      };
      const onMessage = (event) => {
        const now = performance.now();
        if (isBinaryMessage(event.data)) {
          if (state.sttFinalAt && !state.firstAudioAt) state.firstAudioAt = now;
          if (state.assistantOutputAt && !state.firstAnswerAudioAt) {
            state.firstAnswerAudioAt = now;
          }
          return;
        }
        let frame;
        try {
          frame = controlFrame(event.data, `turn ${turnIndex}`);
        } catch (error) {
          fail(error);
          return;
        }
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
        } else if (
          frame.t === "assistant_output" &&
          state.sttFinalAt &&
          !state.assistantOutputAt
        ) {
          state.assistantOutputAt = now;
        } else if (frame.t === "usage" && state.sttFinalAt) {
          if (
            !state.llmFirstTextAt ||
            !state.firstAudioAt ||
            !state.firstAnswerAudioAt
          ) {
            fail(
              new Error(
                `turn ${turnIndex} completed before model, audible, and answer audio evidence`,
              ),
            );
            return;
          }
          state.usageAt = now;
          cleanup();
          resolve(state);
        } else if (frame.t === "error") {
          fail(
            new Error(`turn ${turnIndex} failed: ${frame.code ?? "unknown"}`),
          );
        }
      };
      const onError = () => fail(new Error(`turn ${turnIndex} socket failed`));
      const onClose = () =>
        fail(new Error(`turn ${turnIndex} socket closed before usage`));
      ws.addEventListener("message", onMessage);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
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
    sttFinalToFirstAudioMs: round(sample.firstAudioAt - sample.sttFinalAt),
    llmFirstTextToAnswerAudioMs: round(
      sample.firstAnswerAudioAt - sample.llmFirstTextAt,
    ),
    sttFinalToAnswerAudioMs: round(
      sample.firstAnswerAudioAt - sample.sttFinalAt,
    ),
    sttFinalToUsageMs: round(sample.usageAt - sample.sttFinalAt),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pcm = await readFile(args.pcm);
  const samples = [];
  const readyTraceIds = [];

  const runTurn = async (ws, turnIndex, counted) => {
    const turn = measureTurn(ws, turnIndex, counted, args.turnTimeoutMs);
    await sendPcmTurn(ws, pcm, args);
    const sample = await turn.promise;
    if (sample.counted) samples.push(normalizeSample(sample));
  };

  if (args.localOrigin) {
    let ws = null;
    try {
      for (let index = 0; index < args.warmup + args.turns; index += 1) {
        if (index % args.localTurnsPerSession === 0) {
          ws?.close(1000, "measurement_session_rotated");
          const minted = await mintLocalMeasurementSession({
            localOrigin: args.localOrigin,
            runtimeOrigin: args.runtimeOrigin,
            turnIndex: index + 1,
          });
          ws = await connect(minted.wsUrl);
          const ready = await waitForReady(ws, minted.token);
          readyTraceIds.push(ready.traceId ?? null);
        }
        if (!ws) throw new Error("local measurement socket is unavailable");
        await runTurn(ws, index + 1, index >= args.warmup);
        await delay(250);
      }
    } finally {
      ws?.close(1000, "measurement_complete");
    }
  } else {
    const ws = await connect(args.wsUrl);
    try {
      const ready = await waitForReady(ws, args.token);
      readyTraceIds.push(ready.traceId ?? null);
      for (let index = 0; index < args.warmup + args.turns; index += 1) {
        await runTurn(ws, index + 1, index >= args.warmup);
        await delay(250);
      }
    } finally {
      ws.close(1000, "measurement_complete");
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    target: args.localOrigin
      ? new URL(args.localOrigin).origin
      : new URL(args.wsUrl).origin,
    fixture: basename(args.pcm),
    warmupTurns: args.warmup,
    measuredTurns: args.turns,
    sessionMode: args.localOrigin ? "isolated-local" : "staging",
    readyTraceId: readyTraceIds[0] ?? null,
    readyTraceIds,
    note: args.localOrigin
      ? `Local sessions rotated every ${args.localTurnsPerSession} turns with a fresh conversation; provider credentials remained inside the running gateway.`
      : "Correlate traceId/conversationId with Worker logs containing `[shared-runtime REST] stream pre-header timing` for bridge pre-header timings.",
    summary: {
      sttFinalToLlmFirstText: summarize(
        samples.map((sample) => sample.sttFinalToLlmFirstTextMs),
      ),
      llmFirstTextToAnswerAudio: summarize(
        samples.map((sample) => sample.llmFirstTextToAnswerAudioMs),
      ),
      sttFinalToFirstAudio: summarize(
        samples.map((sample) => sample.sttFinalToFirstAudioMs),
      ),
      sttFinalToAnswerAudio: summarize(
        samples.map((sample) => sample.sttFinalToAnswerAudioMs),
      ),
    },
    samples,
  };
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printHuman(result);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`,
    );
    process.exit(1);
  });
}
