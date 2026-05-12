#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const separatorIndex = args.indexOf("--");

if (separatorIndex < 1 || separatorIndex === args.length - 1) {
  console.error(
    "Usage: node scripts/run-with-env.mjs KEY=VALUE [KEY=VALUE ...] -- <command> [args...]",
  );
  process.exit(1);
}

const envAssignments = args.slice(0, separatorIndex);
const commandWithArgs = args.slice(separatorIndex + 1);
const [command, ...commandArgs] = commandWithArgs;

function shouldSuppressNodeWarnings(commandName, args) {
  return [commandName, ...args].some((part) => /\bvitest\b/.test(part));
}

const env = { ...process.env };
for (const assignment of envAssignments) {
  const eqIndex = assignment.indexOf("=");
  if (eqIndex <= 0) {
    console.error(`Invalid env assignment: ${assignment}`);
    process.exit(1);
  }
  const key = assignment.slice(0, eqIndex);
  const value = assignment.slice(eqIndex + 1);
  env[key] = value;
}

if (
  env.NODE_NO_WARNINGS == null &&
  shouldSuppressNodeWarnings(command, commandArgs)
) {
  env.NODE_NO_WARNINGS = "1";
}

const liveTestsEnabled =
  env.ELIZA_LIVE_TEST === "1" || env.ELIZA_LIVE_TEST === "1";
if (liveTestsEnabled && env.LOCAL_EMBEDDING_FORCE_CPU == null) {
  env.LOCAL_EMBEDDING_FORCE_CPU = "1";
}
if (liveTestsEnabled && env.ELIZA_DISABLE_LOCAL_EMBEDDINGS == null) {
  env.ELIZA_DISABLE_LOCAL_EMBEDDINGS = "1";
}

const result = spawnSync(command, commandArgs, {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
