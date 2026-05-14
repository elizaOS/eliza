#!/usr/bin/env bun
/**
 * Local STT (speech-to-text) microbenchmark.
 *
 * Drives `AgentRuntime.useModel(ModelType.TRANSCRIPTION, ...)` against a
 * mocked handler so we can measure the per-turn cost of the runtime's
 * model-dispatch path — independent of any real ASR backend. The mock
 * handler sleeps `BENCH_DECODE_MS` to simulate decode time and returns a
 * canned transcript. The script reports min/p50/p90/p99/max/mean over
 * `BENCH_TURNS` turns.
 *
 * Run:
 *   BUN_TEST_COVERAGE=0 bun packages/app-core/scripts/local-stt-bench.ts
 *
 * Output: a human-readable table on stderr + a single JSON block on stdout.
 * Exit code is 0 unless the runtime itself fails — this is a measurement
 * tool, not a CI checker.
 */

import { performance } from "node:perf_hooks";
import { InMemoryDatabaseAdapter } from "../../core/src/database/inMemoryAdapter";
import { AgentRuntime } from "../../core/src/runtime";
import { ModelType } from "../../core/src/types";

// ---------------------------------------------------------------------------
// Knobs (override via env)
// ---------------------------------------------------------------------------

const TURN_COUNT = Number(process.env.BENCH_TURNS ?? "5");
const DECODE_MS = Number(process.env.BENCH_DECODE_MS ?? "80");
const PCM_SAMPLES = Number(process.env.BENCH_PCM_SAMPLES ?? "480");
const TRANSCRIPT = process.env.BENCH_TRANSCRIPT ?? "hello world";

// ---------------------------------------------------------------------------
// Helpers (mirror streaming-pipeline-bench.ts)
// ---------------------------------------------------------------------------

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
// Driver
// ---------------------------------------------------------------------------

interface TranscriptionParams {
  pcm: Float32Array;
  sampleRateHz: number;
}

async function buildRuntime(): Promise<AgentRuntime> {
  const runtime = new AgentRuntime({
    character: {
      name: "LocalSttBench",
      bio: "bench",
      settings: {},
    } as never,
    adapter: new InMemoryDatabaseAdapter(),
    logLevel: "fatal",
  });

  const handler = async (
    _runtime: unknown,
    _params: unknown,
  ): Promise<string> => {
    await sleep(DECODE_MS);
    return TRANSCRIPT;
  };
  runtime.registerModel(
    ModelType.TRANSCRIPTION,
    handler,
    "eliza-local-inference",
  );

  return runtime;
}

async function runTurn(runtime: AgentRuntime): Promise<number> {
  const params: TranscriptionParams = {
    pcm: new Float32Array(PCM_SAMPLES),
    sampleRateHz: 16_000,
  };
  const t0 = performance.now();
  const out = await runtime.useModel(
    ModelType.TRANSCRIPTION,
    params as never,
  );
  const elapsed = performance.now() - t0;
  if (typeof out !== "string" || out.length === 0) {
    throw new Error(
      `local-stt-bench: handler returned unexpected value: ${JSON.stringify(out)}`,
    );
  }
  return elapsed;
}

async function main(): Promise<void> {
  process.stderr.write(
    `local-stt-bench: turns=${TURN_COUNT}, decode=${DECODE_MS}ms, pcm-samples=${PCM_SAMPLES}\n`,
  );

  const runtime = await buildRuntime();

  // One warmup turn so the JIT + lazy state-store init don't bias the first sample.
  await runTurn(runtime);

  const samples: number[] = [];
  for (let i = 0; i < TURN_COUNT; i++) {
    samples.push(await runTurn(runtime));
  }

  const stats = summarize(samples);

  // Human-readable table on stderr.
  process.stderr.write(`\n=== TRANSCRIPTION (useModel → handler) ===\n`);
  process.stderr.write(
    `${"metric".padEnd(40)} ${"min".padStart(8)} ${"p50".padStart(8)} ${"p90".padStart(8)} ${"p99".padStart(8)} ${"max".padStart(8)} ${"mean".padStart(8)}\n`,
  );
  process.stderr.write(
    `${"per-turn latency".padEnd(40)} ${fmt(stats.min).padStart(8)} ${fmt(stats.p50).padStart(8)} ${fmt(stats.p90).padStart(8)} ${fmt(stats.p99).padStart(8)} ${fmt(stats.max).padStart(8)} ${fmt(stats.mean).padStart(8)}\n`,
  );

  // Machine-readable summary on stdout.
  process.stdout.write(
    `${JSON.stringify(
      {
        config: {
          turns: TURN_COUNT,
          decodeMs: DECODE_MS,
          pcmSamples: PCM_SAMPLES,
        },
        perTurnMs: stats,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `local-stt-bench failed: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
