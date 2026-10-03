/**
 * `AnalyzerExecutor` that routes `gpu`-tier analyzers through the job queue
 * instead of running them in-process (#14543). Plugged into the analyzer runner
 * via `AnalyzeOptions.executor`, it lets a certification run offload OCR/VLM work
 * to a resident GPU worker (`worker.ts`) — one model load shared across every
 * image — while cpu-tier analyzers still run inline. `cpu` analyzers and any
 * analyzer above the run tier are delegated to the wrapped inline executor
 * unchanged, so behaviour is identical except for where the GPU work executes.
 *
 * For a routed analyzer the executor enqueues a job against a private scratch
 * `analysis.json`, then polls for the worker's result. If no worker produces a
 * result within `resultTimeoutMs` (no GPU box attached, worker crashed) it
 * returns an honest `skipped-missing-tool` record naming the missing worker —
 * NEVER a fabricated empty analysis. The runner writes whatever record comes
 * back into the real bundle document as usual.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerExecutor,
  AnalyzerInput,
  AnalyzerResult,
} from "../analyzers/index.ts";
import { INLINE_EXECUTOR, tierRunnable } from "../analyzers/index.ts";
import type { FileJobQueue } from "./file-queue.ts";

export interface QueueExecutorOptions {
  /** Executor for cpu-tier / out-of-tier analyzers. Default: inline. */
  inline?: AnalyzerExecutor;
  /** How long to wait for a worker result before an honest skip. */
  resultTimeoutMs?: number;
  /** Poll interval while waiting for a worker result. */
  pollMs?: number;
  /** Directory for the per-job scratch `analysis.json`. Default: os tmp. */
  scratchDir?: string;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable sleeper (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Routes a subset of analyzers through {@link FileJobQueue}; the wrapped inline
 * executor handles the rest. A single instance is safe to share across a runner
 * pass — it holds no per-job state.
 */
export class QueueExecutor implements AnalyzerExecutor {
  private readonly queue: FileJobQueue;
  private readonly inline: AnalyzerExecutor;
  private readonly resultTimeoutMs: number;
  private readonly pollMs: number;
  private readonly scratchDir: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(queue: FileJobQueue, options: QueueExecutorOptions = {}) {
    this.queue = queue;
    this.inline = options.inline ?? INLINE_EXECUTOR;
    this.resultTimeoutMs = options.resultTimeoutMs ?? 300_000;
    this.pollMs = options.pollMs ?? 250;
    this.scratchDir =
      options.scratchDir ??
      fs.mkdtempSync(path.join(os.tmpdir(), "evidence-queue-exec-"));
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    fs.mkdirSync(this.scratchDir, { recursive: true });
  }

  async execute(
    analyzer: Analyzer,
    input: AnalyzerInput,
    ctx: AnalyzerContext,
  ): Promise<AnalyzerResult> {
    // Only gpu-tier analyzers that are actually runnable at this tier are worth
    // offloading; cpu analyzers and above-tier ones keep their inline semantics
    // (the inline executor emits the correct `skipped-tier` record for the latter).
    if (analyzer.tier === "cpu" || !tierRunnable(analyzer.tier, ctx.tier)) {
      return this.inline.execute(analyzer, input, ctx);
    }

    const analysisPath = path.join(
      this.scratchDir,
      `${sanitize(analyzer.name)}-${this.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    const job = this.queue.enqueue(input.absolutePath, analyzer.name, {
      artifact: input.entry.path,
      kind: input.entry.kind,
      analysisPath,
    });

    const deadline = this.now() + this.resultTimeoutMs;
    while (this.now() < deadline) {
      const record = this.queue.readResult(job.id);
      if (record) {
        // The worker already merged the analyzer record; hand it straight back
        // so the runner writes it into the real bundle document.
        if (record.analyzer) return record.analyzer;
        return {
          status: "skipped-missing-tool",
          reason:
            record.reason ?? `queue job ${job.id} produced no analyzer record`,
          durationMs: 0,
        };
      }
      await this.sleep(this.pollMs);
    }
    // No worker consumed the job in time: honest skip naming the missing worker,
    // never a fabricated result. The job stays enqueued for a worker that may
    // still attach; this run just does not block on it.
    return {
      status: "skipped-missing-tool",
      reason: `no gpu queue worker produced a result for '${analyzer.name}' within ${this.resultTimeoutMs}ms (is a worker running? evidence:gpu-queue)`,
      durationMs: this.resultTimeoutMs,
    };
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
