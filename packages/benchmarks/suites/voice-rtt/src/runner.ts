#!/usr/bin/env bun
/**
 * CLI entrypoint for the provider-agnostic voice round-trip benchmark.
 *
 * Mock mode is deterministic and enforces latency/cancellation gates for CI.
 * Live mode requires Deepgram, Cerebras, and Cartesia keys and treats gates as
 * advisory until `--enforce-live-gates` is supplied with an accepted baseline.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createLiveAdapters } from "./adapters/live.ts";
import { createMockAdapters } from "./adapters/mock.ts";
import { loadCorpus } from "./corpus.ts";
import {
  buildReport,
  redactReport,
  renderJson,
  renderMarkdown,
} from "./report.ts";
import { runTurn } from "./run-turn.ts";
import { makeTraceId } from "./trace.ts";
import type { BenchmarkMode, RunConfig } from "./types.ts";

/* v8 ignore start -- CLI parsing is exercised by command smoke tests @preserve */
interface Args {
  mode: BenchmarkMode;
  runs: number;
  out?: string;
  timeoutMs: number;
  unsafeTranscripts: boolean;
  enforceLiveGates: boolean;
  audioDir?: string;
}

const HELP = `Voice RTT benchmark

Flags:
  --mode=mock | --mode=live      provider mode (default: mock)
  --runs=<n>                     repeats per corpus item (default: 3)
  --out=<dir>                    write report.json and report.md
  --timeout-ms=<n>               per-turn timeout (default: 30000)
  --audio-dir=<dir>              live-mode PCM corpus directory (<case>.pcm)
  --unsafe-transcripts           include transcript/reply text in artifacts
  --enforce-live-gates           fail live runs on latency gates
  --help                         show this message

Environment for --mode=live:
  DEEPGRAM_API_KEY, CEREBRAS_API_KEY, CARTESIA_API_KEY
`;

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    mode: "mock",
    runs: 3,
    timeoutMs: 30_000,
    unsafeTranscripts: false,
    enforceLiveGates: false,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (arg === "--mode=mock") args.mode = "mock";
    else if (arg === "--mode=live") args.mode = "live";
    else if (arg.startsWith("--runs=")) args.runs = positiveInt(arg, "--runs=");
    else if (arg.startsWith("--out=")) args.out = arg.slice("--out=".length);
    else if (arg.startsWith("--timeout-ms=")) {
      args.timeoutMs = positiveInt(arg, "--timeout-ms=");
    } else if (arg.startsWith("--audio-dir=")) {
      args.audioDir = arg.slice("--audio-dir=".length);
    } else if (arg === "--unsafe-transcripts") args.unsafeTranscripts = true;
    else if (arg === "--enforce-live-gates") args.enforceLiveGates = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}
/* v8 ignore stop -- @preserve */

export async function runBenchmark(config: RunConfig) {
  const corpus = loadCorpus();
  const adapters =
    config.mode === "live" ? createLiveAdapters() : createMockAdapters();
  const results = [];
  for (let runIndex = 0; runIndex < config.runs; runIndex++) {
    for (const corpusCase of corpus) {
      const traceId = makeTraceId(corpusCase.id, runIndex);
      process.stdout.write(
        `[${corpusCase.id}#${runIndex}] X-Eliza-Voice-Trace-Id=${traceId}\n`,
      );
      const result = await runTurn({
        corpus: corpusCase,
        runIndex,
        traceId,
        mode: config.mode,
        stt: adapters.stt,
        llm: adapters.llm,
        tts: adapters.tts,
        timeoutMs: config.timeoutMs,
        unsafeTranscripts: config.unsafeTranscripts,
        audioDir: config.audioDir,
      });
      results.push(result);
    }
  }
  const report = buildReport({
    generatedAt: config.nowIso(),
    mode: config.mode,
    providers: {
      stt: adapters.stt.name,
      llm: adapters.llm.name,
      tts: adapters.tts.name,
    },
    results,
    enforceGates: config.mode === "mock" || config.enforceLiveGates,
  });
  return config.unsafeTranscripts ? report : redactReport(report);
}

/* v8 ignore start -- CLI I/O is covered by benchmark smoke execution @preserve */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runBenchmark({
    mode: args.mode,
    runs: args.runs,
    outDir: args.out,
    timeoutMs: args.timeoutMs,
    unsafeTranscripts: args.unsafeTranscripts,
    enforceLiveGates: args.enforceLiveGates,
    audioDir: args.audioDir,
    nowIso: () => new Date().toISOString(),
  });
  process.stdout.write(renderMarkdown(report));
  if (args.out) {
    const outDir = resolve(args.out);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "report.json"), renderJson(report), "utf8");
    writeFileSync(resolve(outDir, "report.md"), renderMarkdown(report), "utf8");
    process.stdout.write(`Wrote ${resolve(outDir, "report.json")}\n`);
    process.stdout.write(`Wrote ${resolve(outDir, "report.md")}\n`);
  }
  if (!report.gates.passed) process.exitCode = 1;
}

function positiveInt(arg: string, prefix: string): number {
  const value = Number.parseInt(arg.slice(prefix.length), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${prefix.slice(0, -1)} must be a positive integer`);
  }
  return value;
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(
      `Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
}
/* v8 ignore stop -- @preserve */
