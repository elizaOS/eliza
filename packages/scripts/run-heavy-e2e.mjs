#!/usr/bin/env node
/**
 * Fail-closed launcher for the release-gate heavy browser E2E lane
 * (`test:e2e:heavy`).
 *
 * The two suites this lane runs (qa-checklist and memory-relationships under
 * packages/app-core/test/app) self-skip through `describeIf` unless
 * ELIZA_LIVE_TEST=1, a real Chrome binary, and a live provider API key are all
 * present — and a fully skipped vitest run still exits 0. On the release
 * runner that combination turned the gate into a permanent no-op green
 * (release-electrobun.yml "Run heavy E2E regression suite"). This launcher
 * refuses to hand CI a vacuous pass from either direction: it rejects the run
 * before vitest starts when a prerequisite is missing, and after a green
 * vitest exit it requires every named suite file to have executed at least one
 * assertion with zero skipped tests.
 *
 * The root script invokes it from packages/app-core so the vitest config
 * resolves its include globs; every CLI argument is forwarded to
 * `bunx vitest run` unchanged. The preflight mirrors the suites' own gating
 * constants; if those ever drift, the post-run executed-assertion check is the
 * backstop that still turns a silent skip into a red exit.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Default browser location the heavy suites probe when ELIZA_CHROME_PATH is unset. */
export const DEFAULT_CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Env vars accepted by packages/app-core/test/helpers/live-provider.ts as a
 * live LLM provider credential, including the CI-scoped ELIZA_E2E_* aliases.
 */
export const LIVE_PROVIDER_KEY_ENV_VARS = [
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CEREBRAS_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "LOCAL_LLAMA_CPP_API_KEY",
  "ELIZA_E2E_GROQ_API_KEY",
  "ELIZA_E2E_OPENAI_API_KEY",
  "ELIZA_E2E_ANTHROPIC_API_KEY",
  "ELIZA_E2E_CEREBRAS_API_KEY",
  "ELIZA_E2E_GOOGLE_GENERATIVE_AI_API_KEY",
  "ELIZA_E2E_OPENROUTER_API_KEY",
];

const EXECUTED_STATUSES = new Set(["passed", "failed"]);

export function resolveChromePath(env) {
  const explicit = env.ELIZA_CHROME_PATH?.trim();
  return explicit || DEFAULT_CHROME_PATH;
}

/**
 * Returns human-actionable failure messages for every missing heavy-lane
 * prerequisite, or an empty array when the suites can genuinely execute.
 */
export function evaluateHeavyPreflight(env, { fileExists = existsSync } = {}) {
  const failures = [];

  if (env.ELIZA_LIVE_TEST !== "1") {
    failures.push(
      "ELIZA_LIVE_TEST=1 is required: without it every heavy suite self-skips and the release gate asserts nothing.",
    );
  }

  const chromePath = resolveChromePath(env);
  if (!fileExists(chromePath)) {
    failures.push(
      `No browser binary at "${chromePath}". Install Chrome there or point ELIZA_CHROME_PATH at a real Chrome/Chromium executable.`,
    );
  }

  const hasProviderKey = LIVE_PROVIDER_KEY_ENV_VARS.some((name) =>
    env[name]?.trim(),
  );
  if (!hasProviderKey) {
    failures.push(
      `No live LLM provider API key is set; the QA checklist suite self-skips without one. Set one of: ${LIVE_PROVIDER_KEY_ENV_VARS.join(", ")}.`,
    );
  }

  return failures;
}

/** Positional vitest file arguments among the forwarded CLI arguments. */
export function extractForwardedTestFiles(argv) {
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    files.push(arg);
  }
  return files;
}

/**
 * Rejects a green vitest exit that executed nothing. Every named suite file
 * must appear in the JSON summary with at least one passed or failed
 * assertion, and no test anywhere in the run may have been skipped: a skip in
 * this lane means a gating constant regressed, not a designed omission.
 */
export function assertExecutedHeavyRun(summary, testFiles, cwd) {
  const results = summary?.testResults;
  if (!Array.isArray(results)) {
    throw new Error(
      "vitest JSON summary has no testResults array; refusing to trust the green exit.",
    );
  }

  const statuses = results.flatMap((fileResult) => {
    const assertions = Array.isArray(fileResult.assertionResults)
      ? fileResult.assertionResults
      : [];
    return assertions.map((assertion) => ({
      file: path.resolve(String(fileResult.name ?? "")),
      status: String(assertion.status ?? "unknown"),
    }));
  });

  const skipped = statuses.filter((s) => !EXECUTED_STATUSES.has(s.status));
  if (skipped.length > 0) {
    throw new Error(
      `${skipped.length} heavy test(s) were skipped instead of executed (first: ${skipped[0].file} [${skipped[0].status}]). ` +
        "A skipped heavy suite means its live gating regressed; the release gate must not pass on skips.",
    );
  }

  for (const file of testFiles) {
    const absolute = path.resolve(cwd, file);
    const executed = statuses.filter(
      (s) => s.file === absolute && EXECUTED_STATUSES.has(s.status),
    );
    if (executed.length === 0) {
      throw new Error(
        `Heavy suite ${file} executed zero assertions; refusing to report the lane green.`,
      );
    }
  }

  if (statuses.length === 0) {
    throw new Error(
      "The heavy lane executed zero assertions overall; refusing to report it green.",
    );
  }
}

function fail(messages) {
  for (const message of Array.isArray(messages) ? messages : [messages]) {
    console.error(`[run-heavy-e2e] ${message}`);
  }
  process.exit(1);
}

function main() {
  const forwarded = process.argv.slice(2);
  const testFiles = extractForwardedTestFiles(forwarded);
  if (testFiles.length === 0) {
    fail(
      "No suite files were passed on the command line; the heavy lane must name its suites explicitly.",
    );
  }

  const preflightFailures = evaluateHeavyPreflight(process.env);
  if (preflightFailures.length > 0) {
    fail([
      "Heavy E2E prerequisites are missing. This lane fails closed instead of skipping to green:",
      ...preflightFailures,
    ]);
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "eliza-heavy-e2e-"));
  const resultsPath = path.join(tempDir, "results.json");
  try {
    const vitest = spawnSync(
      "bunx",
      [
        "vitest",
        "run",
        ...forwarded,
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${resultsPath}`,
      ],
      { stdio: "inherit" },
    );
    if (vitest.error) {
      fail(`Failed to launch vitest: ${vitest.error.message}`);
    }
    if (vitest.status !== 0) {
      process.exit(vitest.status ?? 1);
    }

    let summary;
    try {
      summary = JSON.parse(readFileSync(resultsPath, "utf8"));
    } catch (error) {
      // error-policy:J1 boundary translation: an unreadable reporter summary
      // becomes a red exit; a green exit may not stand on unverifiable output.
      fail(
        `vitest exited 0 but its JSON summary at ${resultsPath} is unreadable (${error.message}); refusing to trust the green exit.`,
      );
    }

    try {
      assertExecutedHeavyRun(summary, testFiles, process.cwd());
    } catch (error) {
      // error-policy:J1 boundary translation: executed-assertion violations
      // become the process's red exit code for the release gate.
      fail(error.message);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
