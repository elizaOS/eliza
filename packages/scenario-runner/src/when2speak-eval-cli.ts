#!/usr/bin/env bun
/** Runs the When2Speak Stage-1 batch evaluator and writes its evidence report. */
import fs from "node:fs";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import type { LiveProviderName } from "@elizaos/core/testing";
import type {
  TimingCharacterPreset,
  TimingInputFormat,
  TimingReport,
} from "./when2speak-eval.ts";
import { runWhen2SpeakEval } from "./when2speak-eval.ts";

function usageError(message: string): ElizaError {
  return new ElizaError(message, { code: "WHEN2SPEAK_CLI_INVALID_ARGUMENT" });
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}
const input = option("input");
if (!input)
  throw usageError(
    "usage: when2speak-eval --input=<jsonl> [--input-format=when2speak|discord-replay] [--character-preset=minimal|eliza] [--output=<json>] [--run-dir=<dir>] [--provider=<name>] [--limit=<n>] [--shard-index=<n> --shard-count=<n>] [--start-row=<n>] [--checkpoint-every=<n>] [--resume=<in-progress-report>]",
  );
function positiveInteger(name: string): number | undefined {
  const text = option(name);
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw usageError(`--${name} must be a positive integer`);
  return value;
}
const limitText = option("limit");
const limit = limitText === undefined ? undefined : Number(limitText);
if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0))
  throw usageError("--limit must be a positive integer");
const inputFormatText = option("input-format") ?? "when2speak";
if (inputFormatText !== "when2speak" && inputFormatText !== "discord-replay")
  throw usageError("--input-format must be when2speak or discord-replay");
const inputFormat: TimingInputFormat = inputFormatText;
const characterPresetText = option("character-preset") ?? "minimal";
if (characterPresetText !== "minimal" && characterPresetText !== "eliza")
  throw usageError("--character-preset must be minimal or eliza");
const characterPreset: TimingCharacterPreset = characterPresetText;
const shardCount = positiveInteger("shard-count") ?? 1;
const shardIndexText = option("shard-index");
const shardIndex = shardIndexText === undefined ? 0 : Number(shardIndexText);
if (
  !Number.isSafeInteger(shardIndex) ||
  shardIndex < 0 ||
  shardIndex >= shardCount
)
  throw usageError(
    `--shard-index must be an integer from 0 through ${shardCount - 1}`,
  );
const startRow = positiveInteger("start-row") ?? 1;
const checkpointEvery = positiveInteger("checkpoint-every") ?? 1;
const resume = option("resume");
const output = path.resolve(
  option("output") ?? "../../reports/group-chat-timing/when2speak.json",
);
const trajectoryDir = path.resolve(
  option("run-dir") ?? path.join(path.dirname(output), "trajectories"),
);
const providerText = option("provider");
const liveProviders = new Set<LiveProviderName>([
  "groq",
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "cli",
]);
if (
  providerText !== undefined &&
  !liveProviders.has(providerText as LiveProviderName)
) {
  throw usageError(`unsupported --provider=${providerText}`);
}
const provider = providerText as LiveProviderName | undefined;
let resumeReport: unknown;
if (resume !== undefined) {
  try {
    resumeReport = JSON.parse(fs.readFileSync(path.resolve(resume), "utf8"));
  } catch (cause) {
    // error-policy:J2 Resume input failures retain the requested path.
    throw new ElizaError("Failed to read the When2Speak resume report", {
      code: "WHEN2SPEAK_RESUME_READ_FAILED",
      context: { resume: path.resolve(resume) },
      cause,
    });
  }
}
function writeReport(report: TimingReport): void {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, output);
}
const report = await runWhen2SpeakEval({
  input: path.resolve(input),
  trajectoryDir,
  provider,
  inputFormat,
  limit,
  shardIndex,
  shardCount,
  startRow,
  checkpointEvery,
  resumeReport,
  characterPreset,
  onCheckpoint: writeReport,
});
writeReport(report);
process.stdout.write(`${JSON.stringify(report.metrics)}\nreport: ${output}\n`);
if (report.failures.length > 0) process.exitCode = 1;
