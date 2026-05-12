/**
 * Bench runner — drives N runs of M scenarios against a configured
 * pipeline driver and writes JSON results. CLI entry in `bin/voice-bench`.
 */

import { execSync } from "node:child_process";
import { hostname, platform, arch } from "node:os";
import { randomUUID } from "node:crypto";
import { MetricsCollector } from "./metrics.ts";
import { aggregate } from "./gates.ts";
import { buildScenarios, isScenarioId } from "./scenarios.ts";
import type {
  BenchMetrics,
  BenchRun,
  PipelineDriver,
} from "./types.ts";

export interface RunBenchOpts {
  driver: PipelineDriver;
  bundleId: string;
  /** Subset of scenario ids; falsy = run all. */
  scenarios?: string[];
  /** Per-scenario repetitions; the runner uses the median sample. */
  runs?: number;
  /** Override device label (defaults to hostname / platform / arch). */
  deviceLabel?: string;
  /** Override git sha (defaults to `git rev-parse HEAD` or "unknown"). */
  gitSha?: string;
  /** Sample resource usage at this cadence (ms). Defaults to 100. */
  resourceSampleMs?: number;
  /** External abort. */
  signal?: AbortSignal;
}

export async function runBench(opts: RunBenchOpts): Promise<BenchRun> {
  const runs = Math.max(1, Math.floor(opts.runs ?? 1));
  const scenarios = buildScenarios();
  const selected = opts.scenarios && opts.scenarios.length > 0
    ? scenarios.filter((s) => opts.scenarios!.includes(s.scenario.id))
    : scenarios;

  for (const id of opts.scenarios ?? []) {
    if (!isScenarioId(id)) {
      throw new Error(`[voice-bench] unknown scenario id: ${id}`);
    }
  }

  const allMetrics: BenchMetrics[] = [];
  for (const build of selected) {
    const samples: BenchMetrics[] = [];
    for (let i = 0; i < runs; i++) {
      const collector = new MetricsCollector({
        fixtureId: build.scenario.id,
        resourceSampleMs: opts.resourceSampleMs ?? 100,
      });
      const driverResult = await opts.driver.run({
        audio: build.audio,
        injection: build.scenario.injection,
        probe: collector.record,
        signal: opts.signal,
      });
      samples.push(collector.finalize(driverResult));
    }
    // Pick the median TTFA sample for reporting; keep all samples in raw
    // form via summary aggregates later if needed.
    samples.sort((a, b) => a.ttfaMs - b.ttfaMs);
    const median = samples[Math.floor(samples.length / 2)];
    if (median) allMetrics.push(median);
  }

  const aggregates = aggregate(allMetrics);
  return {
    runId: randomUUID(),
    timestamp: new Date().toISOString(),
    gitSha: opts.gitSha ?? readGitSha(),
    bundleId: opts.bundleId,
    backend: opts.driver.backend,
    deviceLabel: opts.deviceLabel ?? `${hostname()} (${platform()}/${arch()})`,
    fixtures: allMetrics,
    aggregates,
  };
}

function readGitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

export interface ParsedCliArgs {
  bundle: string;
  backend: string;
  scenario: string;
  runs: number;
  output: string | undefined;
  baseline: string | undefined;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      args[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[a.slice(2)] = next;
        i++;
      } else {
        args[a.slice(2)] = "true";
      }
    }
  }
  return {
    bundle: args.bundle ?? "eliza-1-2b",
    backend: args.backend ?? "real",
    scenario: args.scenario ?? "all",
    runs: Number.parseInt(args.runs ?? "1", 10) || 1,
    output: args.output,
    baseline: args.baseline,
  };
}
