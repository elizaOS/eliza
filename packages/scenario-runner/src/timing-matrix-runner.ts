/**
 * Supervises resumable timing-evaluation shards and proves their exact merged
 * coverage. The runner is idempotent: complete shards are adopted, partial
 * shards resume, and every state transition is recorded atomically.
 */
import fs from "node:fs";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import {
  mergeTimingReports,
  type TimingMatrixReport,
} from "./timing-report-merge.ts";
import type { TimingInputFormat } from "./when2speak-eval.ts";

export type TimingShardProcessResult =
  | { kind: "exited"; exitCode: number }
  | { kind: "signaled"; signal: string };

export interface TimingShardInvocation {
  shardIndex: number;
  shardCount: number;
  attempt: number;
  report: string;
  trajectoryDir: string;
  resume: boolean;
}

export interface TimingMatrixRunnerOptions {
  input: string;
  inputFormat: TimingInputFormat;
  provider: string;
  outputDir: string;
  shardCount: number;
  workers: number;
  maxAttempts: number;
  retryDelayMs: number;
  runShard: (
    invocation: TimingShardInvocation,
  ) => Promise<TimingShardProcessResult>;
  onEvent?: (event: TimingMatrixRunnerEvent) => void;
}

export type TimingMatrixRunnerEvent =
  | { kind: "shard-adopted"; shardIndex: number }
  | {
      kind: "shard-attempt";
      shardIndex: number;
      attempt: number;
      resume: boolean;
    }
  | { kind: "shard-retry"; shardIndex: number; attempt: number; reason: string }
  | { kind: "shard-complete"; shardIndex: number; attempts: number };

interface ShardManifestEntry {
  shardIndex: number;
  attempts: number;
  status: "pending" | "in-progress" | "complete";
  report: string;
}

export interface TimingMatrixRunManifest {
  schema: 1;
  status: "in-progress" | "complete";
  input: string;
  inputFormat: TimingInputFormat;
  provider: string;
  shardCount: number;
  workers: number;
  maxAttempts: number;
  startedAt: string;
  updatedAt: string;
  shards: ShardManifestEntry[];
  matrix: string | null;
}

type ExistingShardState = "absent" | "in-progress" | "complete";

function runnerError(
  code: string,
  message: string,
  context?: Record<string, unknown>,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code,
    ...(context === undefined ? {} : { context }),
    ...(cause === undefined ? {} : { cause }),
  });
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function readShardState(file: string): ExistingShardState {
  if (!fs.existsSync(file)) return "absent";
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (cause) {
    // error-policy:J2 A corrupt checkpoint is retained and reported with its path.
    throw runnerError(
      "TIMING_MATRIX_CHECKPOINT_READ_FAILED",
      "Failed to read timing shard checkpoint",
      { file },
      cause,
    );
  }
  if (
    value === null ||
    typeof value !== "object" ||
    !("schema" in value) ||
    value.schema !== 2 ||
    !("status" in value) ||
    (value.status !== "in-progress" && value.status !== "complete")
  ) {
    throw runnerError(
      "TIMING_MATRIX_CHECKPOINT_INVALID",
      "Timing shard checkpoint has an invalid status envelope",
      { file },
    );
  }
  return value.status;
}

function validateRunnerOptions(options: TimingMatrixRunnerOptions): void {
  const counts = [
    ["shardCount", options.shardCount],
    ["workers", options.workers],
    ["maxAttempts", options.maxAttempts],
  ] as const;
  for (const [name, value] of counts) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw runnerError(
        "TIMING_MATRIX_INVALID_ARGUMENT",
        `${name} must be a positive integer`,
        { name, value },
      );
    }
  }
  if (options.workers > options.shardCount) {
    throw runnerError(
      "TIMING_MATRIX_INVALID_ARGUMENT",
      "workers cannot exceed shardCount",
      { workers: options.workers, shardCount: options.shardCount },
    );
  }
  if (!Number.isSafeInteger(options.retryDelayMs) || options.retryDelayMs < 0) {
    throw runnerError(
      "TIMING_MATRIX_INVALID_ARGUMENT",
      "retryDelayMs must be a non-negative integer",
      { retryDelayMs: options.retryDelayMs },
    );
  }
}

function wait(delayMs: number): Promise<void> {
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function runTimingMatrix(
  options: TimingMatrixRunnerOptions,
): Promise<{ manifest: TimingMatrixRunManifest; matrix: TimingMatrixReport }> {
  validateRunnerOptions(options);
  const outputDir = path.resolve(options.outputDir);
  const reports = Array.from({ length: options.shardCount }, (_, shardIndex) =>
    path.join(outputDir, `shard-${String(shardIndex).padStart(5, "0")}.json`),
  );
  const startedAt = new Date().toISOString();
  const manifestFile = path.join(outputDir, "run-manifest.json");
  const matrixFile = path.join(outputDir, "matrix.json");
  const shards: ShardManifestEntry[] = reports.map((report, shardIndex) => ({
    shardIndex,
    attempts: 0,
    status: readShardState(report) === "complete" ? "complete" : "pending",
    report,
  }));
  const manifest = (
    status: TimingMatrixRunManifest["status"],
  ): TimingMatrixRunManifest => ({
    schema: 1,
    status,
    input: path.resolve(options.input),
    inputFormat: options.inputFormat,
    provider: options.provider,
    shardCount: options.shardCount,
    workers: options.workers,
    maxAttempts: options.maxAttempts,
    startedAt,
    updatedAt: new Date().toISOString(),
    shards: shards.map((shard) => ({ ...shard })),
    matrix: status === "complete" ? matrixFile : null,
  });
  const checkpointManifest = (): void =>
    writeJsonAtomic(manifestFile, manifest("in-progress"));
  checkpointManifest();

  let nextShard = 0;
  async function worker(): Promise<void> {
    while (nextShard < shards.length) {
      const shardIndex = nextShard;
      nextShard += 1;
      const shard = shards[shardIndex];
      if (shard.status === "complete") {
        options.onEvent?.({ kind: "shard-adopted", shardIndex });
        continue;
      }
      for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
        shard.attempts = attempt;
        const state = readShardState(shard.report);
        const resume = state === "in-progress";
        shard.status = resume ? "in-progress" : "pending";
        checkpointManifest();
        options.onEvent?.({
          kind: "shard-attempt",
          shardIndex,
          attempt,
          resume,
        });
        const result = await options.runShard({
          shardIndex,
          shardCount: options.shardCount,
          attempt,
          report: shard.report,
          trajectoryDir: path.join(
            outputDir,
            `shard-${String(shardIndex).padStart(5, "0")}-trajectories`,
          ),
          resume,
        });
        const nextState = readShardState(shard.report);
        if (nextState === "complete") {
          shard.status = "complete";
          checkpointManifest();
          options.onEvent?.({
            kind: "shard-complete",
            shardIndex,
            attempts: attempt,
          });
          break;
        }
        if (result.kind === "exited" && result.exitCode === 2) {
          throw runnerError(
            "TIMING_MATRIX_SHARD_CONFIG_FAILED",
            "Timing shard exited with a non-retryable configuration failure",
            { shardIndex, attempt, exitCode: result.exitCode },
          );
        }
        const reason =
          result.kind === "exited"
            ? `exit ${result.exitCode}`
            : `signal ${result.signal}`;
        if (attempt === options.maxAttempts) {
          throw runnerError(
            "TIMING_MATRIX_SHARD_RETRIES_EXHAUSTED",
            "Timing shard exhausted its retry budget without completing",
            { shardIndex, attempt, reason, state: nextState },
          );
        }
        options.onEvent?.({ kind: "shard-retry", shardIndex, attempt, reason });
        await wait(options.retryDelayMs);
      }
    }
  }

  await Promise.all(Array.from({ length: options.workers }, () => worker()));
  const matrix = mergeTimingReports(reports);
  if (matrix.cells.length !== 1) {
    throw runnerError(
      "TIMING_MATRIX_MIXED_CELLS",
      "A supervised timing run must merge into exactly one model cell",
      { cells: matrix.cells.length },
    );
  }
  writeJsonAtomic(matrixFile, matrix);
  const completeManifest = manifest("complete");
  writeJsonAtomic(manifestFile, completeManifest);
  return { manifest: completeManifest, matrix };
}
