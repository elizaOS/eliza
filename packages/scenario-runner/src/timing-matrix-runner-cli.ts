#!/usr/bin/env bun
/** Runs and resumes a bounded full-volume timing matrix cell. */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ElizaError } from "@elizaos/core";
import {
  runTimingMatrix,
  type TimingMatrixRunnerEvent,
  type TimingShardInvocation,
  type TimingShardProcessResult,
} from "./timing-matrix-runner.ts";
import type { TimingInputFormat } from "./when2speak-eval.ts";

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

function argumentError(message: string): ElizaError {
  return new ElizaError(message, {
    code: "TIMING_MATRIX_CLI_INVALID_ARGUMENT",
  });
}

function positiveInteger(name: string, fallback?: number): number {
  const text = option(name);
  if (text === undefined && fallback !== undefined) return fallback;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw argumentError(`--${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(name: string, fallback: number): number {
  const text = option(name);
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw argumentError(`--${name} must be a non-negative integer`);
  }
  return value;
}

const input = option("input");
const outputDir = option("output-dir");
if (!input || !outputDir) {
  throw argumentError(
    "usage: timing-matrix-runner --input=<jsonl> --output-dir=<dir> [--input-format=when2speak|discord-replay] [--character-preset=minimal|eliza] [--provider=<name>] [--shard-count=<n>] [--workers=<n>] [--max-attempts=<n>] [--retry-delay-ms=<n>]",
  );
}
const resolvedInput = path.resolve(input);
const resolvedOutputDir = path.resolve(outputDir);
const inputFormatText = option("input-format") ?? "when2speak";
if (inputFormatText !== "when2speak" && inputFormatText !== "discord-replay") {
  throw argumentError("--input-format must be when2speak or discord-replay");
}
const inputFormat: TimingInputFormat = inputFormatText;
const characterPreset = option("character-preset") ?? "minimal";
if (characterPreset !== "minimal" && characterPreset !== "eliza") {
  throw argumentError("--character-preset must be minimal or eliza");
}
const runtimeProfile = option("runtime-profile") ?? "classifier-isolated";
if (
  runtimeProfile !== "classifier-isolated" &&
  runtimeProfile !== "production-composed"
) {
  throw argumentError(
    "--runtime-profile must be classifier-isolated or production-composed",
  );
}
const provider = option("provider") ?? "cli";
const shardCount = positiveInteger("shard-count", 8);
const workers = positiveInteger("workers", Math.min(4, shardCount));
const maxAttempts = positiveInteger("max-attempts", 20);
const retryDelayMs = nonNegativeInteger("retry-delay-ms", 5_000);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(packageRoot, "..", "..");
const evaluator = path.join(packageRoot, "src", "when2speak-eval-cli.ts");
const sourceArguments = [
  "--conditions",
  "eliza-source",
  "--tsconfig-override",
  path.join(repoRoot, "tsconfig.json"),
  evaluator,
];
const activeChildren = new Set<ChildProcess>();
let interruptedSignal: NodeJS.Signals | null = null;

function interrupt(signal: NodeJS.Signals): void {
  interruptedSignal = signal;
  for (const child of activeChildren) child.kill("SIGTERM");
}

process.once("SIGINT", () => interrupt("SIGINT"));
process.once("SIGTERM", () => interrupt("SIGTERM"));

function appendLog(file: string): number {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return fs.openSync(file, "a");
}

function runShard(
  invocation: TimingShardInvocation,
): Promise<TimingShardProcessResult> {
  return new Promise((resolve, reject) => {
    if (interruptedSignal !== null) {
      reject(
        new ElizaError("Timing matrix run was interrupted", {
          code: "TIMING_MATRIX_INTERRUPTED",
          context: { signal: interruptedSignal },
        }),
      );
      return;
    }
    const shardLabel = String(invocation.shardIndex).padStart(5, "0");
    const stdout = appendLog(
      path.join(resolvedOutputDir, `shard-${shardLabel}.stdout.log`),
    );
    const stderr = appendLog(
      path.join(resolvedOutputDir, `shard-${shardLabel}.stderr.log`),
    );
    const args = [
      ...sourceArguments,
      `--input=${resolvedInput}`,
      `--input-format=${inputFormat}`,
      `--output=${invocation.report}`,
      `--run-dir=${invocation.trajectoryDir}`,
      `--provider=${provider}`,
      `--character-preset=${characterPreset}`,
      `--runtime-profile=${runtimeProfile}`,
      `--shard-index=${invocation.shardIndex}`,
      `--shard-count=${invocation.shardCount}`,
      `--attempt=${invocation.attempt}`,
      "--checkpoint-every=1",
      ...(invocation.resume ? [`--resume=${invocation.report}`] : []),
    ];
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", stdout, stderr],
    });
    activeChildren.add(child);
    let settled = false;
    const closeLogs = (): void => {
      fs.closeSync(stdout);
      fs.closeSync(stderr);
    };
    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      closeLogs();
      reject(
        new ElizaError("Failed to spawn timing shard", {
          code: "TIMING_MATRIX_SHARD_SPAWN_FAILED",
          context: {
            shardIndex: invocation.shardIndex,
            attempt: invocation.attempt,
          },
          cause,
        }),
      );
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      closeLogs();
      if (interruptedSignal !== null) {
        reject(
          new ElizaError("Timing matrix run was interrupted", {
            code: "TIMING_MATRIX_INTERRUPTED",
            context: { signal: interruptedSignal },
          }),
        );
        return;
      }
      resolve(
        exitCode === null
          ? { kind: "signaled", signal: signal ?? "unknown" }
          : { kind: "exited", exitCode },
      );
    });
  });
}

function eventText(event: TimingMatrixRunnerEvent): string {
  switch (event.kind) {
    case "shard-adopted":
      return `[timing-matrix] shard ${event.shardIndex} already complete`;
    case "shard-attempt":
      return `[timing-matrix] shard ${event.shardIndex} attempt ${event.attempt}${event.resume ? " resuming" : " starting"}`;
    case "shard-retry":
      return `[timing-matrix] shard ${event.shardIndex} retrying after ${event.reason}`;
    case "shard-complete":
      return `[timing-matrix] shard ${event.shardIndex} complete after ${event.attempts} attempt(s)`;
  }
}

const result = await runTimingMatrix({
  input: resolvedInput,
  inputFormat,
  provider,
  outputDir: resolvedOutputDir,
  shardCount,
  workers,
  maxAttempts,
  retryDelayMs,
  runShard,
  onEvent: (event) => process.stderr.write(`${eventText(event)}\n`),
});
process.stdout.write(`${JSON.stringify(result.matrix.cells[0])}\n`);
process.stdout.write(
  `manifest: ${path.join(resolvedOutputDir, "run-manifest.json")}\n`,
);
process.stdout.write(
  `matrix: ${path.join(resolvedOutputDir, "matrix.json")}\n`,
);
