/**
 * Persists the standalone host identity used to scope runtime-owned effects.
 *
 * POSIX ownership is the trust boundary: the state directory and every
 * controlling ancestor must exclude replacement by other users (a sticky
 * root-owned ancestor is allowed), and every candidate cleanup matches
 * device/inode before unlinking. Same-UID
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

interface TrustedDirectory {
  handle: FileHandle;
  stat: FileStat;
  parent: TrustedParentDirectory;
  ancestors: TrustedParentDirectory[];
  lexicalAncestors: TrustedLexicalEntry[];
}

interface TrustedParentDirectory {
  handle?: FileHandle;
  path: string;
  stat: FileStat;
  validation: "descriptor" | "android-platform";
}

interface TrustedLexicalEntry {
  handle?: FileHandle;
  path: string;
  stat: FileStat;
  validation: "descriptor" | "symlink" | "android-platform";
}

interface AndroidStateBoundary {
  appDataDirectory: string;
}

export class RuntimeInstallationIdentityUnsupportedError extends Error {
  readonly code = "RUNTIME_INSTALLATION_ID_PLATFORM_UNSUPPORTED";

  constructor(message: string) {
    super(message);
    this.name = "RuntimeInstallationIdentityUnsupportedError";
  }
}

export class RuntimeInstallationIdentityRecoveryError extends Error {
  readonly code = "RUNTIME_INSTALLATION_ID_RECOVERY_AMBIGUOUS";

  constructor(message: string, options: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeInstallationIdentityRecoveryError";
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
  const isTrustedOwner =
    uid === undefined || Number(stat.uid) === uid || Number(stat.uid) === 0;
  if (!isTrustedOwner) {
    throw new Error("Runtime state parent is not owned by a trusted user.");
  }
  if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
    throw new Error("Runtime state parent is replaceable by another user.");
  }
}

function ancestorPaths(directory: string): string[] {
  const root = path.parse(directory).root;
  const relativeParts = path
    .relative(root, directory)
    .split(path.sep)
    .filter(Boolean);
  const paths = [root];
  let current = root;
  for (const part of relativeParts) {
    current = path.join(current, part);
    paths.push(current);
  }
  return paths;
}

function isSameOrDescendant(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolveAndroidStateBoundary(
  stateDirectory: string,
): AndroidStateBoundary | undefined {
  if (process.env.ELIZA_PLATFORM?.trim().toLowerCase() !== "android") {
    return undefined;
  }
  const configured = process.env.ELIZA_ANDROID_APP_DATA_DIR?.trim();
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error(
      "Android runtime installation identity requires an absolute ELIZA_ANDROID_APP_DATA_DIR.",
    );
  }
  const appDataDirectory = path.resolve(configured);
  if (!isSameOrDescendant(path.resolve(stateDirectory), appDataDirectory)) {
    throw new Error(
      "Android runtime state directory must remain inside ELIZA_ANDROID_APP_DATA_DIR.",
    );
  }
  return { appDataDirectory };
}

function isAndroidPlatformAncestor(
  entryPath: string,
  boundary: AndroidStateBoundary | undefined,
): boolean {
  return (
    boundary !== undefined &&
    entryPath !== boundary.appDataDirectory &&
    isSameOrDescendant(boundary.appDataDirectory, entryPath)
  );
}

function assertAndroidPlatformAncestorStat(stat: FileStat): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Android app-data ancestor must be a real directory.");
  }
}

function isDescriptorParent(
  entry: TrustedParentDirectory,
): entry is TrustedParentDirectory & { handle: FileHandle } {
  return entry.validation === "descriptor" && entry.handle !== undefined;
}

async function closeAncestors(
  ancestors: TrustedParentDirectory[],
): Promise<void> {
  let failure: unknown;
  for (const ancestor of [...ancestors].reverse()) {
    if (!ancestor.handle) continue;
    try {
      await ancestor.handle.close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

async function closeLexicalAncestors(
  ancestors: TrustedLexicalEntry[],
): Promise<void> {
  await closeAncestors(
    ancestors.filter(
      (ancestor): ancestor is TrustedParentDirectory =>
        ancestor.handle !== undefined,
    ),
  );
}

function assertTrustedSymlinkStat(stat: FileStat): void {
  if (!stat.isSymbolicLink()) {
    throw new Error(
      "Runtime state lexical redirect changed during validation.",
    );
  }
  const uid = currentUid();
  if (uid !== undefined && Number(stat.uid) !== uid && Number(stat.uid) !== 0) {
    throw new Error("Runtime state lexical redirect has an untrusted owner.");
  }
}

async function openTrustedLexicalChain(
  directory: string,
  androidBoundary: AndroidStateBoundary | undefined,
): Promise<TrustedLexicalEntry[]> {
  const paths = ancestorPaths(directory);
  const trusted: TrustedLexicalEntry[] = [];
  try {
    for (const [index, entryPath] of paths.entries()) {
      const stat = await fs.lstat(entryPath);
      if (isAndroidPlatformAncestor(entryPath, androidBoundary)) {
        assertAndroidPlatformAncestorStat(stat);
        trusted.push({
          path: entryPath,
          stat,
          validation: "android-platform",
        });
        continue;
      }
      if (stat.isSymbolicLink()) {
        if (index === paths.length - 1) {
          throw new Error("Runtime state parent must be a real directory.");
        }
        assertTrustedSymlinkStat(stat);
        trusted.push({ path: entryPath, stat, validation: "symlink" });
        continue;
      }
      assertTrustedParentDirectoryStat(stat);
      const handle = await fs.open(
        entryPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      trusted.push({
        path: entryPath,
        stat,
        handle,
        validation: "descriptor",
      });
    }
    await revalidateLexicalChain(trusted);
    return trusted;
  } catch (error) {
    await closeLexicalAncestors(trusted);
    throw error;
  }
}

async function revalidateLexicalChain(
  ancestors: TrustedLexicalEntry[],
): Promise<void> {
  for (const ancestor of ancestors) {
    const pathStat = await fs.lstat(ancestor.path);
    if (!sameIdentity(pathStat, ancestor.stat)) {
      throw new Error("Runtime state lexical path changed during validation.");
    }
    if (ancestor.validation === "android-platform") {
      assertAndroidPlatformAncestorStat(pathStat);
      continue;
    }
    if (ancestor.validation === "symlink") {
      assertTrustedSymlinkStat(pathStat);
      continue;
    }
    if (!ancestor.handle) {
      throw new Error("Runtime state lexical descriptor is unavailable.");
    }
    assertTrustedParentDirectoryStat(pathStat);
    const descriptorStat = await ancestor.handle.stat();
    assertTrustedParentDirectoryStat(descriptorStat);
    if (!sameIdentity(descriptorStat, ancestor.stat)) {
      throw new Error("Runtime state lexical path changed during validation.");
    }
  }
}

async function revalidateAncestorChain(
  ancestors: TrustedParentDirectory[],
): Promise<void> {
  for (const ancestor of ancestors) await revalidateParentPath(ancestor);
}

async function revalidateParentPath(
  trusted: TrustedParentDirectory,
): Promise<void> {
  const pathStat = await fs.lstat(trusted.path);
  if (trusted.validation === "android-platform") {
    assertAndroidPlatformAncestorStat(pathStat);
    if (!sameIdentity(pathStat, trusted.stat)) {
      throw new Error("Runtime state parent changed during validation.");
    }
    return;
  }
  if (!trusted.handle) {
    throw new Error("Runtime state parent descriptor is unavailable.");
  }
  const descriptorStat = await trusted.handle.stat();
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
  lexicalAncestors: TrustedLexicalEntry[],
  androidBoundary: AndroidStateBoundary | undefined,
): Promise<TrustedDirectory> {
  const parentPath = path.dirname(stateDirectory);
  const ancestors: TrustedParentDirectory[] = [];
  try {
    for (const ancestorPath of ancestorPaths(parentPath)) {
      const ancestorStat = await fs.lstat(ancestorPath);
      if (isAndroidPlatformAncestor(ancestorPath, androidBoundary)) {
        assertAndroidPlatformAncestorStat(ancestorStat);
        ancestors.push({
          path: ancestorPath,
          stat: ancestorStat,
          validation: "android-platform",
        });
        continue;
      }
      assertTrustedParentDirectoryStat(ancestorStat);
      const handle = await fs.open(
        ancestorPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      ancestors.push({
        path: ancestorPath,
        stat: ancestorStat,
        handle,
        validation: "descriptor",
      });
    }
    const parent = ancestors.at(-1);
    if (!parent) throw new Error("Runtime state parent chain is empty.");
    if (!isDescriptorParent(parent)) {
      throw new Error("Runtime state parent must have a trusted descriptor.");
    }
    await revalidateAncestorChain(ancestors);
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
    const trusted = {
      stat: pathStat,
      handle,
      parent,
      ancestors,
      lexicalAncestors,
    };
    try {
      await revalidateDirectoryPath(stateDirectory, trusted);
      await revalidateAncestorChain(ancestors);
      await revalidateLexicalChain(lexicalAncestors);
      return trusted;
    } catch (error) {
      await handle.close();
      throw error;
    }
  } catch (error) {
    await closeAncestors(ancestors);
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
): Promise<void> {
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
  try {
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
    await trusted.handle.sync();
  } catch (error) {
    throw new RuntimeInstallationIdentityRecoveryError(
      "Runtime installation identity rollback could not be durably confirmed.",
      { cause: error },
    );
  }
}

/** Loads one durable UUID per trusted state directory without following links. */
async function loadOrCreateRuntimeInstallationIdImpl(
  stateDirectory: string,
): Promise<UUID> {
  const requestedStateDirectory = path.resolve(stateDirectory);
  const androidBoundary = resolveAndroidStateBoundary(requestedStateDirectory);
  const requestedParent = path.dirname(requestedStateDirectory);
  const lexicalAncestors = await openTrustedLexicalChain(
    requestedParent,
    androidBoundary,
  );
  let trustedDirectory: TrustedDirectory;
  let resolvedStateDirectory: string;
  try {
    resolvedStateDirectory = path.join(
      await fs.realpath(requestedParent),
      path.basename(requestedStateDirectory),
    );
    if (
      androidBoundary &&
      !isSameOrDescendant(
        resolvedStateDirectory,
        androidBoundary.appDataDirectory,
      )
    ) {
      throw new Error(
        "Resolved Android runtime state directory escaped ELIZA_ANDROID_APP_DATA_DIR.",
      );
    }
    trustedDirectory = await openTrustedStateDirectory(
      resolvedStateDirectory,
      lexicalAncestors,
      androidBoundary,
    );
  } catch (error) {
    await closeLexicalAncestors(lexicalAncestors);
    throw error;
  }
  const target = path.join(resolvedStateDirectory, INSTALLATION_ID_FILENAME);
  const execute = async (): Promise<UUID> => {
    const existing = await readInstallationId(
      target,
      resolvedStateDirectory,
      trustedDirectory,
    );
    if (existing) return existing;

    await revalidateDirectoryPath(resolvedStateDirectory, trustedDirectory);
    await revalidateAncestorChain(trustedDirectory.ancestors);
    await revalidateLexicalChain(trustedDirectory.lexicalAncestors);
    await revalidateDirectoryPath(resolvedStateDirectory, trustedDirectory);
    const candidate = randomUUID() as UUID;
    const temporaryName = `.${INSTALLATION_ID_FILENAME}.${randomUUID()}.tmp`;
    const temporary = path.join(resolvedStateDirectory, temporaryName);
    const file = await fs.open(temporary, "wx", 0o600);
    let candidateStat: FileStat | undefined;
    let publishedCandidate = false;
    try {
      candidateStat = await file.stat();
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
      await revalidateDirectoryPath(resolvedStateDirectory, trustedDirectory);
      await revalidateDirectoryPath(resolvedStateDirectory, trustedDirectory);
      try {
        await fs.link(temporary, target);
        publishedCandidate = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
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
      );
      if (!published) {
        throw new Error("Runtime installation identity was not published.");
      }
      return published;
    } catch (error) {
      let closeFailure: unknown;
      try {
        await file.close();
      } catch (closeError) {
        if ((closeError as NodeJS.ErrnoException).code !== "EBADF") {
          closeFailure = closeError;
        }
      }
      try {
        if (candidateStat) {
          await cleanupCandidate(
            resolvedStateDirectory,
            trustedDirectory,
            temporaryName,
            candidateStat,
            publishedCandidate,
          );
        } else {
          await revalidateDirectoryPath(
            resolvedStateDirectory,
            trustedDirectory,
          );
          await fs.unlink(temporary);
          await trustedDirectory.handle.sync();
        }
      } catch (cleanupError) {
        throw new RuntimeInstallationIdentityRecoveryError(
          "Runtime installation identity candidate cleanup is ambiguous.",
          {
            cause: new AggregateError(
              [error, closeFailure, cleanupError].filter(
                (failure) => failure !== undefined,
              ),
            ),
          },
        );
      }
      if (closeFailure) {
        throw new RuntimeInstallationIdentityRecoveryError(
          "Runtime installation identity candidate descriptor did not close cleanly.",
          { cause: new AggregateError([error, closeFailure]) },
        );
      }
      throw error;
    }
  };
  let result: UUID | undefined;
  let operationError: unknown;
  try {
    result = await execute();
  } catch (error) {
    operationError = error;
  }
  let closeError: unknown;
  try {
    await trustedDirectory.handle.close();
  } catch (failure) {
    closeError = failure;
  }
  try {
    await closeAncestors(trustedDirectory.ancestors);
  } catch (failure) {
    closeError ??= failure;
  }
  try {
    await closeLexicalAncestors(trustedDirectory.lexicalAncestors);
  } catch (failure) {
    closeError ??= failure;
  }
  if (
    operationError instanceof RuntimeInstallationIdentityRecoveryError &&
    closeError
  ) {
    throw new RuntimeInstallationIdentityRecoveryError(operationError.message, {
      cause: new AggregateError([operationError, closeError]),
    });
  }
  if (operationError) throw operationError;
  if (closeError) throw closeError;
  if (!result)
    throw new Error("Runtime installation identity was unavailable.");
  return result;
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
