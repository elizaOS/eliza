#!/usr/bin/env node
/**
 * CLI entry point for Eliza.
 *
 * This file is compiled into dist/entry.js and invoked by the app entry script.
 * It bootstraps the CLI: normalizes env, applies profile settings,
 * and delegates to the Commander-based CLI.
 */
import process from "node:process";
import { formatErrorWithStack, getLogPrefix } from "@elizaos/shared";
import { bootLap } from "./boot-profile";
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile";
import { promoteLauncherScopedDevCloudApiKey } from "./entry-cloud-api-key";

bootLap("entry:body (Bun load of entry.js + @elizaos/shared)");

process.title = process.env.APP_CLI_NAME?.trim() || "eliza";

if (process.argv.includes("--no-color")) {
  process.env.NO_COLOR = "1";
  process.env.FORCE_COLOR = "0";
}

// Explicit staging and self-hosted launchers may bridge their target-scoped
// development credential for the cloud plugin. Direct and packaged entrypoints
// default to production and must not infer authority from NODE_ENV.
if (promoteLauncherScopedDevCloudApiKey(process.env)) {
  // Stderr only — logger isn't initialized yet at this point in boot.
  process.stderr.write(
    "[entry] launcher-scoped Cloud development credential promoted to ELIZAOS_CLOUD_API_KEY\n",
  );
}

// Bridge DATABASE_URL → POSTGRES_URL. Cloud provisioners (docker-sandbox-provider,
// k8s manifests, Railway env) inject DATABASE_URL, but plugin-sql reads
// POSTGRES_URL via runtime.getSetting("POSTGRES_URL"). Without this bridge,
// sandboxes silently fall back to local PGLite instead of connecting to the
// injected Neon database — losing all memories on container restart and
// breaking memory transfer / centralized observability.
if (process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  process.env.POSTGRES_URL = process.env.DATABASE_URL;
  // Stderr only — logger isn't initialized yet at this point in boot.
  process.stderr.write(
    "[entry] DATABASE_URL detected: bridged to POSTGRES_URL for plugin-sql\n",
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

bootLap("entry:before import(run-main)");
import("./cli/run-main")
  .then(({ runCli }) => {
    bootLap("entry:run-main loaded (CLI graph evaluated)");
    return runCli(process.argv);
  })
  .catch((error) => {
    console.error(
      `${getLogPrefix()} Failed to start CLI:`,
      formatErrorWithStack(error),
    );
    process.exit(1);
  });
