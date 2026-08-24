/** Persists the standalone host identity used to scope runtime-owned effects. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { UUID } from "@elizaos/core";

const INSTALLATION_ID_FILENAME = "runtime-installation-id";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwnedByRuntime(
  stat: Awaited<ReturnType<typeof fs.lstat>>,
  label: string,
): void {
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${label} is not owned by the runtime user.`);
  }
}

async function openTrustedStateDirectory(stateDirectory: string) {
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const pathStat = await fs.lstat(stateDirectory);
  if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
    throw new Error("Runtime state directory must be a real directory.");
  }
  assertOwnedByRuntime(pathStat, "Runtime state directory");
  if ((pathStat.mode & 0o022) !== 0) {
    throw new Error("Runtime state directory is writable by another user.");
  }
  const directory = await fs.open(
    stateDirectory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const openedStat = await directory.stat();
    if (
      !openedStat.isDirectory() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino
    ) {
      throw new Error("Runtime state directory changed during validation.");
    }
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}

async function readInstallationId(target: string): Promise<UUID | undefined> {
  let pathStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    pathStat = await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error("Runtime installation identity must be a regular file.");
  }
  assertOwnedByRuntime(pathStat, "Runtime installation identity");
  if (pathStat.nlink !== 1) {
    throw new Error(
      "Runtime installation identity must not have multiple links.",
    );
  }
  const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStat = await file.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino
    ) {
      throw new Error(
        "Runtime installation identity changed during validation.",
      );
    }
    assertOwnedByRuntime(openedStat, "Runtime installation identity");
    if ((openedStat.mode & 0o777) !== 0o600) {
      await file.chmod(0o600);
      await file.sync();
      const repaired = await file.stat();
      if ((repaired.mode & 0o777) !== 0o600) {
        throw new Error(
          "Runtime installation identity permissions are insecure.",
        );
      }
    }
    const value = (await file.readFile("utf8")).trim();
    if (!UUID_PATTERN.test(value)) {
      throw new Error(`Runtime installation identity is corrupt: ${target}`);
    }
    return value.toLowerCase() as UUID;
  } finally {
    await file.close();
  }
}

async function syncStateDirectory(
  directory: Awaited<ReturnType<typeof fs.open>>,
): Promise<void> {
  try {
    await directory.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // error-policy:J4 Node documents directory fsync as unsupported on Windows;
    // only those platform-specific errors degrade after the file itself is synced.
    if (
      process.platform !== "win32" ||
      (code !== "EINVAL" && code !== "EPERM")
    ) {
      throw error;
    }
  }
}

/** Loads one durable UUID per trusted state directory without following links. */
export async function loadOrCreateRuntimeInstallationId(
  stateDirectory: string,
): Promise<UUID> {
  const directory = await openTrustedStateDirectory(stateDirectory);
  const target = path.join(stateDirectory, INSTALLATION_ID_FILENAME);
  try {
    const existing = await readInstallationId(target);
    if (existing) return existing;

    const candidate = randomUUID() as UUID;
    const temporary = path.join(
      stateDirectory,
      `.${INSTALLATION_ID_FILENAME}.${randomUUID()}.tmp`,
    );
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${candidate}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await fs.link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        // error-policy:J2 A cleanup failure makes publication durability
        // ambiguous, so retain the original filesystem error for the boot boundary.
        if (error.code !== "ENOENT") throw error;
      });
    }
    await syncStateDirectory(directory);
    const published = await readInstallationId(target);
    if (!published) {
      throw new Error("Runtime installation identity was not published.");
    }
    return published;
  } finally {
    await directory.close();
  }
}

/** Loads identity, rechecks cancellation, and only then invokes the constructor. */
export async function constructWithRuntimeInstallationIdentity<T>(options: {
  stateDirectory: string;
  abortSignal?: AbortSignal;
  construct: (runtimeInstanceId: UUID) => T;
  load?: (stateDirectory: string) => Promise<UUID>;
}): Promise<T> {
  const runtimeInstanceId = await (
    options.load ?? loadOrCreateRuntimeInstallationId
  )(options.stateDirectory);
  options.abortSignal?.throwIfAborted();
  return options.construct(runtimeInstanceId);
}
