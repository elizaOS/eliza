#!/usr/bin/env bun
/** Runs the When2Speak Stage-1 batch evaluator and writes its evidence report. */
import fs from "node:fs";
import path from "node:path";
import type { LiveProviderName } from "@elizaos/core/testing";
import { runWhen2SpeakEval } from "./when2speak-eval.ts";

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}
const input = option("input");
if (!input)
  throw new Error(
    "usage: when2speak-eval --input=<jsonl> [--output=<json>] [--run-dir=<dir>] [--provider=<name>] [--limit=<n>]",
  );
const limitText = option("limit");
const limit = limitText === undefined ? undefined : Number(limitText);
if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0))
  throw new Error("--limit must be a positive integer");
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
  throw new Error(`unsupported --provider=${providerText}`);
}
const provider = providerText as LiveProviderName | undefined;
const report = await runWhen2SpeakEval({
  input: path.resolve(input),
  trajectoryDir,
  provider,
  limit,
});
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report.metrics)}\nreport: ${output}\n`);
if (report.failures.length > 0) process.exitCode = 1;
