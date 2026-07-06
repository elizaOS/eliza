/**
 * The GPU vision queue worker: the one process that consumes claimed jobs, runs
 * their `gpu`-tier analyzer against the resident vision service, and streams the
 * result back into each subject's `analysis.json` (#14543). It reuses the exact
 * analyzers from the registry — `ocr.unlimited` and friends already resolve the
 * service endpoint from `serve.json` / `ELIZA_GPU_VISION_URL` and report an
 * honest `skipped-missing-tool` when the host is unreachable — so the worker adds
 * only the queue concerns the analyzers cannot see: a hard per-job wall-clock
 * timeout, and drain-to-skip when the service stays down.
 *
 * Honest degradation is the core contract: while the service is reachable a
 * connectivity failure requeues the job (transient blips retry); once the outage
 * outlasts `drainAfterMs` the worker latches into drain mode and writes
 * `skipped` records — an image the GPU never analyzed is marked as such, and is
 * NEVER given a fabricated empty transcript. This module is library code: it
 * never touches `console`; observability is a caller-supplied `onEvent` hook.
 */

import {
  ANALYZERS,
  getAnalyzer,
  runAnalyzerInline,
} from "../analyzers/index.ts";
import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerInput,
  AnalyzerResult,
} from "../analyzers/types.ts";
import type { Tier } from "../schema.ts";
import { mergeAnalyzerResult } from "./analysis-merge.ts";
import type { ClaimedJob, FileJobQueue } from "./file-queue.ts";
import {
  createWorkerState,
  DEFAULT_LIMITS,
  drainSkipResult,
  isConnectivityFailure,
  type JobResult,
  onServiceOk,
  onServiceUnreachable,
  type QueueLimits,
  shouldDrain,
  type WorkerState,
} from "./state.ts";

/** What the worker did with one claimed job, for logging/tests. */
export type WorkerAction = "completed" | "failed" | "skipped" | "requeued";

/** Observable worker events; the CLI renders these, the library never logs. */
export type WorkerEvent =
  | { type: "claimed"; id: string; analyzerId: string }
  | { type: "processed"; id: string; action: WorkerAction; reason?: string }
  | { type: "idle" }
  | { type: "draining"; sinceMs: number };

export interface RunWorkerOptions {
  queue: FileJobQueue;
  /** Analyzer set to resolve job `analyzerId` against; defaults to the registry. */
  analyzers?: readonly Analyzer[];
  /** Run tier (gpu-tier analyzers require `gpu` or `full`). Default `gpu`. */
  tier?: Tier;
  limits?: Partial<QueueLimits>;
  /** Stops the loop when set; the loop finishes the in-flight job first. */
  signal?: AbortSignal;
  /** Return once the queue is empty instead of polling forever (tests/CLI drain). */
  stopWhenIdle?: boolean;
  /** Injectable clock for the drain timer (tests). */
  now?: () => number;
  onEvent?: (event: WorkerEvent) => void;
}

/** Dependencies {@link processJob} needs beyond the pure state. */
interface ProcessDeps {
  queue: FileJobQueue;
  analyzers: readonly Analyzer[];
  tier: Tier;
  limits: QueueLimits;
  now: () => number;
}

/** Outcome of processing one claimed job: the next worker state and what happened. */
export interface ProcessOutcome {
  state: WorkerState;
  action: WorkerAction;
  result: JobResult;
}

/**
 * Process exactly one claimed job and return the next worker state. Exposed for
 * unit tests that drive the transitions deterministically. Merges the analyzer
 * result into `analysis.json` and finalizes the job for every terminal action;
 * on a transient connectivity failure (before the drain threshold) it requeues
 * the job instead, so a brief service blip retries rather than losing the image.
 */
export async function processJob(
  claimed: ClaimedJob,
  deps: ProcessDeps,
  state: WorkerState,
): Promise<ProcessOutcome> {
  const { queue, analyzers, tier, limits, now } = deps;
  const { job } = claimed;

  // Already draining: skip without touching the (known-dead) service.
  if (shouldDrain(state)) {
    const result = drainSkipResult(
      `gpu vision service unreachable; queue draining (job ${job.id} skipped)`,
    );
    return finalize(claimed, deps, state, "skipped", result);
  }

  const analyzer = resolveAnalyzer(job.analyzerId, analyzers);
  if (!analyzer) {
    // Unknown analyzer id is a job-authoring bug, not a service outage: fail the
    // job honestly (never a skip, which would imply the GPU was the problem).
    const result: AnalyzerResult = {
      status: "failed",
      reason: `unknown analyzer id '${job.analyzerId}'`,
      durationMs: 0,
    };
    return finalize(claimed, deps, onServiceOk(), "failed", result);
  }

  const input: AnalyzerInput = {
    entry: {
      path: job.artifact,
      // These carry no analyzer-visible meaning for image analyzers; the image
      // bytes are read from absolutePath. Kept schema-valid for provenance.
      sha256: "0".repeat(64),
      bytes: 0,
      kind: job.kind,
      source: "queue",
      producedBy: "gpu-queue",
      createdAt: job.enqueuedAt,
    },
    absolutePath: job.imagePath,
  };
  const ctx: AnalyzerContext = { tier };

  const result = await withHardTimeout(
    runAnalyzerInline(analyzer, input, ctx),
    limits.jobTimeoutMs,
    () => ({
      status: "failed" as const,
      reason: `analyzer '${job.analyzerId}' exceeded ${limits.jobTimeoutMs}ms hard timeout`,
      durationMs: limits.jobTimeoutMs,
    }),
  );

  if (isConnectivityFailure(result)) {
    const nextState = onServiceUnreachable(state, now(), limits.drainAfterMs);
    if (shouldDrain(nextState)) {
      // Outage outlasted the window: consume the job as an honest skip.
      return finalize(claimed, deps, nextState, "skipped", result);
    }
    // Transient: put the job back for a later retry once the service returns.
    queue.unclaim(claimed);
    return {
      state: nextState,
      action: "requeued",
      result: toJobResult(job.id, job.analyzerId, "skipped", result),
    };
  }

  const action: WorkerAction =
    result.status === "failed" ? "failed" : "completed";
  return finalize(claimed, deps, onServiceOk(), action, result);
}

/** Merge the result, finalize the job in the queue, and build the outcome. */
function finalize(
  claimed: ClaimedJob,
  deps: ProcessDeps,
  state: WorkerState,
  action: WorkerAction,
  result: AnalyzerResult,
): ProcessOutcome {
  const { job } = claimed;
  // Every terminal action records the analyzer result into analysis.json —
  // including a skip/failure, so the document honestly shows the GPU analyzer
  // was attempted and why it produced no data.
  mergeAnalyzerResult({
    analysisPath: job.analysisPath,
    artifact: job.artifact,
    analyzerId: job.analyzerId,
    result,
  });
  const status =
    action === "completed"
      ? "completed"
      : action === "failed"
        ? "failed"
        : "skipped";
  const jobResult = toJobResult(job.id, job.analyzerId, status, result);
  deps.queue.complete(claimed, jobResult);
  return { state, action, result: jobResult };
}

function toJobResult(
  id: string,
  analyzerId: string,
  status: JobResult["status"],
  analyzer: AnalyzerResult,
): JobResult {
  const record: JobResult = {
    schema: 1,
    id,
    analyzerId,
    status,
    completedAt: new Date().toISOString(),
  };
  if (status === "skipped") {
    record.reason = analyzer.reason;
  } else {
    record.analyzer = analyzer;
    if (analyzer.status === "failed") record.reason = analyzer.reason;
  }
  return record;
}

/**
 * Drain the queue: claim and process jobs until interrupted, or — when
 * `stopWhenIdle` — until the queue is empty. Returns the per-action counts. The
 * loop sleeps `pollMs` when idle or after a requeue so a dead service is not
 * hammered in a tight spin.
 */
export async function runQueueWorker(
  options: RunWorkerOptions,
): Promise<Record<WorkerAction, number>> {
  const limits: QueueLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const deps: ProcessDeps = {
    queue: options.queue,
    analyzers: options.analyzers ?? ANALYZERS,
    tier: options.tier ?? "gpu",
    limits,
    now: options.now ?? Date.now,
  };
  const emit = options.onEvent ?? (() => {});
  const counts: Record<WorkerAction, number> = {
    completed: 0,
    failed: 0,
    skipped: 0,
    requeued: 0,
  };
  let state = createWorkerState();

  while (!options.signal?.aborted) {
    const claimed = deps.queue.claim();
    if (!claimed) {
      emit({ type: "idle" });
      // When draining, a requeued job is the only thing that could reappear; if
      // nothing is pending there is nothing left to drain, so idle-stop applies
      // to drain mode too and the loop terminates instead of spinning forever.
      if (options.stopWhenIdle) break;
      await sleep(limits.pollMs, options.signal);
      continue;
    }
    emit({
      type: "claimed",
      id: claimed.job.id,
      analyzerId: claimed.job.analyzerId,
    });
    const outcome = await processJob(claimed, deps, state);
    state = outcome.state;
    counts[outcome.action] += 1;
    emit({
      type: "processed",
      id: claimed.job.id,
      action: outcome.action,
      reason: outcome.result.reason,
    });
    if (shouldDrain(state) && state.unreachableSince !== null) {
      emit({ type: "draining", sinceMs: state.unreachableSince });
    }
    if (outcome.action === "requeued") {
      // Back off before the job is eligible to be reclaimed, so a transient
      // outage retries at the poll cadence rather than in a busy loop.
      if (options.stopWhenIdle) break;
      await sleep(limits.pollMs, options.signal);
    }
  }
  return counts;
}

/** Registry lookup restricted to a caller-supplied analyzer set. */
function resolveAnalyzer(
  id: string,
  analyzers: readonly Analyzer[],
): Analyzer | undefined {
  if (analyzers === ANALYZERS) return getAnalyzer(id);
  return analyzers.find((a) => a.name === id);
}

/** Race a promise against a wall-clock deadline; on timeout return `onTimeout()`. */
async function withHardTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
