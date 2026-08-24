/** Persists the standalone host identity used to scope runtime-owned effects. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { UUID } from "@elizaos/core";

const INSTALLATION_ID_FILENAME = "runtime-installation-id";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type FileHandle = Awaited<ReturnType<typeof fs.open>>;
type FileStat = Awaited<ReturnType<typeof fs.lstat>>;

/** Test-only phase controls for deterministic filesystem race and platform probes. */
export interface RuntimeInstallationIdTestControls {
  platform?: NodeJS.Platform;
  openDirectory?: (directory: string, flags: number) => Promise<FileHandle>;
  syncDirectory?: (directory: FileHandle) => Promise<void>;
  afterDirectoryValidation?: () => void | Promise<void>;
  afterIdentityLstat?: () => void | Promise<void>;
  afterIdentityOpen?: () => void | Promise<void>;
  beforeIdentityReturn?: () => void | Promise<void>;
  beforeIdentityPublication?: () => void | Promise<void>;
}

interface TrustedDirectory {
  handle?: FileHandle;
  stat: FileStat;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwnedByRuntime(stat: FileStat, label: string): void {
  const uid = currentUid();
  if (uid !== undefined && Number(stat.uid) !== uid) {
    throw new Error(`${label} is not owned by the runtime user.`);
  }
}

function sameIdentity(left: FileStat, right: FileStat): boolean {
  return (
    String(left.dev) === String(right.dev) &&
    String(left.ino) === String(right.ino)
  );
}

function assertTrustedDirectoryStat(
  stat: FileStat,
  platform: NodeJS.Platform,
): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Runtime state directory must be a real directory.");
  }
  assertOwnedByRuntime(stat, "Runtime state directory");
  // POSIX mode bits are meaningful here. Windows trust is supplied by its ACL;
  // treating emulated mode bits as an ACL proof would reject or bless paths falsely.
  if (platform !== "win32" && (Number(stat.mode) & 0o022) !== 0) {
    throw new Error("Runtime state directory is writable by another user.");
  }
}

async function revalidateDirectoryPath(
  stateDirectory: string,
  trusted: TrustedDirectory,
  platform: NodeJS.Platform,
): Promise<void> {
  const pathStat = await fs.lstat(stateDirectory);
  assertTrustedDirectoryStat(pathStat, platform);
  if (!sameIdentity(pathStat, trusted.stat)) {
    throw new Error("Runtime state directory changed during validation.");
  }
  if (trusted.handle) {
    const openedStat = await trusted.handle.stat();
    if (!openedStat.isDirectory() || !sameIdentity(openedStat, pathStat)) {
      throw new Error("Runtime state directory changed during validation.");
    }
  }
}

function isUnsupportedWindowsDirectoryIo(
  error: unknown,
  platform: NodeJS.Platform,
): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return platform === "win32" && (code === "EINVAL" || code === "EPERM");
}

async function openTrustedStateDirectory(
  stateDirectory: string,
  controls: RuntimeInstallationIdTestControls,
): Promise<TrustedDirectory> {
  const platform = controls.platform ?? process.platform;
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const pathStat = await fs.lstat(stateDirectory);
  assertTrustedDirectoryStat(pathStat, platform);
  const openDirectory = controls.openDirectory ?? fs.open;
  const flags =
    platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let handle: FileHandle | undefined;
  try {
    handle = await openDirectory(stateDirectory, flags);
  } catch (error) {
    // error-policy:J4 Windows may reject opening a directory descriptor with
    // EINVAL/EPERM. Path identity is still revalidated before every commit/return.
    if (!isUnsupportedWindowsDirectoryIo(error, platform)) throw error;
  }
  const trusted = { stat: pathStat, ...(handle ? { handle } : {}) };
  try {
    await revalidateDirectoryPath(stateDirectory, trusted, platform);
    await controls.afterDirectoryValidation?.();
    return trusted;
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

function assertTrustedIdentityStat(
  stat: FileStat,
  platform: NodeJS.Platform,
): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Runtime installation identity must be a regular file.");
  }
  assertOwnedByRuntime(stat, "Runtime installation identity");
  if (Number(stat.nlink) !== 1) {
    throw new Error(
      "Runtime installation identity must not have multiple links.",
    );
  }
  if (platform !== "win32" && (Number(stat.mode) & 0o777) !== 0o600) {
    throw new Error("Runtime installation identity permissions are insecure.");
  }
}

async function finalIdentityRevalidation(
  target: string,
  file: FileHandle,
  openedStat: FileStat,
  stateDirectory: string,
  trustedDirectory: TrustedDirectory,
  controls: RuntimeInstallationIdTestControls,
): Promise<void> {
  const platform = controls.platform ?? process.platform;
  await controls.beforeIdentityReturn?.();
  const [descriptorStat, pathStat] = await Promise.all([
    file.stat(),
    fs.lstat(target),
  ]);
  assertTrustedIdentityStat(descriptorStat, platform);
  assertTrustedIdentityStat(pathStat, platform);
  if (
    !sameIdentity(descriptorStat, openedStat) ||
    !sameIdentity(pathStat, descriptorStat)
  ) {
    throw new Error("Runtime installation identity changed during validation.");
  }
  await revalidateDirectoryPath(stateDirectory, trustedDirectory, platform);
}

async function readInstallationId(
  target: string,
  stateDirectory: string,
  trustedDirectory: TrustedDirectory,
  controls: RuntimeInstallationIdTestControls,
): Promise<UUID | undefined> {
  const platform = controls.platform ?? process.platform;
  let pathStat: FileStat;
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
  if (Number(pathStat.nlink) !== 1) {
    throw new Error(
      "Runtime installation identity must not have multiple links.",
    );
  }
  await controls.afterIdentityLstat?.();
  const fileFlags =
    platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW;
  const file = await fs.open(target, fileFlags);
  try {
    const openedStat = await file.stat();
    if (!openedStat.isFile() || !sameIdentity(openedStat, pathStat)) {
      throw new Error(
        "Runtime installation identity changed during validation.",
      );
    }
    assertOwnedByRuntime(openedStat, "Runtime installation identity");
    if (Number(openedStat.nlink) !== 1) {
      throw new Error(
        "Runtime installation identity must not have multiple links.",
      );
    }
    if (platform !== "win32" && (Number(openedStat.mode) & 0o777) !== 0o600) {
      await file.chmod(0o600);
      await file.sync();
    }
    await controls.afterIdentityOpen?.();
    const value = (await file.readFile("utf8")).trim();
    if (!UUID_PATTERN.test(value)) {
      throw new Error(`Runtime installation identity is corrupt: ${target}`);
    }
    await finalIdentityRevalidation(
      target,
      file,
      openedStat,
      stateDirectory,
      trustedDirectory,
      controls,
    );
    return value.toLowerCase() as UUID;
  } finally {
    await file.close();
  }
}

async function syncStateDirectory(
  trusted: TrustedDirectory,
  controls: RuntimeInstallationIdTestControls,
): Promise<void> {
  if (!trusted.handle) return;
  const platform = controls.platform ?? process.platform;
  const syncDirectory = controls.syncDirectory ?? ((handle) => handle.sync());
  try {
    await syncDirectory(trusted.handle);
  } catch (error) {
    // error-policy:J4 Only Windows' documented unsupported-directory errors
    // degrade after the identity file itself has been synced.
    if (!isUnsupportedWindowsDirectoryIo(error, platform)) throw error;
  }
}

async function removePublishedCandidate(
  target: string,
  candidateStat: FileStat,
): Promise<void> {
  try {
    const targetStat = await fs.lstat(target);
    if (targetStat.isFile() && sameIdentity(targetStat, candidateStat)) {
      await fs.unlink(target);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Loads one durable UUID per trusted state directory without following links. */
export async function loadOrCreateRuntimeInstallationId(
  stateDirectory: string,
  controls: RuntimeInstallationIdTestControls = {},
): Promise<UUID> {
  const platform = controls.platform ?? process.platform;
  const trustedDirectory = await openTrustedStateDirectory(
    stateDirectory,
    controls,
  );
  const target = path.join(stateDirectory, INSTALLATION_ID_FILENAME);
  try {
    const existing = await readInstallationId(
      target,
      stateDirectory,
      trustedDirectory,
      controls,
    );
    if (existing) return existing;

    await revalidateDirectoryPath(stateDirectory, trustedDirectory, platform);
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
    const candidateStat = await fs.lstat(temporary);
    await revalidateDirectoryPath(stateDirectory, trustedDirectory, platform);
    await controls.beforeIdentityPublication?.();
    let publishedCandidate = false;
    try {
      try {
        await fs.link(temporary, target);
        publishedCandidate = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      try {
        await revalidateDirectoryPath(
          stateDirectory,
          trustedDirectory,
          platform,
        );
      } catch (error) {
        if (publishedCandidate) {
          await removePublishedCandidate(target, candidateStat);
        }
        throw error;
      }
    } finally {
      await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        // error-policy:J2 A cleanup failure makes publication durability
        // ambiguous, so retain the original filesystem error for the boot boundary.
        if (error.code !== "ENOENT") throw error;
      });
    }
    await syncStateDirectory(trustedDirectory, controls);
    const published = await readInstallationId(
      target,
      stateDirectory,
      trustedDirectory,
      controls,
    );
    if (!published) {
      throw new Error("Runtime installation identity was not published.");
    }
    return published;
  } finally {
    await trustedDirectory.handle?.close();
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
