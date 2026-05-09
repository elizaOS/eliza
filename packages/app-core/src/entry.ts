#!/usr/bin/env node
/**
 * CLI entry point for Eliza.
 *
 * This file is built by tsdown into dist/entry.js and invoked by the app entry script.
 * It bootstraps the CLI: normalizes env, applies profile settings,
 * and delegates to the Commander-based CLI.
 */
import "@elizaos/shared";
import process from "node:process";
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile";
import { getLogPrefix } from "@elizaos/shared";

process.title = process.env.APP_CLI_NAME?.trim() || "eliza";

if (process.argv.includes("--no-color")) {
  process.env.NO_COLOR = "1";
  process.env.FORCE_COLOR = "0";
}

// Keep `npx elizaai` startup readable by default.
// This runs before CLI/runtime imports so @elizaos/core logger picks it up.
if (!process.env.LOG_LEVEL) {
  if (process.argv.includes("--debug")) {
    process.env.LOG_LEVEL = "debug";
  } else if (process.argv.includes("--verbose")) {
    process.env.LOG_LEVEL = "info";
  } else {
    process.env.LOG_LEVEL = "error";
  }
}

// Keep llama.cpp backend output aligned with Eliza's log level defaults.
// This suppresses noisy tokenizer warnings in normal startup while still
// allowing verbose/debug visibility when explicitly requested.
if (!process.env.NODE_LLAMA_CPP_LOG_LEVEL) {
  const logLevel = String(process.env.LOG_LEVEL).toLowerCase();
  process.env.NODE_LLAMA_CPP_LOG_LEVEL =
    logLevel === "debug" ? "debug" : logLevel === "info" ? "info" : "error";
}

const parsed = parseCliProfileArgs(process.argv);
if (!parsed.ok) {
  console.error(`${getLogPrefix()} ${parsed.error}`);
  process.exit(2);
}

if (parsed.profile) {
  applyCliProfileEnv({ profile: parsed.profile });
  process.argv = parsed.argv;
}

// ── Delegate to the Commander-based CLI ──────────────────────────────────────

import("./cli/run-main")
  .then(({ runCli }) => runCli(process.argv))
  .catch((error) => {
    console.error(
      `${getLogPrefix()} Failed to start CLI:`,
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exit(1);
  });
