#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const [packageDirArg, separator, ...command] = process.argv.slice(2);

if (!packageDirArg || separator !== "--" || command.length === 0) {
  console.error(
    "Usage: node packages/scripts/with-package-build-lock.mjs <package-dir> -- <command...>",
  );
  process.exit(1);
}

async function findWorkspaceRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    try {
      const raw = await fs.readFile(path.join(current, "package.json"), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.workspaces) return current;
    } catch {
      // keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

const root = await findWorkspaceRoot(process.cwd());
const packageDir = path.resolve(root, packageDirArg);
const lockDir = path.join(packageDir, ".build-lock");
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

async function removeStaleLock() {
  const metadata = await readLockMetadata();
  const createdAt = Date.parse(metadata?.createdAt ?? "");
  const pid = Number(metadata?.pid);
  const isStaleByAge =
    Number.isFinite(createdAt) && Date.now() - createdAt > staleAfterMs;
  const isStaleByPid = Number.isInteger(pid) && !isProcessAlive(pid);

  if (isStaleByAge || isStaleByPid) {
    await fs.rm(lockDir, { recursive: true, force: true });
    return true;
  }
  return false;
}

async function acquireLock() {
  let waitMs = 100;
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

await fs.rm(lockDir, { recursive: true, force: true });
process.exit(exitCode);
