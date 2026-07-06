/**
 * Pure state machine for the evidence GPU job queue (#14543). Capture lanes
 * enqueue one JSON job file per screenshot as it lands; the GPU worker
 * (`worker.ts`, the only fs/network shell) claims them, runs a `gpu`-tier
 * analyzer against the resident vision service, and merges the result back into
 * the subject's `analysis.json` — so analysis streams in as images appear
 * instead of serializing behind the last capture. Every decision the worker
 * makes — job validity, claim order, enqueue backpressure, unreachable-service
 * draining, result-record shape — is a pure function here so the transitions are
 * unit-testable with no GPU, no filesystem, and no wall clock.
 *
 * Layout under the jobs root (one directory tree, no redis/sqlite):
 *   pending/<id>.json     enqueued job, claimed by atomic rename into processing/
 *   processing/<id>.json  claimed job (the rename IS the claim; exactly one wins)
 *   done/<id>.json        consumed job file, retained for provenance
 *   results/<id>.json     result record: completed | failed | skipped — a
 *                         `skipped` record is an honest drain marker carrying the
 *                         reason the GPU never analyzed the image, NEVER fabricated
 *                         analyzer data (repo doctrine: "not loaded" ≠ "empty").
 */

import type { AnalyzerResult } from "../analyzers/types.ts";
import { EvidenceError, type ValidationIssue } from "../errors.ts";
import type { ArtifactKind } from "../schema.ts";

/** The four queue directories, created under the jobs root. */
export const QUEUE_DIRS = Object.freeze([
  "pending",
  "processing",
  "done",
  "results",
] as const);

/** Tunable limits for the worker loop and enqueue backpressure. */
export interface QueueLimits {
  /**
   * Enqueue backpressure cap: producers fail loudly once this many jobs are
   * pending instead of burying an unreachable worker under thousands of jobs.
   */
  maxPending: number;
  /**
   * Sustained unreachability past this window flips the worker into drain mode:
   * further claimed jobs become `skipped` records instead of waiting forever.
   */
  drainAfterMs: number;
  /** Idle poll interval when no job is pending. */
  pollMs: number;
  /** Hard per-job wall-clock ceiling; a hung analyze call is killed and failed. */
  jobTimeoutMs: number;
}

export const DEFAULT_LIMITS: Readonly<QueueLimits> = Object.freeze({
  maxPending: 256,
  drainAfterMs: 120_000,
  pollMs: 500,
  jobTimeoutMs: 180_000,
});

/**
 * A validated enqueued job. `imagePath` and `analysisPath` are absolute so the
 * worker can run regardless of its own cwd; `artifact` and `kind` reconstruct
 * the `AnalyzerInput.entry` the analyzer sees; `analyzerId` names the registry
 * analyzer to run (e.g. `ocr.unlimited`).
 */
export interface QueueJob {
  id: string;
  analyzerId: string;
  /** Absolute path to the image bytes to analyze. */
  imagePath: string;
  /** Bundle-relative artifact path, becomes `AnalyzerInput.entry.path`. */
  artifact: string;
  /** Artifact kind, becomes `AnalyzerInput.entry.kind`. */
  kind: ArtifactKind;
  /** Absolute path of the `analysis.json` the worker merges the result into. */
  analysisPath: string;
  /** Opaque analyzer params threaded through unchanged. */
  params?: Record<string, unknown>;
  enqueuedAt: string;
}

/** The three honest terminal outcomes for a job. */
export type JobOutcomeStatus = "completed" | "failed" | "skipped";

/**
 * Result record written to `results/<id>.json`. `completed` and `failed` carry
 * the exact {@link AnalyzerResult} that was (or will be) merged into
 * `analysis.json`; `skipped` is a drain marker with the reason the GPU service
 * was never reached — it never carries fabricated analyzer data.
 */
export interface JobResult {
  schema: 1;
  id: string;
  analyzerId: string;
  status: JobOutcomeStatus;
  completedAt: string;
  /** The merged analyzer record, present for `completed` and `failed`. */
  analyzer?: AnalyzerResult;
  /** Human reason, present for `failed` and `skipped`. */
  reason?: string;
}

/** Thrown by {@link parseJob} when an untrusted job file is not a valid job. */
export class QueueJobInvalidError extends EvidenceError {
  override readonly name = "QueueJobInvalidError";
  readonly issues: readonly ValidationIssue[];
  constructor(issues: readonly ValidationIssue[]) {
    super(`invalid queue job: ${issues.map((i) => i.message).join("; ")}`, {
      code: "QUEUE_JOB_INVALID",
      context: { issues },
    });
    this.issues = issues;
  }
}

/** Thrown by the file queue when enqueue is refused for backpressure. */
export class QueueBackpressureError extends EvidenceError {
  override readonly name = "QueueBackpressureError";
  constructor(pendingCount: number, maxPending: number) {
    super(`queue backpressure: ${pendingCount} pending >= max ${maxPending}`, {
      code: "QUEUE_BACKPRESSURE",
      context: { pendingCount, maxPending },
    });
  }
}

const ID_SHAPE = /^[a-zA-Z0-9._-]+$/;
const ARTIFACT_KINDS_WITH_PIXELS: ReadonlySet<string> = new Set([
  "screenshot",
  "keyframe",
]);

/**
 * Parse an untrusted job file into a typed {@link QueueJob}. Throws
 * {@link QueueJobInvalidError} listing every concrete defect — the worker turns
 * that into a `failed` result for the id rather than guessing at a fake-valid
 * job (error-policy J3: untrusted input yields an explicit invalid signal, never
 * a repaired default).
 */
export function parseJob(raw: string): QueueJob {
  const issues: ValidationIssue[] = [];
  const fail = (): never => {
    throw new QueueJobInvalidError(issues);
  };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    issues.push({ path: "", message: "not valid JSON" });
    return fail();
  }
  if (typeof value !== "object" || value === null) {
    issues.push({ path: "", message: "not an object" });
    return fail();
  }
  const job = value as Record<string, unknown>;

  const str = (key: string): string => {
    const v = job[key];
    if (typeof v !== "string" || v.length === 0) {
      issues.push({ path: key, message: `${key} must be a non-empty string` });
      return "";
    }
    return v;
  };

  const id = str("id");
  if (id && !ID_SHAPE.test(id)) {
    issues.push({ path: "id", message: `id has unsafe characters: ${id}` });
  }
  const analyzerId = str("analyzerId");
  const imagePath = str("imagePath");
  const artifact = str("artifact");
  const analysisPath = str("analysisPath");
  const enqueuedAt = str("enqueuedAt");

  const kind = job.kind;
  if (typeof kind !== "string" || !ARTIFACT_KINDS_WITH_PIXELS.has(kind)) {
    issues.push({
      path: "kind",
      message: `kind must be one of ${[...ARTIFACT_KINDS_WITH_PIXELS].join("|")}, got: ${String(kind)}`,
    });
  }
  if (
    job.params !== undefined &&
    (typeof job.params !== "object" ||
      job.params === null ||
      Array.isArray(job.params))
  ) {
    issues.push({
      path: "params",
      message: "params must be an object when present",
    });
  }

  if (issues.length > 0) return fail();

  return {
    id,
    analyzerId,
    imagePath,
    artifact,
    kind: kind as ArtifactKind,
    analysisPath,
    enqueuedAt,
    params: job.params as Record<string, unknown> | undefined,
  };
}

/**
 * Oldest-first claim order over a directory listing. Job ids are enqueue-time
 * prefixed (see {@link makeJobId}), so a lexicographic sort of `.json`
 * filenames is arrival order — the worker drains FIFO without reading files.
 */
export function claimOrder(fileNames: readonly string[]): string[] {
  return fileNames
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));
}

/** Backpressure decision for enqueue: accept, or refuse with a concrete reason. */
export function decideEnqueue(
  pendingCount: number,
  maxPending: number,
): { accept: true } | { accept: false; reason: string } {
  if (pendingCount >= maxPending) {
    return {
      accept: false,
      reason: `backpressure: ${pendingCount} pending >= max ${maxPending}`,
    };
  }
  return { accept: true };
}

/**
 * Worker connectivity state. `unreachableSince` is the wall-clock ms of the
 * first failed service contact in the current outage (null when healthy);
 * `draining` latches true once the outage outlasts `drainAfterMs`.
 */
export interface WorkerState {
  unreachableSince: number | null;
  draining: boolean;
}

/** Initial (healthy) worker connectivity state. */
export function createWorkerState(): WorkerState {
  return { unreachableSince: null, draining: false };
}

/**
 * Transition on a failed service contact (transport error / unreachable host).
 * The first failure stamps `unreachableSince`; once the outage outlasts
 * `drainAfterMs` the worker latches into drain mode and begins writing skip
 * records instead of retrying forever.
 */
export function onServiceUnreachable(
  state: WorkerState,
  nowMs: number,
  drainAfterMs: number,
): WorkerState {
  const since = state.unreachableSince ?? nowMs;
  return {
    unreachableSince: since,
    draining: state.draining || nowMs - since >= drainAfterMs,
  };
}

/** Transition on a successful service contact: full reset out of drain mode. */
export function onServiceOk(): WorkerState {
  return createWorkerState();
}

/** In drain mode every job is skipped (honest degradation) instead of retried. */
export function shouldDrain(state: WorkerState): boolean {
  return state.draining;
}

/**
 * Whether an {@link AnalyzerResult} status signals the GPU service is
 * unreachable (as opposed to a genuine analysis outcome). `skipped-missing-tool`
 * from a gpu analyzer means "endpoint unset / host down"; that is what feeds the
 * drain timer. `ran`/`failed`/`skipped-tier` are real contacts and reset it.
 */
export function isConnectivityFailure(result: AnalyzerResult): boolean {
  return result.status === "skipped-missing-tool";
}

/** Build the drain-skip {@link AnalyzerResult} merged for a job the worker never ran. */
export function drainSkipResult(reason: string): AnalyzerResult {
  return { status: "skipped-missing-tool", reason, durationMs: 0 };
}

/**
 * Enqueue-side id: a sortable UTC timestamp prefix plus entropy, filename-safe.
 * The prefix makes {@link claimOrder}'s lexicographic sort equal arrival order.
 */
export function makeJobId(nowMs: number, entropy: string): string {
  const stamp = new Date(nowMs).toISOString().replace(/[-:.TZ]/g, "");
  return `${stamp}-${entropy}`;
}
