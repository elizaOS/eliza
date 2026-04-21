#!/usr/bin/env bun
/**
 * Benchmark Comparison Tool
 *
 * Reads JSON result files from all three runtimes and generates
 * a side-by-side comparison report with relative performance ratios.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

interface LatencyStats {
  min_ms: number;
  max_ms: number;
  avg_ms: number;
  median_ms: number;
  p95_ms: number;
  p99_ms: number;
  stddev_ms: number;
}

interface ThroughputStats {
  messages_per_second: number;
  total_messages: number;
  total_time_ms: number;
}

interface PipelineBreakdown {
  compose_state_avg_ms: number;
  provider_execution_avg_ms: number;
  should_respond_avg_ms: number;
  model_call_avg_ms: number;
  action_dispatch_avg_ms: number;
  evaluator_avg_ms: number;
  memory_create_avg_ms: number;
  memory_get_avg_ms: number;
}

interface ResourceStats {
  memory_rss_start_mb: number;
  memory_rss_peak_mb: number;
  memory_rss_end_mb: number;
  memory_delta_mb: number;
}

interface ScenarioResult {
  iterations: number;
  warmup: number;
  latency: LatencyStats;
  throughput: ThroughputStats;
  pipeline: PipelineBreakdown;
  resources: ResourceStats;
}

interface SystemInfo {
  os: string;
  arch: string;
  cpus: number;
  memory_gb: number;
  runtime_version: string;
}

interface BenchmarkResult {
  runtime: string;
  timestamp: string;
  system: SystemInfo;
  scenarios: Record<string, ScenarioResult>;
  binary_size_bytes?: number;
}

type RuntimeName = "typescript" | "python" | "rust";

// ─── Helpers ────────────────────────────────────────────────────────────────

function pad(str: string, width: number): string {
  return str.padEnd(width);
}

function rpad(str: string, width: number): string {
  return str.padStart(width);
}

function formatMs(ms: number): string {
  if (ms === 0) return "-";
  if (ms < 0.001) return `${(ms * 1_000_000).toFixed(0)}ns`;
  if (ms < 1) return `${(ms * 1000).toFixed(0)}us`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatMsgPerSec(mps: number): string {
  if (mps === 0) return "-";
  if (mps > 1000) return `${(mps / 1000).toFixed(1)}K`;
  return mps.toFixed(1);
}

function formatMb(mb: number): string {
  if (mb === 0) return "-";
  return `${mb.toFixed(1)}MB`;
}

function ratio(value: number, best: number): string {
  if (best === 0 || value === 0) return "-";
  const r = value / best;
  if (Math.abs(r - 1.0) < 0.01) return "1.0x";
  return `${r.toFixed(1)}x`;
}

// ─── Find latest result file for each runtime ──────────────────────────────

function findLatestResults(resultsDir: string): Map<RuntimeName, BenchmarkResult> {
  const results = new Map<RuntimeName, BenchmarkResult>();
  const files = readdirSync(resultsDir).filter((f) => f.endsWith(".json") && f !== ".gitkeep");

  const runtimeFiles: Record<string, string[]> = {
    typescript: [],
    python: [],
    rust: [],
  };

  for (const file of files) {
    for (const runtime of ["typescript", "python", "rust"]) {
      if (file.startsWith(runtime)) {
        runtimeFiles[runtime].push(file);
      }
    }
  }

  for (const [runtime, fileList] of Object.entries(runtimeFiles)) {
    if (fileList.length === 0) continue;
    // Sort by name (timestamp in filename) and take latest
    fileList.sort();
    const latest = fileList[fileList.length - 1];
    const raw = readFileSync(resolve(resultsDir, latest), "utf-8");
    results.set(runtime as RuntimeName, JSON.parse(raw));
  }

  return results;
}

// ─── Comparison report ──────────────────────────────────────────────────────

function printComparison(results: Map<RuntimeName, BenchmarkResult>): void {
  const runtimes = Array.from(results.keys()).sort();
  if (runtimes.length === 0) {
    console.log("No benchmark results found in results/ directory.");
    return;
  }

  // Header
  const first = results.get(runtimes[0])!;
  console.log("╔══════════════════════════════════════════════════════════════════════════╗");
  console.log("║                    Eliza Framework Benchmark Comparison                 ║");
  console.log("╠══════════════════════════════════════════════════════════════════════════╣");
  console.log(`║  Date: ${first.timestamp.split("T")[0]}                                                        ║`);
  console.log(`║  System: ${first.system.os} ${first.system.arch}                                       ║`.slice(0, 76) + "║");
  console.log(`║  CPUs: ${first.system.cpus} | RAM: ${first.system.memory_gb}GB                                              ║`.slice(0, 76) + "║");
  console.log("╚══════════════════════════════════════════════════════════════════════════╝");
  console.log();

  // Runtime versions
  console.log("Runtime Versions:");
  for (const rt of runtimes) {
    const r = results.get(rt)!;
    console.log(`  ${rt}: ${r.system.runtime_version}`);
  }
  console.log();

  // Binary/bundle sizes
  const hasSizes = runtimes.some((rt) => results.get(rt)!.binary_size_bytes);
  if (hasSizes) {
    console.log("Bundle/Binary Size:");
    for (const rt of runtimes) {
      const size = results.get(rt)!.binary_size_bytes;
      if (size) {
        console.log(`  ${rt}: ${(size / 1024).toFixed(1)}KB`);
      }
    }
    console.log();
  }

  // Collect all scenario IDs across all runtimes
  const allScenarioIds = new Set<string>();
  for (const [, result] of results) {
    for (const id of Object.keys(result.scenarios)) {
      allScenarioIds.add(id);
    }
  }

  const scenarioIds = Array.from(allScenarioIds).sort();

  // Per-scenario comparison
  const COL_W = 14;
  const METRIC_W = 22;

  for (const scenarioId of scenarioIds) {
    const scenarioResults = new Map<RuntimeName, ScenarioResult>();
    for (const rt of runtimes) {
      const r = results.get(rt)!.scenarios[scenarioId];
      if (r) scenarioResults.set(rt, r);
    }

    if (scenarioResults.size === 0) continue;

    const activeRuntimes = Array.from(scenarioResults.keys());

    console.log(`━━━ ${scenarioId} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`.slice(0, 72));

    // Table header
    const header = pad("Metric", METRIC_W) + activeRuntimes.map((rt) => rpad(rt, COL_W)).join("  ");
    console.log(header);
    console.log("─".repeat(header.length));

    // Latency metrics
    const avgValues = activeRuntimes.map((rt) => scenarioResults.get(rt)!.latency.avg_ms);
    const bestAvg = Math.min(...avgValues.filter((v) => v > 0));

    const p95Values = activeRuntimes.map((rt) => scenarioResults.get(rt)!.latency.p95_ms);
    const bestP95 = Math.min(...p95Values.filter((v) => v > 0));

    const p99Values = activeRuntimes.map((rt) => scenarioResults.get(rt)!.latency.p99_ms);
    const bestP99 = Math.min(...p99Values.filter((v) => v > 0));

    console.log(
      pad("Avg Latency", METRIC_W) +
        activeRuntimes
          .map((rt, i) => rpad(`${formatMs(avgValues[i])} (${ratio(avgValues[i], bestAvg)})`, COL_W))
          .join("  "),
    );
    console.log(
      pad("P95 Latency", METRIC_W) +
        activeRuntimes
          .map((rt, i) => rpad(`${formatMs(p95Values[i])} (${ratio(p95Values[i], bestP95)})`, COL_W))
          .join("  "),
    );
    console.log(
      pad("P99 Latency", METRIC_W) +
        activeRuntimes
          .map((rt, i) => rpad(`${formatMs(p99Values[i])} (${ratio(p99Values[i], bestP99)})`, COL_W))
          .join("  "),
    );

    // Throughput
    const tpValues = activeRuntimes.map((rt) => scenarioResults.get(rt)!.throughput.messages_per_second);
    const bestTp = Math.max(...tpValues.filter((v) => v > 0));

    console.log(
      pad("Throughput (msg/s)", METRIC_W) +
        activeRuntimes
          .map((rt, i) => rpad(`${formatMsgPerSec(tpValues[i])} (${ratio(bestTp, tpValues[i])})`, COL_W))
          .join("  "),
    );

    // Memory
    const memValues = activeRuntimes.map((rt) => scenarioResults.get(rt)!.resources.memory_rss_peak_mb);
    const bestMem = Math.min(...memValues.filter((v) => v > 0));

    console.log(
      pad("Peak RSS", METRIC_W) +
        activeRuntimes
          .map((rt, i) => rpad(`${formatMb(memValues[i])} (${ratio(memValues[i], bestMem)})`, COL_W))
          .join("  "),
    );

    // Pipeline breakdown (if any non-zero values)
    const hasPipeline = activeRuntimes.some((rt) => {
      const pl = scenarioResults.get(rt)!.pipeline;
      return pl.compose_state_avg_ms > 0 || pl.model_call_avg_ms > 0;
    });

    if (hasPipeline) {
      console.log("  Pipeline:");
      const pipelineMetrics: [string, keyof PipelineBreakdown][] = [
        ["  compose_state", "compose_state_avg_ms"],
        ["  model_call", "model_call_avg_ms"],
        ["  action_dispatch", "action_dispatch_avg_ms"],
        ["  memory_ops", "memory_create_avg_ms"],
      ];

      for (const [label, key] of pipelineMetrics) {
        const vals = activeRuntimes.map((rt) => scenarioResults.get(rt)!.pipeline[key] as number);
        if (vals.every((v) => v === 0)) continue;
        const best = Math.min(...vals.filter((v) => v > 0));
        console.log(
          pad(label, METRIC_W) +
            activeRuntimes.map((_rt, i) => rpad(formatMs(vals[i]), COL_W)).join("  "),
        );
      }
    }

    console.log();
  }

  // ─── Category winners ───────────────────────────────────────────────────

  console.log("═══ Category Winners ═══════════════════════════════════════════════════");

  const categories: Record<string, RuntimeName | "tie"> = {};

  // Best average latency across single-message
  const singleMsg = "single-message";
  if (runtimes.every((rt) => results.get(rt)!.scenarios[singleMsg])) {
    let bestRt: RuntimeName = runtimes[0];
    let bestVal = Infinity;
    for (const rt of runtimes) {
      const val = results.get(rt)!.scenarios[singleMsg].latency.avg_ms;
      if (val > 0 && val < bestVal) {
        bestVal = val;
        bestRt = rt;
      }
    }
    categories["Lowest Latency"] = bestRt;
  }

  // Best throughput across burst-100
  const burst = "burst-100";
  if (runtimes.every((rt) => results.get(rt)!.scenarios[burst])) {
    let bestRt: RuntimeName = runtimes[0];
    let bestVal = 0;
    for (const rt of runtimes) {
      const val = results.get(rt)!.scenarios[burst].throughput.messages_per_second;
      if (val > bestVal) {
        bestVal = val;
        bestRt = rt;
      }
    }
    categories["Highest Throughput"] = bestRt;
  }

  // Lowest memory usage
  if (runtimes.every((rt) => results.get(rt)!.scenarios[singleMsg])) {
    let bestRt: RuntimeName = runtimes[0];
    let bestVal = Infinity;
    for (const rt of runtimes) {
      const val = results.get(rt)!.scenarios[singleMsg].resources.memory_rss_peak_mb;
      if (val > 0 && val < bestVal) {
        bestVal = val;
        bestRt = rt;
      }
    }
    categories["Lowest Memory"] = bestRt;
  }

  // Fastest startup
  const startup = "startup-cold";
  if (runtimes.every((rt) => results.get(rt)!.scenarios[startup])) {
    let bestRt: RuntimeName = runtimes[0];
    let bestVal = Infinity;
    for (const rt of runtimes) {
      const val = results.get(rt)!.scenarios[startup].latency.avg_ms;
      if (val > 0 && val < bestVal) {
        bestVal = val;
        bestRt = rt;
      }
    }
    categories["Fastest Startup"] = bestRt;
  }

  for (const [category, winner] of Object.entries(categories)) {
    console.log(`  ${pad(category + ":", 24)} ${winner}`);
  }

  console.log();
}

// ─── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const resultsDir = args.find((a) => a.startsWith("--dir="))?.split("=")[1]
  ?? resolve(import.meta.dir, "results");

const results = findLatestResults(resultsDir);
printComparison(results);
