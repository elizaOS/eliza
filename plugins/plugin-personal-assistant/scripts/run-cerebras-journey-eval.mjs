#!/usr/bin/env node
/**
 * Launches the credential-gated Cerebras journey evaluation from the workspace
 * boundary expected by the live Vitest configuration. Environment loading and
 * child-process completion stay explicit so missing credentials and runner
 * failures surface as nonzero CLI outcomes. The suite writes ignored evidence
 * to `evidence/lifeops/cerebras-journey-eval-results.json`.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const testFile =
  "eliza/plugins/plugin-personal-assistant/test/journey-cerebras-eval.live.e2e.test.ts";
const vitestConfig = "eliza/packages/test/vitest/live-e2e.config.ts";

export function resolveJourneyEvalPaths(moduleUrl = import.meta.url) {
  const here = path.dirname(fileURLToPath(moduleUrl));
  const packageRoot = path.resolve(here, "..");
  const repoRoot = path.resolve(packageRoot, "..", "..");
  return {
    envCandidates: [
      path.join(repoRoot, ".env"),
      path.join(packageRoot, ".env"),
    ],
    workspaceRoot: path.dirname(repoRoot),
  };
}

export function loadJourneyEvalEnvironment({
  env,
  envCandidates,
  existsSync = fs.existsSync,
  loadEnv = dotenv.config,
}) {
  for (const candidate of envCandidates) {
    if (existsSync(candidate)) {
      loadEnv({
        path: candidate,
        override: false,
        processEnv: env,
      });
    }
  }
}

export function createJourneyEvalInvocation(workspaceRoot, env) {
  return {
    command: "bunx",
    args: ["vitest", "run", "--config", vitestConfig, testFile],
    options: {
      cwd: workspaceRoot,
      stdio: "inherit",
      env,
    },
  };
}

export function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code === null ? 1 : code));
  });
}

export async function runCerebrasJourneyEval({
  env = process.env,
  paths = resolveJourneyEvalPaths(),
  existsSync = fs.existsSync,
  loadEnv = dotenv.config,
  spawnProcess = spawn,
  writeInfo = console.info,
  writeError = console.error,
} = {}) {
  loadJourneyEvalEnvironment({
    env,
    envCandidates: paths.envCandidates,
    existsSync,
    loadEnv,
  });

  if (!env.CEREBRAS_API_KEY) {
    writeError(
      "[run-cerebras-journey-eval] CEREBRAS_API_KEY is not set after dotenv load. " +
        "Set it in eliza/.env or plugins/plugin-personal-assistant/.env before running.",
    );
    return 1;
  }

  const invocation = createJourneyEvalInvocation(paths.workspaceRoot, env);
  writeInfo(
    `[run-cerebras-journey-eval] launching vitest --config ${vitestConfig} -- ${testFile}`,
  );
  const child = spawnProcess(
    invocation.command,
    invocation.args,
    invocation.options,
  );
  return waitForChild(child);
}

export function isDirectInvocation(
  argv = process.argv,
  moduleUrl = import.meta.url,
) {
  const entrypoint = argv[1];
  return (
    typeof entrypoint === "string" &&
    path.resolve(entrypoint) === path.resolve(fileURLToPath(moduleUrl))
  );
}

export async function main() {
  process.exitCode = await runCerebrasJourneyEval();
}

if (isDirectInvocation()) {
  // error-policy:J1 This is the CLI process boundary that translates an
  // unexpected launch failure into an observable nonzero exit.
  main().catch((error) => {
    const detail =
      error instanceof Error ? error.stack || error.message : String(error);
    console.error(
      `[run-cerebras-journey-eval] fatal launch failure: ${detail}`,
    );
    process.exitCode = 1;
  });
}
