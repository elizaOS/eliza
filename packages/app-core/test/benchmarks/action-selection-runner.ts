/**
 * Action selection benchmark runner.
 *
 * Given a real `AgentRuntime` and a list of `ActionBenchmarkCase`s, send each
 * user message through the runtime, capture the action the agent chose (via
 * the `outgoing_before_deliver` pipeline hook, which surfaces `actionName`
 * for every delivered action), score each case, and produce a report.
 *
 * Designed to be dependency-free beyond the runtime itself — does not assume
 * the Wave 1A action-spy / Wave 1B conversation-harness helpers have landed.
 * If/when they do, this runner can be refactored to use them directly without
 * changing its public API.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  type UUID,
} from "@elizaos/core";

import {
  isTrajectoryCaptureEnabled,
  RecordingHarness,
  type TrajectoryRecord,
} from "../helpers/trajectory-harness.ts";
import type { ActionBenchmarkCase } from "./action-selection-cases.ts";

export interface ActionBenchmarkResult {
  case: ActionBenchmarkCase;
  actualAction: string | null;
  pass: boolean;
  latencyMs: number;
  error?: string;
  /** Populated when trajectory capture is enabled (MILADY_DUMP_TRAJECTORIES=1). */
  trajectory?: TrajectoryRecord;
  /** Path to per-case trajectory JSON file when written. */
  trajectoryPath?: string;
}

export interface ActionBenchmarkLatencyStats {
  avg: number;
  p50: number;
  p95: number;
}

export interface ActionBenchmarkTagStats {
  total: number;
  passed: number;
  accuracy: number;
}

export interface ActionBenchmarkReport {
  total: number;
  passed: number;
  failed: number;
  accuracy: number;
  byTag: Record<string, ActionBenchmarkTagStats>;
  latency: ActionBenchmarkLatencyStats;
  failures: ActionBenchmarkResult[];
  results: ActionBenchmarkResult[];
}

export interface ActionBenchmarkRunOptions {
  runtime: AgentRuntime;
  cases: ActionBenchmarkCase[];
  /**
   * PGLite serializes writes — concurrency > 1 will deadlock on the single
   * local adapter. Defaults to 1 and is only exposed for future remote-DB use.
   */
  concurrency?: number;
  timeoutMsPerCase?: number;
  /**
   * Directory to write per-case trajectory JSON files. Only used when
   * trajectory capture is enabled (`MILADY_DUMP_TRAJECTORIES=1` or the
   * `forceTrajectoryCapture` flag).
   */
  trajectoryDir?: string;
  /** Force trajectory capture even when the env flag is not set. */
  forceTrajectoryCapture?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function normalizeActionName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  return trimmed.toUpperCase().replace(/[\s-]+/g, "_");
}

function caseMatches(
  actual: string | null,
  expected: string | null,
  acceptable: string[] | undefined,
): boolean {
  const actualNorm = normalizeActionName(actual);
  if (expected === null) {
    return actualNorm === null;
  }
  const expectedNorm = normalizeActionName(expected);
  if (actualNorm !== null && actualNorm === expectedNorm) return true;
  if (!acceptable) return false;
  for (const alt of acceptable) {
    if (actualNorm !== null && normalizeActionName(alt) === actualNorm) {
      return true;
    }
  }
  return false;
}

interface TurnCapture {
  firstAction: string | null;
}

/**
 * Run a single case against the runtime: register a one-shot hook that
 * captures the first action name delivered for this room, send the message,
 * wait for handling to complete (or timeout), and return the captured action.
 */
async function runSingleCaseWithRecording(
  runtime: AgentRuntime,
  tc: ActionBenchmarkCase,
  timeoutMs: number,
  trajectoryDir: string | undefined,
): Promise<ActionBenchmarkResult> {
  const started = Date.now();
  const harness = new RecordingHarness(runtime, {
    caseId: tc.id,
    source: "benchmark",
    userName: "BenchmarkUser",
    force: true,
  });
  let firstAction: string | null = null;
  try {
    await harness.setup();
    const turn = await harness.send(tc.userMessage, { timeoutMs });
    const completed = turn.actions.find((a) => a.phase === "completed");
    firstAction = completed?.actionName ?? null;
    const pass = caseMatches(
      firstAction,
      tc.expectedAction,
      tc.acceptableActions,
    );
    harness.setMetadata("expectedAction", tc.expectedAction);
    harness.setMetadata("actualAction", firstAction);
    harness.setMetadata("pass", pass);
    harness.setMetadata("tags", tc.tags);
    const trajectory = harness.dumpTrajectory();
    let trajectoryPath: string | undefined;
    if (trajectoryDir) {
      trajectoryPath = path.join(trajectoryDir, "cases", `${tc.id}.json`);
      await harness.writeTrajectoryToFile(trajectoryPath);
    }
    return {
      case: tc,
      actualAction: firstAction,
      pass,
      latencyMs: Date.now() - started,
      trajectory,
      trajectoryPath,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const trajectory = harness.dumpTrajectory();
    return {
      case: tc,
      actualAction: firstAction,
      pass: false,
      latencyMs: Date.now() - started,
      error: message,
      trajectory,
    };
  } finally {
    await harness.cleanup();
  }
}

async function runSingleCase(
  runtime: AgentRuntime,
  tc: ActionBenchmarkCase,
  timeoutMs: number,
): Promise<ActionBenchmarkResult> {
  const started = Date.now();
  const roomId = crypto.randomUUID() as UUID;
  const entityId = crypto.randomUUID() as UUID;
  const worldId = crypto.randomUUID() as UUID;

  const capture: TurnCapture = { firstAction: null };
  const hookId = `action-benchmark-${tc.id}-${roomId}`;

  try {
    await runtime.ensureConnection({
      entityId,
      roomId,
      worldId,
      userName: "BenchmarkUser",
      source: "benchmark",
      channelId: roomId,
      type: ChannelType.DM,
    });

    runtime.registerPipelineHook({
      id: hookId,
      phase: "outgoing_before_deliver",
      handler: (_runtime, ctx) => {
        if (ctx.phase !== "outgoing_before_deliver") return;
        if (ctx.roomId !== roomId) return;
        if (capture.firstAction !== null) return;
        const name = ctx.actionName;
        if (typeof name === "string" && name.trim().length > 0) {
          capture.firstAction = name;
        }
      },
    });

    const message = createMessageMemory({
      id: crypto.randomUUID() as UUID,
      entityId,
      roomId,
      content: {
        text: tc.userMessage,
        source: "benchmark",
        channelType: ChannelType.DM,
      },
    });

    const handlePromise = Promise.resolve(
      runtime.messageService?.handleMessage(
        runtime,
        message,
        async () => [],
      ),
    );

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `benchmark case ${tc.id} exceeded timeout ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      handlePromise
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err as Error);
        });
    });

    const pass = caseMatches(
      capture.firstAction,
      tc.expectedAction,
      tc.acceptableActions,
    );

    return {
      case: tc,
      actualAction: capture.firstAction,
      pass,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      case: tc,
      actualAction: capture.firstAction,
      pass: false,
      latencyMs: Date.now() - started,
      error: message,
    };
  } finally {
    try {
      runtime.unregisterPipelineHook(hookId);
    } catch {
      // Hook removal is best-effort; benchmark progress must not block on it.
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx] ?? 0;
}

export async function runActionSelectionBenchmark(
  opts: ActionBenchmarkRunOptions,
): Promise<ActionBenchmarkReport> {
  const timeoutMs = opts.timeoutMsPerCase ?? DEFAULT_TIMEOUT_MS;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const captureEnabled =
    opts.forceTrajectoryCapture === true || isTrajectoryCaptureEnabled();
  const trajectoryDir = captureEnabled ? opts.trajectoryDir : undefined;

  const runOne = (tc: ActionBenchmarkCase): Promise<ActionBenchmarkResult> =>
    captureEnabled
      ? runSingleCaseWithRecording(opts.runtime, tc, timeoutMs, trajectoryDir)
      : runSingleCase(opts.runtime, tc, timeoutMs);

  const results: ActionBenchmarkResult[] = [];

  if (concurrency === 1) {
    for (const tc of opts.cases) {
      results.push(await runOne(tc));
    }
  } else {
    let cursor = 0;
    const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i += 1) {
      workers.push(
        (async () => {
          while (cursor < opts.cases.length) {
            const myIdx = cursor;
            cursor += 1;
            const tc = opts.cases[myIdx];
            if (!tc) break;
            const res = await runOne(tc);
            results[myIdx] = res;
          }
        })(),
      );
    }
    await Promise.all(workers);
  }

  if (captureEnabled && trajectoryDir) {
    await writeTrajectoryIndexHtml(trajectoryDir, results);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;

  const byTag: Record<string, ActionBenchmarkTagStats> = {};
  for (const r of results) {
    for (const tag of r.case.tags) {
      const bucket = byTag[tag] ?? { total: 0, passed: 0, accuracy: 0 };
      bucket.total += 1;
      if (r.pass) bucket.passed += 1;
      byTag[tag] = bucket;
    }
  }
  for (const tag of Object.keys(byTag)) {
    const b = byTag[tag];
    if (!b) continue;
    b.accuracy = b.total === 0 ? 0 : b.passed / b.total;
  }

  const latencies = [...results.map((r) => r.latencyMs)].sort((a, b) => a - b);
  const avg =
    latencies.length === 0
      ? 0
      : latencies.reduce((sum, v) => sum + v, 0) / latencies.length;

  return {
    total: results.length,
    passed,
    failed,
    accuracy: results.length === 0 ? 0 : passed / results.length,
    byTag,
    latency: {
      avg,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
    },
    failures: results.filter((r) => !r.pass),
    results,
  };
}

export function formatBenchmarkReportMarkdown(
  report: ActionBenchmarkReport,
): string {
  const lines: string[] = [];
  lines.push("# Action Selection Benchmark");
  lines.push("");
  lines.push(
    `**Accuracy:** ${(report.accuracy * 100).toFixed(1)}% (${report.passed}/${report.total})`,
  );
  lines.push(
    `**Latency:** avg ${Math.round(report.latency.avg)}ms · p50 ${Math.round(
      report.latency.p50,
    )}ms · p95 ${Math.round(report.latency.p95)}ms`,
  );
  lines.push("");

  lines.push("## By tag");
  lines.push("");
  lines.push("| Tag | Passed | Total | Accuracy |");
  lines.push("| --- | ---: | ---: | ---: |");
  const tagEntries = Object.entries(report.byTag).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  for (const [tag, stats] of tagEntries) {
    lines.push(
      `| ${tag} | ${stats.passed} | ${stats.total} | ${(stats.accuracy * 100).toFixed(1)}% |`,
    );
  }
  lines.push("");

  if (report.failures.length > 0) {
    lines.push(`## Failures (${report.failures.length})`);
    lines.push("");
    lines.push("| Case | Expected | Actual | Error |");
    lines.push("| --- | --- | --- | --- |");
    for (const f of report.failures) {
      const expected =
        f.case.expectedAction === null ? "(no action)" : f.case.expectedAction;
      const actual = f.actualAction ?? "(none)";
      const err = f.error ? f.error.replace(/\|/g, "\\|") : "";
      lines.push(`| ${f.case.id} | ${expected} | ${actual} | ${err} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
