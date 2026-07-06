/**
 * CLI for the GPU vision job queue: `worker` drains a queue root, running each
 * job's gpu-tier analyzer against the resident vision service and merging the
 * result into the subject's `analysis.json`; `enqueue` adds one image job (a
 * scripting convenience — capture lanes normally use the programmatic
 * {@link FileJobQueue} API). Like the other evidence CLIs this is a thin process
 * boundary: it parses argv, drives the library, and prints an honest summary.
 * The queue library never logs — every line here comes from an injected
 * {@link CliIo}, so worker progress is the product's stdout, not a console call.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { EvidenceError } from "../errors.ts";
import type { ArtifactKind } from "../schema.ts";
import { FileJobQueue } from "./file-queue.ts";
import { DEFAULT_LIMITS } from "./state.ts";
import { runQueueWorker, type WorkerEvent } from "./worker.ts";

const USAGE = `Usage:
  evidence:gpu-queue worker  -- --root <queue-dir> [--tier <gpu|full>] [--drain-after-ms <n>] [--job-timeout-ms <n>] [--poll-ms <n>] [--once]
  evidence:gpu-queue enqueue -- --root <queue-dir> --image <path> --analyzer <id> --artifact <bundle-path> --analysis <path> [--kind <screenshot|keyframe>]

worker   Drain the queue: run each job's gpu-tier analyzer against the resident
         vision service and stream results into analysis.json. --once returns
         when the queue is empty (CI drain); default polls until interrupted.
enqueue  Add one image job to the queue (capture lanes use the FileJobQueue API).`;

/** Output sinks; injectable so tests capture instead of spawning a process. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

interface ParsedArgs {
  values: Map<string, string>;
  flags: Set<string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.add(key);
    } else {
      values.set(key, next);
      i++;
    }
  }
  return { values, flags };
}

function required(args: ParsedArgs, key: string): string {
  const value = args.values.get(key);
  if (value === undefined) {
    throw new EvidenceError(`missing required --${key}`, { code: "CLI_USAGE" });
  }
  return value;
}

function intOr(args: ParsedArgs, key: string, fallback: number): number {
  const raw = args.values.get(key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new EvidenceError(`--${key} must be a non-negative integer`, {
      code: "CLI_USAGE",
    });
  }
  return value;
}

function imageKindOrDefault(args: ParsedArgs): ArtifactKind {
  const kind = args.values.get("kind") ?? "screenshot";
  if (kind !== "screenshot" && kind !== "keyframe") {
    throw new EvidenceError(
      `--kind must be screenshot or keyframe, got: ${kind}`,
      { code: "CLI_USAGE" },
    );
  }
  return kind;
}

async function runWorkerCommand(argv: string[], io: CliIo): Promise<number> {
  const args = parseArgs(argv);
  const root = required(args, "root");
  const tier = (args.values.get("tier") ?? "gpu") as "gpu" | "full";
  if (tier !== "gpu" && tier !== "full") {
    throw new EvidenceError("--tier must be gpu or full", {
      code: "CLI_USAGE",
    });
  }
  const queue = new FileJobQueue(root);
  io.out(`[gpu-queue] worker draining ${root} at tier=${tier}`);

  const onEvent = (event: WorkerEvent): void => {
    if (event.type === "claimed") {
      io.out(`[gpu-queue] claimed ${event.id} (${event.analyzerId})`);
    } else if (event.type === "processed") {
      io.out(
        `[gpu-queue] ${event.action} ${event.id}${event.reason ? ` — ${event.reason}` : ""}`,
      );
    } else if (event.type === "draining") {
      io.err(
        `[gpu-queue] service unreachable since ${new Date(event.sinceMs).toISOString()} — draining pending jobs to skip`,
      );
    }
  };

  const counts = await runQueueWorker({
    queue,
    tier,
    stopWhenIdle: args.flags.has("once"),
    limits: {
      drainAfterMs: intOr(args, "drain-after-ms", DEFAULT_LIMITS.drainAfterMs),
      jobTimeoutMs: intOr(args, "job-timeout-ms", DEFAULT_LIMITS.jobTimeoutMs),
      pollMs: intOr(args, "poll-ms", DEFAULT_LIMITS.pollMs),
    },
    onEvent,
  });
  io.out(
    `[gpu-queue] done: ${counts.completed} completed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.requeued} requeued`,
  );
  return 0;
}

function runEnqueueCommand(argv: string[], io: CliIo): number {
  const args = parseArgs(argv);
  const root = required(args, "root");
  const kind = imageKindOrDefault(args);
  const queue = new FileJobQueue(root);
  const job = queue.enqueue(
    required(args, "image"),
    required(args, "analyzer"),
    {
      artifact: required(args, "artifact"),
      kind,
      analysisPath: required(args, "analysis"),
    },
  );
  io.out(`[gpu-queue] enqueued ${job.id} (${job.analyzerId})`);
  return 0;
}

/** Parse argv (without node/script prefix) and run; returns the exit code. */
export async function runQueueCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "worker") return await runWorkerCommand(rest, io);
    if (command === "enqueue") return runEnqueueCommand(rest, io);
    io.err(USAGE);
    return command === undefined || command === "--help" || command === "-h"
      ? 0
      : 1;
  } catch (error) {
    // error-policy:J1 process boundary — translate typed failures into a
    // structured stderr line + non-zero exit for the invoking harness.
    if (error instanceof EvidenceError) {
      io.err(`error [${error.code}]: ${error.message}`);
      if (error.code === "CLI_USAGE") io.err(USAGE);
      return 1;
    }
    throw error;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const io: CliIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
  process.exitCode = await runQueueCli(process.argv.slice(2), io);
}
