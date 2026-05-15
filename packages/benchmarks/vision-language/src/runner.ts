#!/usr/bin/env bun
/**
 * Vision-language bench runner.
 *
 * Usage:
 *   bun run src/runner.ts --tier eliza-1-9b --benchmark screenspot \
 *       --samples 100 --output report.json
 *
 *   bun run src/runner.ts --smoke              # 5 samples per benchmark, no model
 *
 * Flow:
 *   1. resolve a `VisionRuntime` for the requested tier (or stub for --smoke)
 *   2. construct the benchmark adapter
 *   3. iterate the loaded samples, ask the runtime, score, aggregate
 *   4. write the report under `results/<tier>-<benchmark>-<date>.json`
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChartQaAdapter, predictChartQa } from "./adapters/chartqa_adapter.ts";
import { DocVqaAdapter, predictDocVqa } from "./adapters/docvqa_adapter.ts";
import { OSWorldAdapter, predictOSWorld } from "./adapters/osworld_adapter.ts";
import {
  ScreenSpotAdapter,
  predictScreenSpot,
} from "./adapters/screenspot_adapter.ts";
import {
  TextVqaAdapter,
  predictTextVqa,
} from "./adapters/textvqa_adapter.ts";
import { resolveRuntime } from "./runtime-resolver.ts";
import type {
  BaselineEntry,
  BenchReport,
  BenchmarkAdapter,
  BenchmarkName,
  Eliza1TierId,
  Prediction,
  Sample,
  SampleResult,
  VisionRuntime,
} from "./types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");

const ALL_BENCHMARKS: BenchmarkName[] = [
  "textvqa",
  "docvqa",
  "chartqa",
  "screenspot",
  "osworld",
];

const VALID_TIERS = new Set<string>([
  "eliza-1-0_8b",
  "eliza-1-2b",
  "eliza-1-4b",
  "eliza-1-9b",
  "eliza-1-27b",
  "eliza-1-27b-256k",
  "stub",
]);

interface Args {
  tier: Eliza1TierId | "stub";
  benchmarks: BenchmarkName[];
  samples: number;
  output?: string;
  smoke: boolean;
  /** Force the deterministic stub runtime even if a model is available. */
  forceStub: boolean;
}

const HELP = `vision-language bench

Flags:
  --tier <id>          eliza-1 tier; one of eliza-1-0_8b, eliza-1-2b,
                       eliza-1-4b, eliza-1-9b, eliza-1-27b, eliza-1-27b-256k.
                       Default: eliza-1-9b.
  --benchmark <name>   one of textvqa, docvqa, chartqa, screenspot, osworld.
                       May be repeated; "all" expands to every benchmark.
                       Default: all.
  --samples <count>    samples per benchmark. Default: 100 (or 5 with --smoke).
  --output <path>      output JSON for a single-benchmark run. When omitted
                       the runner writes results/<tier>-<bench>-<date>.json
                       (the path the HF model-card pipeline reads from).
  --smoke              run 5 samples per benchmark using the checked-in
                       fixtures and a deterministic stub runtime.
  --stub               use the stub runtime even outside --smoke (useful
                       for harness CI on hosts with no model on disk).
  --help, -h           show this help.
`;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    tier: "eliza-1-9b",
    benchmarks: ALL_BENCHMARKS,
    samples: 100,
    smoke: false,
    forceStub: false,
  };
  const requestedBenchmarks: BenchmarkName[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (arg === "--tier") {
      const next = argv[++i];
      if (!next) throw new Error("--tier requires a value");
      if (!VALID_TIERS.has(next)) {
        throw new Error(
          `--tier must be one of ${[...VALID_TIERS].join(", ")} (got '${next}')`,
        );
      }
      args.tier = next as Eliza1TierId | "stub";
    } else if (arg === "--benchmark") {
      const next = argv[++i];
      if (!next) throw new Error("--benchmark requires a value");
      if (next === "all") {
        requestedBenchmarks.push(...ALL_BENCHMARKS);
        continue;
      }
      if (!ALL_BENCHMARKS.includes(next as BenchmarkName)) {
        throw new Error(
          `--benchmark must be one of ${ALL_BENCHMARKS.join(", ")} or 'all'`,
        );
      }
      requestedBenchmarks.push(next as BenchmarkName);
    } else if (arg === "--samples") {
      const next = argv[++i];
      if (!next) throw new Error("--samples requires a value");
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--samples must be a positive integer (got '${next}')`);
      }
      args.samples = parsed;
    } else if (arg === "--output") {
      const next = argv[++i];
      if (!next) throw new Error("--output requires a value");
      args.output = next;
    } else if (arg === "--smoke") {
      args.smoke = true;
    } else if (arg === "--stub") {
      args.forceStub = true;
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }
  if (requestedBenchmarks.length > 0) args.benchmarks = requestedBenchmarks;
  if (args.smoke && args.samples === 100) args.samples = 5;
  if (args.smoke) args.forceStub = true;
  return args;
}

function adapterFor(name: BenchmarkName): BenchmarkAdapter {
  if (name === "textvqa") return new TextVqaAdapter();
  if (name === "docvqa") return new DocVqaAdapter();
  if (name === "chartqa") return new ChartQaAdapter();
  if (name === "screenspot") return new ScreenSpotAdapter();
  if (name === "osworld") return new OSWorldAdapter();
  throw new Error(`no adapter registered for benchmark '${name}'`);
}

async function predictFor(
  name: BenchmarkName,
  runtime: VisionRuntime,
  samples: Sample[],
  smoke: boolean,
): Promise<Prediction[]> {
  if (name === "textvqa") return predictTextVqa(runtime, samples as Sample<{ answers: string[] }>[]);
  if (name === "docvqa") return predictDocVqa(runtime, samples as Sample<{ answers: string[] }>[]);
  if (name === "chartqa") {
    return predictChartQa(
      runtime,
      samples as Sample<{ answers: string[]; answerType: "numeric" | "categorical" }>[],
    );
  }
  if (name === "screenspot") {
    return predictScreenSpot(
      runtime,
      samples as Sample<{ bbox: readonly [number, number, number, number]; platform: "desktop" | "mobile" | "web" }>[],
    );
  }
  if (name === "osworld") {
    return predictOSWorld(
      runtime,
      samples as Sample<{ trace: import("./types.ts").PredictedAction[] }>[],
      { smoke },
    );
  }
  throw new Error(`no predict driver for benchmark '${name}'`);
}

interface BaselinesFile {
  baselines: Record<string, { score: number; source: string }>;
}

let cachedBaselines: BaselinesFile | null = null;

function loadBaselines(): BaselinesFile {
  if (cachedBaselines) return cachedBaselines;
  const file = join(PACKAGE_ROOT, "baselines.json");
  cachedBaselines = JSON.parse(readFileSync(file, "utf8")) as BaselinesFile;
  return cachedBaselines;
}

export function lookupBaseline(
  tier: string,
  benchmark: BenchmarkName,
): BaselineEntry | null {
  const file = loadBaselines();
  const entry = file.baselines[`${tier}::${benchmark}`];
  if (!entry) return null;
  return {
    tier,
    benchmark,
    score: entry.score,
    source: entry.source,
  };
}

export interface RunOneArgs {
  tier: Eliza1TierId | "stub";
  benchmark: BenchmarkName;
  samples: number;
  smoke: boolean;
  runtime: VisionRuntime;
}

/**
 * Core single-benchmark run, exposed for tests + programmatic use.
 */
export async function runOneBenchmark(args: RunOneArgs): Promise<BenchReport> {
  const adapter = adapterFor(args.benchmark);
  const samples = await adapter.loadSamples(args.samples, { smoke: args.smoke });
  const startedAt = Date.now();
  const predictions = await predictFor(
    args.benchmark,
    args.runtime,
    samples,
    args.smoke,
  );
  const runtimeSec = (Date.now() - startedAt) / 1000;
  const sampleResults: SampleResult[] = [];
  let total = 0;
  let errorCount = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    const pred = predictions[i];
    if (pred.error) errorCount += 1;
    const { score, detail } = adapter.scoreOne(sample, pred);
    total += score;
    sampleResults.push({
      sampleId: sample.id,
      score,
      prediction: pred,
      detail,
    });
  }
  const baseline = lookupBaseline(args.tier, args.benchmark);
  const score = samples.length === 0 ? 0 : total / samples.length;
  const baselineScore = baseline?.score ?? null;
  return {
    schemaVersion: "vision-language-bench-v1",
    tier: args.tier,
    benchmark: args.benchmark,
    generatedAt: new Date().toISOString(),
    sample_count: samples.length,
    score,
    baseline_score: baselineScore,
    delta: baselineScore === null ? null : score - baselineScore,
    runtime_seconds: runtimeSec,
    error_count: errorCount,
    samples: sampleResults,
  };
}

function reportPath(tier: string, benchmark: BenchmarkName, override?: string): string {
  if (override) return override;
  const date = new Date().toISOString().slice(0, 10);
  return join(PACKAGE_ROOT, "results", `${tier}-${benchmark}-${date}.json`);
}

function writeReport(report: BenchReport, override?: string): string {
  const target = reportPath(report.tier, report.benchmark, override);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(report, null, 2));
  return target;
}

function renderSummary(report: BenchReport): string {
  const baseline = report.baseline_score === null
    ? "n/a"
    : (report.baseline_score * 100).toFixed(1) + "%";
  const delta = report.delta === null
    ? "n/a"
    : `${report.delta >= 0 ? "+" : ""}${(report.delta * 100).toFixed(1)}pp`;
  return [
    `[bench] ${report.tier} × ${report.benchmark}`,
    `  samples       : ${report.sample_count}`,
    `  score         : ${(report.score * 100).toFixed(1)}%`,
    `  baseline      : ${baseline}`,
    `  delta         : ${delta}`,
    `  errors        : ${report.error_count}`,
    `  runtime (sec) : ${report.runtime_seconds.toFixed(2)}`,
  ].join("\n");
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n${HELP}`,
    );
    process.exit(2);
  }
  process.stdout.write(
    `vision-language bench — tier=${args.tier} benchmarks=${args.benchmarks.join(",")} ` +
      `samples=${args.samples} smoke=${args.smoke}\n`,
  );
  const runtime = await resolveRuntime({
    tier: args.tier,
    forceStub: args.forceStub,
  });
  process.stdout.write(`runtime: ${runtime.id}\n`);
  const reports: BenchReport[] = [];
  for (const benchmark of args.benchmarks) {
    const report = await runOneBenchmark({
      tier: args.tier,
      benchmark,
      samples: args.samples,
      smoke: args.smoke,
      runtime,
    });
    const dest = writeReport(report, args.benchmarks.length === 1 ? args.output : undefined);
    process.stdout.write(`\n${renderSummary(report)}\nwrote ${dest}\n`);
    reports.push(report);
  }
  await runtime.cleanup?.();
  if (reports.some((r) => r.error_count > 0)) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(
      `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
