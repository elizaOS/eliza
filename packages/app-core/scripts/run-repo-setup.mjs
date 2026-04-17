#!/usr/bin/env node

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = resolveRepoRootFromImportMeta(import.meta.url);
const APP_CORE_SCRIPTS_DIR = __dirname;

export const repoSetupSteps = [
  "scripts/init-submodules.mjs",
  "patch-workspace-plugins.mjs",
  "patch-deps.mjs",
  "ensure-type-package-aliases.mjs",
  "scripts/setup-upstreams.mjs",
  "ensure-bundled-workspaces.mjs",
  "ensure-shared-i18n-data.mjs",
  "ensure-skills.mjs",
  "scripts/sync-workspace-default-skills.mjs",
  "ensure-avatars.mjs",
  "link-browser-server.mjs",
  "link-external-plugins.mjs",
  "ensure-vision-deps.mjs",
  "patch-deps.mjs",
];

function resolveRepoSetupStepPath(repoRoot, step) {
  if (step.startsWith("scripts/")) {
    return path.join(repoRoot, step);
  }
  return path.join(APP_CORE_SCRIPTS_DIR, step);
}

const STALE_LOCK_MS = 10 * 60 * 1000;
const LOCK_WAIT_MS = 15 * 60 * 1000;
const LOCK_POLL_MS = 250;

function defaultProcessExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    return code !== "ESRCH";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getRepoSetupLockPath(repoRoot = DEFAULT_REPO_ROOT) {
  return path.join(repoRoot, ".eliza-repo-setup.lock");
}

export function isRepoSetupLockStale(
  lockState,
  {
    now = Date.now(),
    staleMs = STALE_LOCK_MS,
    processExists = defaultProcessExists,
  } = {},
) {
  if (!lockState || typeof lockState !== "object") {
    return true;
  }

  const startedAt =
    typeof lockState.startedAt === "number" ? lockState.startedAt : NaN;
  const pid = typeof lockState.pid === "number" ? lockState.pid : NaN;

  if (!Number.isFinite(startedAt) || !Number.isFinite(pid)) {
    return true;
  }

  if (!processExists(pid)) {
    return true;
  }

  return now - startedAt > staleMs;
}

async function readLockState(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function acquireRepoSetupLock(
  lockPath,
  {
    now = () => Date.now(),
    staleMs = STALE_LOCK_MS,
    waitMs = LOCK_WAIT_MS,
    pollMs = LOCK_POLL_MS,
    processExists = defaultProcessExists,
  } = {},
) {
  const start = now();

  while (true) {
    const lockState = JSON.stringify({
      pid: process.pid,
      startedAt: now(),
      host: os.hostname(),
    });

    try {
      await fs.writeFile(lockPath, lockState, { flag: "wx" });
      return async () => {
        await fs.rm(lockPath, { force: true });
      };
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "EEXIST")) {
        throw error;
      }
    }

    const existing = await readLockState(lockPath);
    if (
      isRepoSetupLockStale(existing, {
        now: now(),
        staleMs,
        processExists,
      })
    ) {
      await fs.rm(lockPath, { force: true });
      continue;
    }

    if (now() - start > waitMs) {
      throw new Error(
        `Timed out waiting for repo setup lock at ${lockPath}. Remove it if no setup process is still running.`,
      );
    }

    await sleep(pollMs);
  }
}

export async function runRepoSetup(repoRoot = DEFAULT_REPO_ROOT) {
  const release = await acquireRepoSetupLock(getRepoSetupLockPath(repoRoot));
  try {
    for (const step of repoSetupSteps) {
      const scriptPath = resolveRepoSetupStepPath(repoRoot, step);
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [scriptPath], {
          cwd: repoRoot,
          env: process.env,
          stdio: "inherit",
        });

        child.on("error", (err) => {
          reject(new Error(`${step} failed to spawn: ${err.message}`));
        });
        child.on("exit", (code, signal) => {
          if (signal) {
            reject(new Error(`${step} exited due to signal ${signal}`));
            return;
          }
          if ((code ?? 1) !== 0) {
            reject(new Error(`${step} exited with code ${code ?? 1}`));
            return;
          }
          resolve();
        });
      });
    }
  } finally {
    await release();
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  runRepoSetup().catch((error) => {
    console.error(
      `[eliza] Repo setup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
