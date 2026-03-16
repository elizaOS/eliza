#!/usr/bin/env node
/**
 * CLI entry point for Milaidy.
 *
 * This file is built by tsdown into dist/entry.js and invoked by milaidy.mjs.
 * It bootstraps the CLI: normalizes env, applies profile settings,
 * and delegates to the Commander-based CLI.
 */
import process from "node:process";
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";

process.title = "milaidy";

// Normalize env: copy Z_AI_API_KEY → ZAI_API_KEY when ZAI_API_KEY is empty.
if (!process.env.ZAI_API_KEY?.trim() && process.env.Z_AI_API_KEY?.trim()) {
  process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
}

if (process.argv.includes("--no-color")) {
  process.env.NO_COLOR = "1";
  process.env.FORCE_COLOR = "0";
}

const parsed = parseCliProfileArgs(process.argv);
if (!parsed.ok) {
  console.error(`[milaidy] ${parsed.error}`);
  process.exit(2);
}

if (parsed.profile) {
  applyCliProfileEnv({ profile: parsed.profile });
  process.argv = parsed.argv;
}

// ── Delegate to the Commander-based CLI ──────────────────────────────────────

import("./cli/run-main.js")
  .then(({ runCli }) => runCli(process.argv))
  .catch((error) => {
    console.error(
      "[milaidy] Failed to start CLI:",
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exitCode = 1;
  });
