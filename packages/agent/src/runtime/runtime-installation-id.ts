/**
 * Persists the standalone host identity used to scope runtime-owned effects.
 *
 * POSIX ownership is the trust boundary: the state directory and its parent
 * must exclude writes by other users (a sticky root-owned parent is allowed),
 * and every candidate cleanup matches device/inode before unlinking. Same-UID
 * processes are therefore inside the runtime installation's trust domain.
 * Windows fails closed because this package has no ACL primitive that can prove
 * the equivalent boundary.
 */
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

/** Test-only phase controls for deterministic filesystem race probes. */
interface RuntimeInstallationIdTestControls {
  afterPreCreateValidation?: () => void | Promise<void>;
  afterIdentityLstat?: () => void | Promise<void>;
  afterIdentityOpen?: () => void | Promise<void>;
  beforeIdentityReturn?: () => void | Promise<void>;
  beforeIdentityPublication?: () => void | Promise<void>;
  afterTemporaryCreate?: () => void | Promise<void>;
  afterIdentityPublication?: () => void | Promise<void>;
}

interface TrustedDirectory {
  handle: FileHandle;
  stat: FileStat;
  parent: TrustedParentDirectory;
}

interface TrustedParentDirectory {
  handle: FileHandle;
  path: string;
  stat: FileStat;
}

export class RuntimeInstallationIdentityUnsupportedError extends Error {
  readonly code = "RUNTIME_INSTALLATION_ID_PLATFORM_UNSUPPORTED";

  constructor(message: string) {
    super(message);
    this.name = "RuntimeInstallationIdentityUnsupportedError";
  }
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

function assertTrustedDirectoryStat(stat: FileStat): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Runtime state directory must be a real directory.");
  }
  assertOwnedByRuntime(stat, "Runtime state directory");
  if ((Number(stat.mode) & 0o022) !== 0) {
    throw new Error("Runtime state directory is writable by another user.");
  }
}

function assertTrustedParentDirectoryStat(stat: FileStat): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Runtime state parent must be a real directory.");
  }
  const uid = currentUid();
  const mode = Number(stat.mode) & 0o7777;
  const isRuntimeOwned = uid === undefined || Number(stat.uid) === uid;
  const isRootOwnedStickyDirectory =
    Number(stat.uid) === 0 && (mode & 0o1000) !== 0;
  if (!isRuntimeOwned && !isRootOwnedStickyDirectory) {
    throw new Error("Runtime state parent is not owned by a trusted user.");
  }
  if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
    throw new Error("Runtime state parent is replaceable by another user.");
  }
}

async function revalidateParentPath(
  trusted: TrustedParentDirectory,
): Promise<void> {
  const [pathStat, descriptorStat] = await Promise.all([
    fs.lstat(trusted.path),
    trusted.handle.stat(),
  ]);
  assertTrustedParentDirectoryStat(pathStat);
  assertTrustedParentDirectoryStat(descriptorStat);
  if (
    !sameIdentity(pathStat, trusted.stat) ||
    !sameIdentity(descriptorStat, trusted.stat)
  ) {
    throw new Error("Runtime state parent changed during validation.");
  }
}

async function revalidateDirectoryPath(
  stateDirectory: string,
  trusted: TrustedDirectory,
): Promise<void> {
  const pathStat = await fs.lstat(stateDirectory);
  assertTrustedDirectoryStat(pathStat);
  if (!sameIdentity(pathStat, trusted.stat)) {
    throw new Error("Runtime state directory changed during validation.");
  }
  const openedStat = await trusted.handle.stat();
  if (!openedStat.isDirectory() || !sameIdentity(openedStat, pathStat)) {
    throw new Error("Runtime state directory changed during validation.");
  }
}

async function openTrustedStateDirectory(
  stateDirectory: string,
): Promise<TrustedDirectory> {
  const parentPath = path.dirname(stateDirectory);
  const parentPathStat = await fs.lstat(parentPath);
  assertTrustedParentDirectoryStat(parentPathStat);
  const parentHandle = await fs.open(
    parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const parent = {
    path: parentPath,
    stat: parentPathStat,
    handle: parentHandle,
  };
  try {
    await revalidateParentPath(parent);
    try {
      await fs.mkdir(stateDirectory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const pathStat = await fs.lstat(stateDirectory);
    assertTrustedDirectoryStat(pathStat);
    const handle = await fs.open(
      stateDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const trusted = { stat: pathStat, handle, parent };
    try {
      await revalidateDirectoryPath(stateDirectory, trusted);
      await revalidateParentPath(parent);
      return trusted;
    } catch (error) {
      await handle.close();
      throw error;
    }
  } catch (error) {
    await parentHandle.close();
    throw error;
  }
}

function assertTrustedIdentityStat(stat: FileStat): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Runtime installation identity must be a regular file.");
  }
  assertOwnedByRuntime(stat, "Runtime installation identity");
  if (Number(stat.nlink) !== 1) {
    throw new Error(
      "Runtime installation identity must not have multiple links.",
    );
  }
  if ((Number(stat.mode) & 0o777) !== 0o600) {
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
  await controls.beforeIdentityReturn?.();
  const [descriptorStat, pathStat] = await Promise.all([
    file.stat(),
    fs.lstat(target),
  ]);
  assertTrustedIdentityStat(descriptorStat);
  assertTrustedIdentityStat(pathStat);
  if (
    !sameIdentity(descriptorStat, openedStat) ||
    !sameIdentity(pathStat, descriptorStat)
  ) {
    throw new Error("Runtime installation identity changed during validation.");
  }
  await revalidateDirectoryPath(stateDirectory, trustedDirectory);
}

async function readInstallationId(
  target: string,
  stateDirectory: string,
  trustedDirectory: TrustedDirectory,
  controls: RuntimeInstallationIdTestControls,
): Promise<UUID | undefined> {
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
  const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
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
    if ((Number(openedStat.mode) & 0o777) !== 0o600) {
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

async function syncStateDirectory(trusted: TrustedDirectory): Promise<void> {
  await trusted.handle.sync();
}

async function pathsForTrustedDirectory(
  stateDirectory: string,
  trusted: TrustedDirectory,
): Promise<string[]> {
  await revalidateParentPath(trusted.parent);
  try {
    const currentStat = await fs.lstat(stateDirectory);
    if (
      currentStat.isDirectory() &&
      !currentStat.isSymbolicLink() &&
      sameIdentity(currentStat, trusted.stat)
    ) {
      return [stateDirectory];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const paths: string[] = [];
  // A same-UID fault may rename the directory despite the ownership boundary.
  // Locate its still-open inode under the trusted, identity-checked parent so
  // rollback can clean the moved directory without touching a replacement.
  const entries = await fs.opendir(trusted.parent.path);
  try {
    for await (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidatePath = path.join(trusted.parent.path, entry.name);
      let candidateStat: FileStat;
      try {
        candidateStat = await fs.lstat(candidatePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (
        candidateStat.isDirectory() &&
        !candidateStat.isSymbolicLink() &&
        sameIdentity(candidateStat, trusted.stat)
      ) {
        paths.push(candidatePath);
      }
    }
  } finally {
    await entries.close().catch((error: NodeJS.ErrnoException) => {
      // error-policy:J2 Directory enumeration cleanup is part of secure identity
      // cleanup, so a close failure remains fatal at the boot boundary.
      if (error.code !== "ERR_DIR_CLOSED") throw error;
    });
  }
  await revalidateParentPath(trusted.parent);
  return paths;
}

async function removeCandidateName(
  directory: string,
  name: string,
  candidateStat: FileStat,
): Promise<void> {
  const candidatePath = path.join(directory, name);
  try {
    const targetStat = await fs.lstat(candidatePath);
    if (
      targetStat.isFile() &&
      !targetStat.isSymbolicLink() &&
      sameIdentity(targetStat, candidateStat)
    ) {
      await fs.unlink(candidatePath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function cleanupCandidate(
  stateDirectory: string,
  trusted: TrustedDirectory,
  temporaryName: string,
  candidateStat: FileStat,
  removePublishedIdentity: boolean,
): Promise<void> {
  const directories = await pathsForTrustedDirectory(stateDirectory, trusted);
  for (const directory of directories) {
    if (removePublishedIdentity) {
      await removeCandidateName(
        directory,
        INSTALLATION_ID_FILENAME,
        candidateStat,
      );
    }
    await removeCandidateName(directory, temporaryName, candidateStat);
  }
}

/** Loads one durable UUID per trusted state directory without following links. */
async function loadOrCreateRuntimeInstallationIdImpl(
  stateDirectory: string,
  controls: RuntimeInstallationIdTestControls = {},
): Promise<UUID> {
  const resolvedStateDirectory = path.resolve(stateDirectory);
  const trustedDirectory = await openTrustedStateDirectory(
    resolvedStateDirectory,
  );
  const target = path.join(resolvedStateDirectory, INSTALLATION_ID_FILENAME);
  try {
    const existing = await readInstallationId(
      target,
      resolvedStateDirectory,
      trustedDirectory,
      controls,
    );
    if (existing) return existing;

    await revalidateDirectoryPath(resolvedStateDirectory, trustedDirectory);
    await revalidateParentPath(trustedDirectory.parent);
    await controls.afterPreCreateValidation?.();
    await revalidateDirectoryPath(resolvedStateDirectory, trustedDirectory);
    const candidate = randomUUID() as UUID;
    const temporaryName = `.${INSTALLATION_ID_FILENAME}.${randomUUID()}.tmp`;
    const temporary = path.join(resolvedStateDirectory, temporaryName);
    const file = await fs.open(temporary, "wx", 0o600);
    const candidateStat = await file.stat();
    let publishedCandidate = false;
    try {
      try {
        await file.writeFile(`${candidate}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      const temporaryPathStat = await fs.lstat(temporary);
      if (!sameIdentity(temporaryPathStat, candidateStat)) {
        throw new Error(
          "Runtime installation identity candidate changed during creation.",
        );
      }
      await controls.afterTemporaryCreate?.();
      await revalidateDirectoryPath(resolvedStateDirectory, trustedDirectory);
      await controls.beforeIdentityPublication?.();
      await revalidateDirectoryPath(resolvedStateDirectory, trustedDirectory);
      try {
        await fs.link(temporary, target);
        publishedCandidate = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await controls.afterIdentityPublication?.();
      await revalidateDirectoryPath(resolvedStateDirectory, trustedDirectory);
      await cleanupCandidate(
        resolvedStateDirectory,
        trustedDirectory,
        temporaryName,
        candidateStat,
        false,
      );
      await syncStateDirectory(trustedDirectory);
      const published = await readInstallationId(
        target,
        resolvedStateDirectory,
        trustedDirectory,
        controls,
      );
      if (!published) {
        throw new Error("Runtime installation identity was not published.");
      }
      return published;
    } catch (error) {
      await file.close().catch((closeError: NodeJS.ErrnoException) => {
        // error-policy:J2 The creation error remains authoritative when its
        // descriptor was already closed; any other close error is fail-closed.
        if (closeError.code !== "EBADF") throw closeError;
      });
      await cleanupCandidate(
        resolvedStateDirectory,
        trustedDirectory,
        temporaryName,
        candidateStat,
        publishedCandidate,
      );
      throw error;
    }
  } finally {
    try {
      await trustedDirectory.handle.close();
    } finally {
      await trustedDirectory.parent.handle.close();
    }
  }
}

/** Loads the host identity with production-fixed platform and filesystem policy. */
export async function loadOrCreateRuntimeInstallationId(
  stateDirectory: string,
): Promise<UUID> {
  if (process.platform === "win32") {
    throw new RuntimeInstallationIdentityUnsupportedError(
      "Secure runtime installation identity storage is unavailable on Windows.",
    );
  }
  return await loadOrCreateRuntimeInstallationIdImpl(stateDirectory);
}

/** @internal Test-only factory; stripped from production declarations. */
export function __createRuntimeInstallationIdLoaderForTests(
  controls: RuntimeInstallationIdTestControls,
): (stateDirectory: string) => Promise<UUID> {
  return async (stateDirectory) =>
    await loadOrCreateRuntimeInstallationIdImpl(stateDirectory, controls);
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
