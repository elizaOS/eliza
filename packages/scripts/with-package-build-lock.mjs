#!/usr/bin/env node
// Drives repo automation with package build lock with explicit CLI and CI behavior.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { findWorkspaceRoot } from "./lib/repo-root.mjs";

const execFileAsync = promisify(execFile);

const [packageDirArg, separator, ...command] = process.argv.slice(2);

if (!packageDirArg || separator !== "--" || command.length === 0) {
  console.error(
    "Usage: node packages/scripts/with-package-build-lock.mjs <package-dir> -- <command...>",
  );
  process.exit(1);
}

const root = findWorkspaceRoot(process.cwd());
const packageDir = path.resolve(root, packageDirArg);
// Keep transient lock state out of package directories so cancelled Turbo builds
// do not leave untracked `.build-lock` folders across the workspace.
const lockRoot = path.join(root, ".turbo", "build-locks");
const packageLockName = path
  .relative(root, packageDir)
  .replaceAll(path.sep, "__")
  .replaceAll(/[^a-zA-Z0-9._-]/g, "_");
const lockDir = path.join(lockRoot, packageLockName);
const cleanupHelper = path.join(
  root,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);
const staleAfterMs = Number.parseInt(
  process.env.ELIZA_PACKAGE_BUILD_LOCK_STALE_MS ?? "1800000",
  10,
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLockMetadata() {
  try {
    const raw = await fs.readFile(path.join(lockDir, "metadata.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function removeLockDir() {
  await execFileAsync(process.execPath, [cleanupHelper, lockDir], {
    cwd: root,
  });
}

async function removeStaleLock() {
  const metadata = await readLockMetadata();
  const createdAt = Date.parse(metadata?.createdAt ?? "");
  const pid = Number(metadata?.pid);
  const isStaleByAge =
    Number.isFinite(createdAt) && Date.now() - createdAt > staleAfterMs;
  const isStaleByPid = Number.isInteger(pid) && !isProcessAlive(pid);

  if (isStaleByAge || isStaleByPid) {
    await removeLockDir();
    return true;
  }
  return false;
}

async function acquireLock() {
  let waitMs = 100;
  await fs.mkdir(lockRoot, { recursive: true });
  while (true) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(
        path.join(lockDir, "metadata.json"),
        `${JSON.stringify(
          {
            pid: process.pid,
            command,
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
      );
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (await removeStaleLock()) {
        continue;
      }
      await sleep(waitMs);
      waitMs = Math.min(waitMs * 1.5, 1_000);
    }
  }
}

await acquireLock();

const child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  shell: process.platform === "win32",
});

let cleaningUp = false;
async function cleanupLock() {
  if (cleaningUp) return;
  cleaningUp = true;
  await removeLockDir();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    child.kill(signal);
  });
}

const exitCode = await new Promise((resolve) => {
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`Command terminated by ${signal}`);
      resolve(1);
      return;
    }
    resolve(code ?? 1);
  });
});

await cleanupLock();
process.exit(exitCode);
