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
import { getLogPrefix } from "@elizaos/shared";
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile";

process.title = process.env.APP_CLI_NAME?.trim() || "eliza";

if (process.argv.includes("--no-color")) {
  process.env.NO_COLOR = "1";
  process.env.FORCE_COLOR = "0";
}

// Build-testing bridge: when ELIZA_DEV_CLOUD_API_KEY is set in non-production,
// promote it to ELIZAOS_CLOUD_API_KEY so the cloud plugin's env-fallback chain
// (plugins/plugin-elizacloud/src/cloud/cloud-api-key.ts) authenticates without
// the browser SIWE handshake. Production never sets ELIZA_DEV_*, so this is
// a no-op there. See scripts/cloud-siwe-login.mjs to mint a fresh key.
if (
  process.env.NODE_ENV !== "production" &&
  process.env.ELIZA_DEV_CLOUD_API_KEY &&
  !process.env.ELIZAOS_CLOUD_API_KEY
) {
  process.env.ELIZAOS_CLOUD_API_KEY = process.env.ELIZA_DEV_CLOUD_API_KEY;
  // Stderr only — logger isn't initialized yet at this point in boot.
  process.stderr.write(
    "[entry] ELIZA_DEV_CLOUD_API_KEY detected (dev mode): promoted to ELIZAOS_CLOUD_API_KEY\n",
  );
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
