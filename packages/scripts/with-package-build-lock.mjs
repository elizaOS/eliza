#!/usr/bin/env node
// Drives repo automation with package build lock with explicit CLI and CI behavior.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { findWorkspaceRoot } from "./lib/repo-root.mjs";

const execFileAsync = promisify(execFile);

export function parsePositiveSafeInteger(value, name) {
  if (value === undefined || value === "") return null;
  const str = String(value).trim();
  if (!/^[1-9]\d*$/.test(str)) {
    throw new Error(
      `[with-package-build-lock] ${name} must be a positive safe-integer decimal (received "${value}")`,
    );
  }
  const num = Number(str);
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new Error(
      `[with-package-build-lock] ${name} must be a positive safe-integer decimal (received "${value}")`,
    );
  }
  return num;
}

export function resolveStaleAfterMs(
  envValue = process.env.ELIZA_PACKAGE_BUILD_LOCK_STALE_MS,
  defaultValue = 1800000,
) {
  if (envValue === undefined || envValue === "") {
    return defaultValue;
  }
  const parsed = parsePositiveSafeInteger(
    envValue,
    "ELIZA_PACKAGE_BUILD_LOCK_STALE_MS",
  );
  return parsed ?? defaultValue;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function runWithLock(
  args = process.argv.slice(2),
  env = process.env,
) {
  const [packageDirArg, separator, ...command] = args;

  if (!packageDirArg || separator !== "--" || command.length === 0) {
    console.error(
      "Usage: node packages/scripts/with-package-build-lock.mjs <package-dir> -- <command...>",
    );
    return 1;
  }

  const staleAfterMs = resolveStaleAfterMs(
    env.ELIZA_PACKAGE_BUILD_LOCK_STALE_MS,
  );
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

  async function readLockMetadata() {
    try {
      const raw = await fs.readFile(
        path.join(lockDir, "metadata.json"),
        "utf8",
      );
      return JSON.parse(raw);
    } catch {
      return null;
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
  return exitCode;
}

const invokedDirectly =
  import.meta.main ||
  (Boolean(process.argv[1]) &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    const exitCode = await runWithLock();
    process.exit(exitCode);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
