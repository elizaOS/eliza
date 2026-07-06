#!/usr/bin/env node
/**
 * Filesystem GPU job-queue worker (#14549): the one long-running consumer in
 * the compose `gpu` profile. Watches `<jobs>/pending/`, claims jobs by rename
 * (atomic on one filesystem, so multiple producers and one worker never race),
 * POSTs each job's OpenAI-shaped request to the resident gpu-vision service,
 * and writes a result record beside the consumed job. All decision logic is
 * pure in queue-lib.mjs; this file is fs + fetch + clock.
 *
 * Degradation is explicit: while the service is unreachable, jobs bounce back
 * to pending and are retried; once the outage outlasts --drain-after-ms the
 * worker drains — every pending job becomes a `skipped` result record naming
 * the outage — so a run on a GPU-less/half-up machine finishes with honest
 * skip records instead of hanging or fabricating analyses.
 *
 * Usage:
 *   node docker/certification/queue-worker.mjs --jobs <dir>
 *     --service ocr=http://gpu-vision:8090 --service vlm=http://gpu-vision:8091
 *     [--poll-ms N] [--drain-after-ms N] [--request-timeout-ms N] [--once]
 *
 * Producers enqueue via the exported `enqueueJob(jobsRoot, job, limits)`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  claimOrder,
  createWorkerState,
  DEFAULT_LIMITS,
  decideEnqueue,
  makeJobId,
  onServiceOk,
  onServiceUnreachable,
  parseJob,
  QUEUE_DIRS,
  QueueJobInvalidError,
  resolveImagePlaceholders,
  resultRecord,
  shouldSkipJob,
} from "./queue-lib.mjs";

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export class QueueBackpressureError extends Error {
  constructor(reason) {
    super(`[queue] enqueue refused — ${reason}`);
    this.name = "QueueBackpressureError";
  }
}

export async function ensureQueueDirs(jobsRoot) {
  for (const dir of QUEUE_DIRS) {
    await fs.mkdir(path.join(jobsRoot, dir), { recursive: true });
  }
}

/**
 * Producer-side enqueue with max-pending backpressure. Writes the job file
 * atomically (tmp + rename) so the worker can never claim a half-written job.
 * Throws QueueBackpressureError instead of dropping work.
 */
export async function enqueueJob(jobsRoot, job, limits = DEFAULT_LIMITS) {
  await ensureQueueDirs(jobsRoot);
  const pendingDir = path.join(jobsRoot, "pending");
  const pending = claimOrder(await fs.readdir(pendingDir));
  const decision = decideEnqueue(pending.length, limits.maxPending);
  if (!decision.accept) throw new QueueBackpressureError(decision.reason);

  const id =
    typeof job.id === "string" && job.id.length > 0
      ? job.id
      : makeJobId(Date.now(), Math.random().toString(36).slice(2, 8));
  const record = { ...job, id, enqueuedAt: new Date().toISOString() };
  const tmpPath = path.join(jobsRoot, `.${id}.tmp`);
  await fs.writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, path.join(pendingDir, `${id}.json`));
  return id;
}

function parseServices(argv) {
  const services = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--service") continue;
    const spec = argv[i + 1];
    const eq = spec?.indexOf("=") ?? -1;
    if (eq === -1) {
      throw new Error(`[queue] --service expects model=baseUrl, got: ${spec}`);
    }
    services[spec.slice(0, eq)] = spec.slice(eq + 1).replace(/\/$/, "");
  }
  if (Object.keys(services).length === 0) {
    throw new Error("[queue] at least one --service model=baseUrl is required");
  }
  return services;
}

function flagValue(argv, name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = Number(argv[i + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `[queue] ${name} must be a positive number, got: ${argv[i + 1]}`,
    );
  }
  return value;
}

async function buildRequestBody(jobsRoot, job) {
  if (job.imagePath === undefined) return job.request;
  const imageFile = path.join(jobsRoot, job.imagePath);
  const ext = path.extname(imageFile).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new QueueJobInvalidError(
      `unsupported image extension: ${ext || "(none)"}`,
    );
  }
  const bytes = await fs.readFile(imageFile);
  return resolveImagePlaceholders(
    job.request,
    `data:${mime};base64,${bytes.toString("base64")}`,
  );
}

async function writeResult(jobsRoot, record) {
  const tmpPath = path.join(jobsRoot, `.${record.id}.result.tmp`);
  await fs.writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, path.join(jobsRoot, "results", `${record.id}.json`));
}

async function finishJob(jobsRoot, name, record) {
  await writeResult(jobsRoot, record);
  await fs.rename(
    path.join(jobsRoot, "processing", name),
    path.join(jobsRoot, "done", name),
  );
}

async function probeServices(services, timeoutMs) {
  for (const baseUrl of Object.values(services)) {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      throw new Error(`health ${response.status} from ${baseUrl}`);
  }
}

/**
 * Process one claimed job file. Returns "ok" | "failed" | "skipped" |
 * "unreachable"; only "unreachable" leaves the job in pending for retry.
 */
async function processClaimed(jobsRoot, name, raw, services, state, opts) {
  const idFromName = name.replace(/\.json$/, "");
  const nowIso = () => new Date().toISOString();

  let job;
  try {
    job = parseJob(raw, Object.keys(services));
  } catch (err) {
    if (!(err instanceof QueueJobInvalidError)) throw err;
    // An unparseable job can never succeed on retry; record the defect.
    await finishJob(
      jobsRoot,
      name,
      resultRecord(
        { id: idFromName, model: "unknown" },
        { status: "failed", reason: err.reason },
        nowIso(),
      ),
    );
    return "failed";
  }

  if (shouldSkipJob(state)) {
    await finishJob(
      jobsRoot,
      name,
      resultRecord(
        job,
        {
          status: "skipped",
          reason: `gpu service unreachable past ${opts.drainAfterMs}ms — drained`,
        },
        nowIso(),
      ),
    );
    return "skipped";
  }

  let body;
  try {
    body = await buildRequestBody(jobsRoot, job);
  } catch (err) {
    if (!(err instanceof QueueJobInvalidError) && err.code !== "ENOENT")
      throw err;
    await finishJob(
      jobsRoot,
      name,
      resultRecord(
        job,
        { status: "failed", reason: `image unreadable: ${err.message}` },
        nowIso(),
      ),
    );
    return "failed";
  }

  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(`${services[job.model]}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.requestTimeoutMs),
    });
  } catch (err) {
    // error-policy:J1 the service boundary: a network failure here is the
    // queue's designed retry/drain signal, observed via worker state + the
    // eventual skipped records — never a fabricated analysis.
    process.stderr.write(
      `[queue] ${job.id}: service unreachable (${err.message}) — will retry\n`,
    );
    await fs.rename(
      path.join(jobsRoot, "processing", name),
      path.join(jobsRoot, "pending", name),
    );
    return "unreachable";
  }

  const text = await response.text();
  if (!response.ok) {
    await finishJob(
      jobsRoot,
      name,
      resultRecord(
        job,
        {
          status: "failed",
          reason: `http ${response.status}: ${text.slice(0, 2000)}`,
        },
        nowIso(),
      ),
    );
    return "failed";
  }

  await finishJob(
    jobsRoot,
    name,
    resultRecord(
      job,
      {
        status: "ok",
        durationMs: Date.now() - startedAt,
        response: JSON.parse(text),
      },
      nowIso(),
    ),
  );
  return "ok";
}

export async function runWorker({ jobsRoot, services, opts, stopSignal }) {
  await ensureQueueDirs(jobsRoot);
  let state = createWorkerState();
  process.stdout.write(
    `[queue] worker up — jobs: ${jobsRoot}, services: ${Object.entries(services)
      .map(([model, url]) => `${model}=${url}`)
      .join(", ")}\n`,
  );

  while (!stopSignal.stopped) {
    const pendingDir = path.join(jobsRoot, "pending");
    const pending = claimOrder(await fs.readdir(pendingDir));

    if (pending.length === 0) {
      if (opts.once) return state;
      await new Promise((resolve) => setTimeout(resolve, opts.pollMs));
      continue;
    }

    // While unreachable (draining or not), probe health first so recovery is
    // detected without burning a job attempt, and drain time keeps accruing
    // even when no fetch is attempted.
    if (state.unreachableSince !== null) {
      try {
        await probeServices(services, Math.min(opts.requestTimeoutMs, 5000));
        state = onServiceOk();
        process.stdout.write(
          "[queue] gpu service reachable again — resuming\n",
        );
      } catch {
        // error-policy:J1 probe failure is the state machine's input, not an
        // error to escalate: it advances unreachableSince toward drain mode.
        state = onServiceUnreachable(state, Date.now(), opts.drainAfterMs);
      }
    }

    for (const name of pending) {
      if (stopSignal.stopped) return state;
      const processingPath = path.join(jobsRoot, "processing", name);
      let raw;
      try {
        await fs.rename(path.join(pendingDir, name), processingPath);
        raw = await fs.readFile(processingPath, "utf8");
      } catch (err) {
        if (err.code === "ENOENT") continue; // claimed by a concurrent worker
        throw err;
      }
      const outcome = await processClaimed(
        jobsRoot,
        name,
        raw,
        services,
        state,
        opts,
      );
      if (outcome === "unreachable") {
        state = onServiceUnreachable(state, Date.now(), opts.drainAfterMs);
        break; // stop hammering; retry after the poll interval / drain instead
      }
      if (outcome === "ok" || outcome === "failed") state = onServiceOk();
    }

    if (opts.once) {
      // --once runs until the queue is empty; jobs bounced back by an outage
      // keep the loop alive until they either succeed or drain to skips.
      const left = claimOrder(await fs.readdir(pendingDir));
      if (left.length === 0) return state;
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs));
  }
  return state;
}

async function main() {
  const argv = process.argv.slice(2);
  const jobsIdx = argv.indexOf("--jobs");
  if (jobsIdx === -1 || !argv[jobsIdx + 1]) {
    throw new Error("[queue] --jobs <dir> is required");
  }
  const jobsRoot = path.resolve(argv[jobsIdx + 1]);
  const services = parseServices(argv);
  const opts = {
    pollMs: flagValue(argv, "--poll-ms", DEFAULT_LIMITS.pollMs),
    drainAfterMs: flagValue(
      argv,
      "--drain-after-ms",
      DEFAULT_LIMITS.drainAfterMs,
    ),
    requestTimeoutMs: flagValue(
      argv,
      "--request-timeout-ms",
      DEFAULT_LIMITS.requestTimeoutMs,
    ),
    once: argv.includes("--once"),
  };

  const stopSignal = { stopped: false };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      process.stdout.write(
        `[queue] ${signal} — finishing current job then exiting\n`,
      );
      stopSignal.stopped = true;
    });
  }

  await runWorker({ jobsRoot, services, opts, stopSignal });
  process.stdout.write("[queue] worker stopped\n");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}
