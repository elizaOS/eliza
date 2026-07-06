/**
 * Filesystem-backed job queue for the evidence GPU vision lane (#14543). Wraps
 * the pure state machine (`state.ts`) in the one place that touches disk: it
 * writes enqueued jobs into `pending/`, claims them by ATOMIC RENAME into
 * `processing/` (the rename is the mutex — exactly one worker wins a job even
 * with many workers racing the same directory), and records terminal outcomes in
 * `results/` while retiring the consumed job file into `done/`.
 *
 * No redis, no sqlite: a directory tree is the entire coordination substrate, so
 * capture lanes and the worker can be separate processes (or separate machines
 * sharing a volume) with no broker. Backpressure and job validity are decided by
 * the pure functions in `state.ts`; this class only performs the moves.
 */

import fs from "node:fs";
import path from "node:path";
import type { ArtifactKind } from "../schema.ts";
import {
  claimOrder,
  decideEnqueue,
  type JobResult,
  makeJobId,
  parseJob,
  QUEUE_DIRS,
  QueueBackpressureError,
  type QueueJob,
  QueueJobInvalidError,
} from "./state.ts";

/** Params a capture lane supplies to enqueue one image for GPU analysis. */
export interface EnqueueParams {
  /** Bundle-relative artifact path (becomes `AnalyzerInput.entry.path`). */
  artifact: string;
  /** Artifact kind (`screenshot` | `keyframe`). */
  kind: ArtifactKind;
  /** Absolute path of the `analysis.json` the worker merges into. */
  analysisPath: string;
  /** Opaque analyzer params. */
  params?: Record<string, unknown>;
}

/** A job claimed from `pending/`, with the on-disk path of its processing copy. */
export interface ClaimedJob {
  job: QueueJob;
  /** Absolute path of the job file now under `processing/`. */
  processingPath: string;
}

export interface FileJobQueueOptions {
  /** Backpressure cap; enqueue throws {@link QueueBackpressureError} at/above it. */
  maxPending?: number;
  /** Injectable clock + entropy for deterministic ids in tests. */
  now?: () => number;
  entropy?: () => string;
}

export class FileJobQueue {
  readonly root: string;
  private readonly maxPending: number;
  private readonly now: () => number;
  private readonly entropy: () => string;

  constructor(root: string, options: FileJobQueueOptions = {}) {
    this.root = root;
    this.maxPending = options.maxPending ?? Number.POSITIVE_INFINITY;
    this.now = options.now ?? Date.now;
    this.entropy =
      options.entropy ?? (() => Math.random().toString(36).slice(2, 10));
    for (const dir of QUEUE_DIRS) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
  }

  private dir(name: (typeof QUEUE_DIRS)[number]): string {
    return path.join(this.root, name);
  }

  /** Count of jobs currently in `pending/`. */
  pendingCount(): number {
    return claimOrder(fs.readdirSync(this.dir("pending"))).length;
  }

  /**
   * Enqueue one image for analysis by `analyzerId`. Refuses with a
   * {@link QueueBackpressureError} when `pending/` is at capacity — an explicit
   * failure the producer handles, never a silently dropped job. The job file is
   * written to a temp name and renamed into place so a claiming worker never
   * observes a half-written pending job.
   */
  enqueue(
    imagePath: string,
    analyzerId: string,
    params: EnqueueParams,
  ): QueueJob {
    const decision = decideEnqueue(this.pendingCount(), this.maxPending);
    if (!decision.accept) {
      throw new QueueBackpressureError(this.pendingCount(), this.maxPending);
    }
    const nowMs = this.now();
    const job: QueueJob = {
      id: makeJobId(nowMs, this.entropy()),
      analyzerId,
      imagePath: path.resolve(imagePath),
      artifact: params.artifact,
      kind: params.kind,
      analysisPath: path.resolve(params.analysisPath),
      params: params.params,
      enqueuedAt: new Date(nowMs).toISOString(),
    };
    const dest = path.join(this.dir("pending"), `${job.id}.json`);
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`);
    fs.renameSync(tmp, dest);
    return job;
  }

  /**
   * Claim the oldest pending job by atomically renaming its file into
   * `processing/`. Returns null when nothing is pending. The rename is the
   * concurrency primitive: if two workers target the same file, exactly one
   * rename succeeds and the loser's `ENOENT` makes it try the next candidate, so
   * a job is never processed twice. A file that parses invalid is moved aside
   * with a `failed` result recorded and the claim continues past it.
   */
  claim(): ClaimedJob | null {
    for (const fileName of claimOrder(fs.readdirSync(this.dir("pending")))) {
      const from = path.join(this.dir("pending"), fileName);
      const to = path.join(this.dir("processing"), fileName);
      try {
        fs.renameSync(from, to);
      } catch (error) {
        // error-policy:J6 lost the atomic-claim race (another worker renamed
        // first) — ENOENT here is expected and simply advances to the next
        // candidate; any other error is a real fs fault and propagates.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const raw = fs.readFileSync(to, "utf8");
      let job: QueueJob;
      try {
        job = parseJob(raw);
      } catch (error) {
        if (error instanceof QueueJobInvalidError) {
          // Malformed job: record an honest failed result and retire the file so
          // the queue makes progress instead of wedging on a poison job.
          const id = fileName.replace(/\.json$/, "");
          this.recordInvalid(id, to, error);
          continue;
        }
        throw error;
      }
      return { job, processingPath: to };
    }
    return null;
  }

  /**
   * Finalize a claimed job: write its {@link JobResult} to `results/` and retire
   * the processing file into `done/`. The result is written before the job file
   * moves so a crash between the two leaves the outcome recorded, never lost.
   */
  complete(claimed: ClaimedJob, result: JobResult): void {
    this.writeResult(result);
    const done = path.join(
      this.dir("done"),
      path.basename(claimed.processingPath),
    );
    fs.renameSync(claimed.processingPath, done);
  }

  /**
   * Return a claimed job to `pending/` unprocessed — used when the GPU service
   * is transiently unreachable, so the job retries once it recovers instead of
   * being consumed as a skip. The rename back preserves the id-timestamp prefix,
   * so the job keeps its original FIFO position.
   */
  unclaim(claimed: ClaimedJob): void {
    const back = path.join(
      this.dir("pending"),
      path.basename(claimed.processingPath),
    );
    fs.renameSync(claimed.processingPath, back);
  }

  /** Read a job's result record, or null when it has not completed. */
  readResult(id: string): JobResult | null {
    const file = path.join(this.dir("results"), `${id}.json`);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      // error-policy:J4 absence probe — no result file means "not done yet",
      // an expected state the caller polls on, not an error.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return JSON.parse(raw) as JobResult;
  }

  private writeResult(result: JobResult): void {
    const dest = path.join(this.dir("results"), `${result.id}.json`);
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
    fs.renameSync(tmp, dest);
  }

  private recordInvalid(
    id: string,
    processingPath: string,
    error: QueueJobInvalidError,
  ): void {
    this.writeResult({
      schema: 1,
      id,
      analyzerId: "unknown",
      status: "failed",
      completedAt: new Date(this.now()).toISOString(),
      reason: error.message,
    });
    const done = path.join(this.dir("done"), path.basename(processingPath));
    fs.renameSync(processingPath, done);
  }
}
