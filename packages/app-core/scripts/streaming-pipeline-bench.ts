#!/usr/bin/env bun
/**
 * End-to-end streaming-pipeline benchmark.
 *
 * Drives the real `AgentRuntime.useModel` + `runWithStreamingContext` path
 * with a programmable mock provider so we can measure:
 *
 *   - TTFT (time-to-first-token) from the moment `useModel` is called
 *   - per-chunk inter-arrival latencies (p50 / p90 / p99)
 *   - the LLM -> phrase-chunker -> TTS handoff for both:
 *       (a) the LOCAL path — handler emits via `onStreamChunk` callback
 *       (b) the REMOTE path — handler returns a `TextStreamResult` and the
 *           runtime drains its `textStream`
 *   - phrase-1-to-tts latency under the existing PhraseChunker
 *
 * Run:
 *   BUN_TEST_COVERAGE=0 bun packages/app-core/scripts/streaming-pipeline-bench.ts
 *
 * Output is a single JSON block on stdout (machine readable) followed by
 * a human-readable table on stderr. Exit code is 0 unless the pipeline
 * itself fails — this script is intentionally non-gating; it's a measurement
 * tool, not a CI checker.
 */

import { performance } from "node:perf_hooks";
import { InMemoryDatabaseAdapter } from "../../core/src/database/inMemoryAdapter";
import { AgentRuntime } from "../../core/src/runtime";
import { runWithStreamingContext } from "../../core/src/streaming-context";
import { ModelType } from "../../core/src/types";
import {
	type AcceptedToken,
	PhraseChunker,
} from "@elizaos/plugin-local-inference/services";
import { PhraseChunkedTts } from "../src/services/phrase-chunked-tts";

// ---------------------------------------------------------------------------
// Knobs (override via env)
// ---------------------------------------------------------------------------

const RESPONSE_TEXT =
  process.env.BENCH_RESPONSE ??
  "Hello there! I'm running a quick check to make sure the streaming pipeline is solid. " +
    "The first sentence should land in TTS immediately. " +
    "Then the next phrase, comma-delimited, can stream while the rest of the response continues. " +
    "Long sentences without punctuation should still flush on the time budget so audio never stalls.";

const INTER_TOKEN_DELAY_MS = Number(process.env.BENCH_INTER_TOKEN_MS ?? "8");
const TOKENIZATION_GRANULARITY = process.env.BENCH_TOKENIZER ?? "word"; // word | char | bpe-like
const TURN_COUNT = Number(process.env.BENCH_TURNS ?? "5");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenize(text: string, granularity: string): string[] {
  if (granularity === "char") return [...text];
  if (granularity === "bpe-like") {
    // Crude BPE-ish: split on whitespace then break long words into 4-char shards.
    const out: string[] = [];
    for (const word of text.split(/(\s+)/g)) {
      if (word.length <= 6) out.push(word);
      else
        for (let i = 0; i < word.length; i += 4) out.push(word.slice(i, i + 4));
    }
    return out;
  }
  // Default: whitespace-preserving word tokens (closest to streamText behavior).
  return text.split(/(\s+)/g).filter((s) => s.length > 0);
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function pct(samples: number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx]!;
}

interface SampleSummary {
  count: number;
  min: number | null;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

function summarize(samples: number[]): SampleSummary {
  if (samples.length === 0) {
    return {
      count: 0,
      min: null,
      p50: null,
      p90: null,
      p99: null,
      max: null,
      mean: null,
    };
  }
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    count: samples.length,
    min: Math.min(...samples),
    p50: pct(samples, 50),
    p90: pct(samples, 90),
    p99: pct(samples, 99),
    max: Math.max(...samples),
    mean: sum / samples.length,
  };
}

function fmt(n: number | null, suffix = "ms"): string {
  if (n === null) return "—";
  return `${n.toFixed(2)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Provider mocks
// ---------------------------------------------------------------------------

interface RunResult {
  totalMs: number;
  ttftMs: number; // useModel-call -> first onStreamChunk
  interTokenSamples: number[]; // ms between successive onStreamChunk
  tokenCount: number;
  firstPhraseToTtsMs: number | null; // chunker hand-off
  ttftToTtsMs: number | null; // useModel-call -> phrase-1 to TTS
  ttsCalls: number;
  phraseTexts: string[];
}

/**
 * LOCAL-style handler: streams chunks via the `onStreamChunk` callback
 * that useModel plumbs in (this is how llama.cpp / capacitor-llama work).
 * The caller passes `onStreamChunk` directly in `params` so the runtime's
 * `handlerStreamChunk` plumbing fires.
 */
async function runLocalPath(
  tokens: string[],
  interTokenMs: number,
): Promise<RunResult> {
  const runtime = new AgentRuntime({
    character: { name: "BenchAgent", bio: "bench", settings: {} } as never,
    adapter: new InMemoryDatabaseAdapter(),
    logLevel: "fatal",
  });

  const handler = async (
    _runtime: unknown,
    params: unknown,
  ): Promise<string> => {
    const p = params as {
      stream?: boolean;
      onStreamChunk?: (chunk: string) => Promise<void> | void;
    };
    let acc = "";
    for (const tok of tokens) {
      acc += tok;
      await p.onStreamChunk?.(tok);
      await sleep(interTokenMs);
    }
    return acc;
  };

  runtime.registerModel(ModelType.TEXT_LARGE, handler, "eliza-local-inference");

  return runOneTurn(runtime, tokens.length, /* useParamsChunk= */ true);
}

/**
 * REMOTE-style handler: returns a TextStreamResult and lets the runtime
 * drain the async iterable.
 */
async function runRemotePath(
  tokens: string[],
  interTokenMs: number,
): Promise<RunResult> {
  const runtime = new AgentRuntime({
    character: { name: "BenchAgent", bio: "bench", settings: {} } as never,
    adapter: new InMemoryDatabaseAdapter(),
    logLevel: "fatal",
  });

  const handler = async (
    _runtime: unknown,
    _params: unknown,
  ): Promise<unknown> => {
    async function* gen(): AsyncIterable<string> {
      for (const tok of tokens) {
        yield tok;
        await sleep(interTokenMs);
      }
    }
    const finalText = tokens.join("");
    return {
      textStream: gen(),
      text: Promise.resolve(finalText),
      usage: Promise.resolve({
        promptTokens: 0,
        completionTokens: tokens.length,
      }),
      finishReason: Promise.resolve("stop"),
    };
  };

  runtime.registerModel(ModelType.TEXT_LARGE, handler, "anthropic");

  return runOneTurn(runtime, tokens.length, /* useParamsChunk= */ false);
}

async function runOneTurn(
  runtime: AgentRuntime,
  _expectedTokens: number,
  useParamsChunk: boolean,
): Promise<RunResult> {
  const chunker = new PhraseChunker({
    chunkOn: "punctuation",
    maxTokensPerPhrase: 30,
  });
  const interTokenSamples: number[] = [];
  let lastChunkAt = -1;
  let firstTokenAt = -1;
  let firstPhraseToTtsAt = -1;
  let tokenIndex = 0;
  let ttsCalls = 0;
  const phraseTexts: string[] = [];

  // Simulated TTS sink — records when each phrase arrives.
  const ttsHandler = (phrase: string): void => {
    ttsCalls += 1;
    phraseTexts.push(phrase);
    if (firstPhraseToTtsAt < 0) firstPhraseToTtsAt = performance.now();
  };

  const onChunk = async (chunk: string): Promise<void> => {
    const now = performance.now();
    if (firstTokenAt < 0) firstTokenAt = now;
    if (lastChunkAt > 0) interTokenSamples.push(now - lastChunkAt);
    lastChunkAt = now;

    const acceptedToken: AcceptedToken = {
      index: tokenIndex++,
      text: chunk,
      acceptedAt: now,
    };
    const phrase = chunker.push(acceptedToken);
    if (phrase) ttsHandler(phrase.text);
  };

  // For LOCAL handlers, the runtime only plumbs `onStreamChunk` into the
  // handler when `paramsChunk` (or a structured-extractor) is set — see
  // runtime.ts useModel `handlerStreamChunk` gating. Real callers
  // (DefaultMessageService at chat-routes.ts:1516) pass it in params; we
  // mirror that here. We do NOT also set ctxChunk for the LOCAL path since
  // useModel would then invoke both callbacks per chunk (double-counted).
  const t0 = performance.now();
  if (useParamsChunk) {
    await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: "bench",
      stream: true,
      onStreamChunk: onChunk,
    });
  } else {
    await runWithStreamingContext(
      { messageId: "bench-message", onStreamChunk: onChunk },
      async () => {
        await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: "bench",
          stream: true,
        });
      },
    );
  }

  // Flush any remaining tokens to TTS.
  const tail = chunker.flushPending();
  if (tail) ttsHandler(tail.text);

  const totalMs = performance.now() - t0;
  return {
    totalMs,
    ttftMs: firstTokenAt - t0,
    interTokenSamples,
    tokenCount: tokenIndex,
    firstPhraseToTtsMs:
      firstPhraseToTtsAt > 0 ? firstPhraseToTtsAt - firstTokenAt : null,
    ttftToTtsMs: firstPhraseToTtsAt > 0 ? firstPhraseToTtsAt - t0 : null,
    ttsCalls,
    phraseTexts,
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

interface PathStats {
  ttft: SampleSummary;
  interToken: SampleSummary;
  total: SampleSummary;
  firstPhraseToTts: SampleSummary;
  ttftToTts: SampleSummary;
  tokensPerTurn: number;
  ttsCallsPerTurn: number;
  examplePhraseSplit: string[];
}

async function runPath(
  _label: string,
  fn: () => Promise<RunResult>,
  turns: number,
): Promise<PathStats> {
  const ttft: number[] = [];
  const interToken: number[] = [];
  const total: number[] = [];
  const firstPhraseToTts: number[] = [];
  const ttftToTts: number[] = [];
  let lastRun: RunResult | null = null;

  for (let i = 0; i < turns; i++) {
    const r = await fn();
    ttft.push(r.ttftMs);
    interToken.push(...r.interTokenSamples);
    total.push(r.totalMs);
    if (r.firstPhraseToTtsMs !== null)
      firstPhraseToTts.push(r.firstPhraseToTtsMs);
    if (r.ttftToTtsMs !== null) ttftToTts.push(r.ttftToTtsMs);
    lastRun = r;
  }

  return {
    ttft: summarize(ttft),
    interToken: summarize(interToken),
    total: summarize(total),
    firstPhraseToTts: summarize(firstPhraseToTts),
    ttftToTts: summarize(ttftToTts),
    tokensPerTurn: lastRun?.tokenCount ?? 0,
    ttsCallsPerTurn: lastRun?.ttsCalls ?? 0,
    examplePhraseSplit: lastRun?.phraseTexts ?? [],
  };
}

function printTable(label: string, s: PathStats): void {
  process.stderr.write(`\n=== ${label} ===\n`);
  process.stderr.write(`tokens / turn: ${s.tokensPerTurn}\n`);
  process.stderr.write(`TTS calls / turn: ${s.ttsCallsPerTurn}\n`);
  const rows = [
    ["TTFT (useModel → first chunk)", s.ttft],
    ["Inter-token (chunk → next chunk)", s.interToken],
    ["First-phrase → TTS (chunker handoff)", s.firstPhraseToTts],
    ["useModel → first TTS call (TTFA proxy)", s.ttftToTts],
    ["Total turn duration", s.total],
  ] as const;
  process.stderr.write("\n");
  process.stderr.write(
    `${"metric".padEnd(40)} ${"min".padStart(8)} ${"p50".padStart(8)} ${"p90".padStart(8)} ${"p99".padStart(8)} ${"max".padStart(8)} ${"mean".padStart(8)}\n`,
  );
  for (const [name, sum] of rows) {
    process.stderr.write(
      `${name.padEnd(40)} ${fmt(sum.min).padStart(8)} ${fmt(sum.p50).padStart(8)} ${fmt(sum.p90).padStart(8)} ${fmt(sum.p99).padStart(8)} ${fmt(sum.max).padStart(8)} ${fmt(sum.mean).padStart(8)}\n`,
    );
  }
  process.stderr.write("\nfirst phrases emitted to TTS (example turn):\n");
  for (const [i, ph] of s.examplePhraseSplit.slice(0, 5).entries()) {
    process.stderr.write(`  [${i}] ${JSON.stringify(ph)}\n`);
  }
  if (s.examplePhraseSplit.length > 5) {
    process.stderr.write(`  ...and ${s.examplePhraseSplit.length - 5} more\n`);
  }
}

// ---------------------------------------------------------------------------
// Bridge benchmark: PhraseChunkedTts wrapping a mock remote TTS that has its
// own per-call latency (the real-world Edge TTS / ElevenLabs case).
// ---------------------------------------------------------------------------

interface BridgeStats {
  turns: number;
  ttsCallsPerTurn: number;
  firstTtsCallMs: SampleSummary; // start of LLM stream → first TTS handler invocation
  firstAudioReadyMs: SampleSummary; // start of LLM stream → first TTS handler resolved
  bridgeTotalMs: SampleSummary; // bridge.finish() returned
  phrasesPreview: string[];
}

async function runBridgePath(
  tokens: string[],
  interTokenMs: number,
  ttsLatencyMs: number,
  turns: number,
): Promise<BridgeStats> {
  const firstTtsCall: number[] = [];
  const firstAudioReady: number[] = [];
  const bridgeTotal: number[] = [];
  let lastPhrases: string[] = [];

  for (let i = 0; i < turns; i++) {
    const phrases: string[] = [];
    const t0 = performance.now();
    let firstCallAt = -1;
    let firstResolveAt = -1;

    const tts = async (text: string): Promise<string> => {
      if (firstCallAt < 0) firstCallAt = performance.now();
      // Simulate remote TTS network + synthesis time.
      await sleep(ttsLatencyMs);
      const result = `audio<${text.length}b>`;
      if (firstResolveAt < 0) firstResolveAt = performance.now();
      return result;
    };

    const pipe = new PhraseChunkedTts(tts, {
      onPhraseEmit: (p) => phrases.push(p.text),
    });

    for (const tok of tokens) {
      pipe.push(tok);
      await sleep(interTokenMs);
    }
    await pipe.finish();
    const t1 = performance.now();

    firstTtsCall.push(firstCallAt > 0 ? firstCallAt - t0 : Number.NaN);
    firstAudioReady.push(firstResolveAt > 0 ? firstResolveAt - t0 : Number.NaN);
    bridgeTotal.push(t1 - t0);
    lastPhrases = phrases;
  }

  return {
    turns,
    ttsCallsPerTurn: lastPhrases.length,
    firstTtsCallMs: summarize(firstTtsCall.filter((n) => Number.isFinite(n))),
    firstAudioReadyMs: summarize(
      firstAudioReady.filter((n) => Number.isFinite(n)),
    ),
    bridgeTotalMs: summarize(bridgeTotal),
    phrasesPreview: lastPhrases.slice(0, 5),
  };
}

function printBridgeTable(label: string, s: BridgeStats): void {
  process.stderr.write(`\n=== ${label} ===\n`);
  process.stderr.write(`TTS calls / turn: ${s.ttsCallsPerTurn}\n\n`);
  const rows = [
    ["LLM start → first TTS handler call (TTFA-call)", s.firstTtsCallMs],
    [
      "LLM start → first TTS handler resolved (TTFA-audio)",
      s.firstAudioReadyMs,
    ],
    ["Bridge total duration", s.bridgeTotalMs],
  ] as const;
  process.stderr.write(
    `${"metric".padEnd(50)} ${"min".padStart(8)} ${"p50".padStart(8)} ${"p90".padStart(8)} ${"p99".padStart(8)} ${"max".padStart(8)} ${"mean".padStart(8)}\n`,
  );
  for (const [name, sum] of rows) {
    process.stderr.write(
      `${name.padEnd(50)} ${fmt(sum.min).padStart(8)} ${fmt(sum.p50).padStart(8)} ${fmt(sum.p90).padStart(8)} ${fmt(sum.p99).padStart(8)} ${fmt(sum.max).padStart(8)} ${fmt(sum.mean).padStart(8)}\n`,
    );
  }
  process.stderr.write("\nphrases handed to TTS:\n");
  for (const [i, ph] of s.phrasesPreview.entries()) {
    process.stderr.write(`  [${i}] ${JSON.stringify(ph)}\n`);
  }
}

async function main(): Promise<void> {
  const tokens = tokenize(RESPONSE_TEXT, TOKENIZATION_GRANULARITY);

  process.stderr.write(
    `streaming-pipeline-bench: ${tokens.length} tokens, inter-token=${INTER_TOKEN_DELAY_MS}ms, turns=${TURN_COUNT}, tokenizer=${TOKENIZATION_GRANULARITY}\n`,
  );

  const local = await runPath(
    "LOCAL  (handler streams via onStreamChunk)",
    () => runLocalPath(tokens, INTER_TOKEN_DELAY_MS),
    TURN_COUNT,
  );
  printTable("LOCAL  (handler streams via onStreamChunk)", local);

  const remote = await runPath(
    "REMOTE (handler returns TextStreamResult)",
    () => runRemotePath(tokens, INTER_TOKEN_DELAY_MS),
    TURN_COUNT,
  );
  printTable("REMOTE (handler returns TextStreamResult)", remote);

  // Bridge bench — what we add to the system for the user's "remote voice"
  // ask. TTS latency 200ms ≈ Edge TTS network round-trip; 50ms ≈ a tuned
  // local TTS via FFI. We run both so the user can see how much of the
  // total latency is the TTS provider itself.
  const bridgeFast = await runBridgePath(
    tokens,
    INTER_TOKEN_DELAY_MS,
    50,
    TURN_COUNT,
  );
  printBridgeTable("BRIDGE (PhraseChunkedTts, 50ms TTS latency)", bridgeFast);

  const bridgeRemote = await runBridgePath(
    tokens,
    INTER_TOKEN_DELAY_MS,
    200,
    TURN_COUNT,
  );
  printBridgeTable(
    "BRIDGE (PhraseChunkedTts, 200ms TTS latency)",
    bridgeRemote,
  );

  // Machine-readable summary on stdout.
  process.stdout.write(
    `${JSON.stringify(
      {
        config: {
          tokens: tokens.length,
          interTokenDelayMs: INTER_TOKEN_DELAY_MS,
          turns: TURN_COUNT,
          tokenizer: TOKENIZATION_GRANULARITY,
        },
        local,
        remote,
        bridgeFast,
        bridgeRemote,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `bench failed: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
