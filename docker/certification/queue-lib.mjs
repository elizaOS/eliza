/**
 * Pure state machine for the pipelined GPU job queue (#14549). Capture lanes
 * enqueue JSON job files as images/videos are produced; queue-worker.mjs (the
 * only fs/network shell) consumes them concurrently and calls the resident
 * gpu-vision service, so analysis finishes shortly after the last capture
 * instead of serializing behind it. Every decision the worker makes — job
 * validity, claim order, backpressure, unreachable-service draining, result
 * record shape — is a pure function here so the transitions are unit-testable
 * without a GPU, a filesystem, or a clock.
 *
 * Queue layout under the jobs root (one directory, no redis/sqlite):
 *   pending/<id>.json     enqueued job, claimed by rename into processing/
 *   processing/<id>.json  claimed job (rename is the atomic claim)
 *   done/<id>.json        consumed job file, kept for provenance
 *   results/<id>.json     result record: ok | failed | skipped — a skipped
 *                         record is an honest degradation marker, never a
 *                         fabricated success.
 */

export const QUEUE_DIRS = Object.freeze([
  "pending",
  "processing",
  "done",
  "results",
]);

export const DEFAULT_LIMITS = Object.freeze({
  // Enqueue backpressure: producers block/fail loudly instead of burying an
  // unreachable worker under thousands of jobs.
  maxPending: 256,
  // Consecutive unreachability past this window flips the worker into drain
  // mode: pending jobs become skip records instead of waiting forever.
  drainAfterMs: 120_000,
  pollMs: 500,
  requestTimeoutMs: 300_000,
});

export class QueueJobInvalidError extends Error {
  constructor(reason) {
    super(`[queue] invalid job: ${reason}`);
    this.name = "QueueJobInvalidError";
    this.reason = reason;
  }
}

/**
 * Parse an untrusted job file into a typed job. Throws QueueJobInvalidError
 * with the concrete defect — the worker records a `failed` result for the id
 * (when recoverable) rather than guessing at a fake-valid job (J3).
 */
export function parseJob(raw, knownModels) {
  let job;
  try {
    job = JSON.parse(raw);
  } catch {
    // error-policy:J3 malformed JSON in an untrusted job file becomes a typed
    // invalid signal the worker turns into a failed result record.
    throw new QueueJobInvalidError("not valid JSON");
  }
  if (typeof job !== "object" || job === null)
    throw new QueueJobInvalidError("not an object");
  if (typeof job.id !== "string" || job.id.length === 0) {
    throw new QueueJobInvalidError("missing id");
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(job.id)) {
    throw new QueueJobInvalidError(`id has unsafe characters: ${job.id}`);
  }
  if (typeof job.model !== "string" || !knownModels.includes(job.model)) {
    throw new QueueJobInvalidError(
      `model must be one of ${knownModels.join("|")}, got: ${job.model}`,
    );
  }
  if (typeof job.request !== "object" || job.request === null) {
    throw new QueueJobInvalidError(
      "missing request body (OpenAI chat.completions shape)",
    );
  }
  if (job.imagePath !== undefined) {
    if (typeof job.imagePath !== "string" || job.imagePath.length === 0) {
      throw new QueueJobInvalidError(
        "imagePath must be a non-empty string when present",
      );
    }
    if (job.imagePath.includes("..") || job.imagePath.startsWith("/")) {
      throw new QueueJobInvalidError(
        "imagePath must be relative to the jobs root, without ..",
      );
    }
  }
  return job;
}

/** Oldest-first claim order. Ids are enqueue-timestamp-prefixed, so a plain
 * lexicographic sort of filenames is the arrival order. */
export function claimOrder(fileNames) {
  return [...fileNames]
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));
}

/** Backpressure decision for enqueue: accept or refuse-with-reason. Refusal is
 * an explicit failure for the producer to handle — never a dropped job. */
export function decideEnqueue(pendingCount, maxPending) {
  if (pendingCount >= maxPending) {
    return {
      accept: false,
      reason: `backpressure: ${pendingCount} pending >= max ${maxPending}`,
    };
  }
  return { accept: true };
}

/** Initial worker connectivity state. */
export function createWorkerState() {
  return { unreachableSince: null, draining: false };
}

/**
 * Transition on a failed service call (network error / timeout). The first
 * failure stamps `unreachableSince`; once the outage outlasts `drainAfterMs`
 * the worker enters drain mode and starts writing skip records.
 */
export function onServiceUnreachable(state, nowMs, drainAfterMs) {
  const since = state.unreachableSince ?? nowMs;
  return {
    unreachableSince: since,
    draining: state.draining || nowMs - since >= drainAfterMs,
  };
}

/** Transition on a successful service contact: full reset out of drain mode. */
export function onServiceOk() {
  return createWorkerState();
}

/** In drain mode every job is skipped (honest degradation) instead of retried. */
export function shouldSkipJob(state) {
  return state.draining;
}

/**
 * Shape of the result record written beside the consumed job. Exactly one of
 * ok/failed/skipped; `skipped` carries the drain reason so downstream readers
 * can distinguish "GPU never analyzed this" from "analysis said nothing".
 */
export function resultRecord(job, outcome, completedAtIso) {
  if (!["ok", "failed", "skipped"].includes(outcome.status)) {
    throw new Error(`[queue] unknown outcome status: ${outcome.status}`);
  }
  const record = {
    schema: 1,
    id: job.id,
    model: job.model,
    status: outcome.status,
    completedAt: completedAtIso,
  };
  if (outcome.status === "ok") {
    record.durationMs = outcome.durationMs;
    record.response = outcome.response;
  } else {
    record.reason = outcome.reason;
  }
  return record;
}

/**
 * Substitute the `queue:image` placeholder URL in an OpenAI chat.completions
 * body with the data URI the worker built from the job's imagePath. Pure deep
 * walk; the original request is not mutated. Jobs may instead embed the data
 * URI directly and omit imagePath.
 */
export const IMAGE_PLACEHOLDER = "queue:image";

export function resolveImagePlaceholders(request, dataUri) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out = {};
      for (const [key, value] of Object.entries(node)) {
        out[key] =
          key === "url" && value === IMAGE_PLACEHOLDER ? dataUri : walk(value);
      }
      return out;
    }
    return node;
  };
  return walk(request);
}

/** Enqueue-side id: sortable timestamp prefix + entropy, filename-safe. */
export function makeJobId(nowMs, entropy) {
  const stamp = new Date(nowMs).toISOString().replace(/[-:.TZ]/g, "");
  return `${stamp}-${entropy}`;
}
