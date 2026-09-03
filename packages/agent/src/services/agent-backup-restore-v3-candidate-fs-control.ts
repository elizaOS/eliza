/**
 * Linux FD authority, operation control, and inode-scoped kernel locking for
 * restore-v3 candidate filesystem operations.
 */

import { Buffer } from "node:buffer";
import { type ChildProcess, spawn } from "node:child_process";
import { type BigIntStats, constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";
import { ElizaError } from "@elizaos/core";
import type { AgentBackupRestoreV3OperationControl } from "@elizaos/shared";

export const CANDIDATE_FS_IO_CHUNK_BYTES = 256 * 1024;
const MAX_CONTROL_NAME_BYTES = 96;
const MAX_RELATIVE_PATH_BYTES = 1_024;
const INTERNAL_CLEANUP_DEADLINE_MS = 5_000;
const INTERNAL_CONTROL_DEADLINE_MS = 60_000;
const LOCK_START_DEADLINE_MS = 5_000;
const TEST_PLATFORM_LOCKS = new Set<string>();
const ABORT_SIGNAL_ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;
const ABORT_SIGNAL_REASON_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "reason",
)?.get;

export interface AgentBackupRestoreV3CandidateFsIdentity {
  readonly device: string;
  readonly inode: string;
}

export interface OpenAgentBackupRestoreV3CandidateFsInput {
  /** Existing absolute, private directory that never contains live sandbox state. */
  readonly trustedRoot: string;
  /** Existing absolute, private strict descendant dedicated to one restore attempt. */
  readonly attemptRoot: string;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
  /**
   * Test-only pathname emulation for non-Linux CI. It has no production
   * security claim and is rejected outside NODE_ENV=test.
   */
  readonly testOnlyAllowNonLinuxFdEmulation?: true;
}

export class AgentBackupRestoreV3CandidateFsError extends ElizaError {
  override readonly name = "AgentBackupRestoreV3CandidateFsError";

  constructor(
    code: string,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly context?: Record<string, unknown>;
      readonly severity?: "ephemeral" | "fatal";
    } = {},
  ) {
    super(message, {
      code,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      ...(options.context === undefined ? {} : { context: options.context }),
      severity: options.severity ?? "fatal",
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface CandidateFsExactStats {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: number;
  readonly linkCount: number;
  readonly size: number;
  readonly modifiedNanoseconds: bigint;
  readonly changedNanoseconds: bigint;
  readonly directory: boolean;
  readonly file: boolean;
  readonly symbolicLink: boolean;
}

export interface CandidateFsDirectoryAuthority {
  readonly path: string;
  readonly stats: CandidateFsExactStats;
  readonly handle: FileHandle;
  readonly anchor: string;
  readonly testOnlyPathnameEmulation: boolean;
}

export interface CandidateFsOpenedDirectory {
  readonly handle: FileHandle;
  readonly stats: CandidateFsExactStats;
  readonly anchor: string;
  readonly testPath: string;
}

export function candidateFsError(
  code: string,
  message: string,
  options?: ConstructorParameters<
    typeof AgentBackupRestoreV3CandidateFsError
  >[2],
): never {
  throw new AgentBackupRestoreV3CandidateFsError(code, message, options);
}

export function isErrno(
  cause: unknown,
  code: string,
): cause is NodeJS.ErrnoException {
  return (
    cause instanceof Error && (cause as NodeJS.ErrnoException).code === code
  );
}

function exactStats(stats: BigIntStats): CandidateFsExactStats {
  if (
    stats.size < 0n ||
    stats.size > BigInt(Number.MAX_SAFE_INTEGER) ||
    stats.nlink < 0n ||
    stats.nlink > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_STAT_INVALID",
      "Candidate filesystem returned an unrepresentable file identity",
    );
  }
  return Object.freeze({
    device: stats.dev,
    inode: stats.ino,
    mode: Number(stats.mode),
    linkCount: Number(stats.nlink),
    size: Number(stats.size),
    modifiedNanoseconds: stats.mtimeNs,
    changedNanoseconds: stats.ctimeNs,
    directory: stats.isDirectory(),
    file: stats.isFile(),
    symbolicLink: stats.isSymbolicLink(),
  });
}

export async function lstatExact(
  target: string,
): Promise<CandidateFsExactStats> {
  return exactStats(await fs.lstat(target, { bigint: true }));
}

export async function fileStatExact(
  handle: FileHandle,
): Promise<CandidateFsExactStats> {
  return exactStats(await handle.stat({ bigint: true }));
}

export function sameIdentity(
  left: CandidateFsExactStats,
  right: CandidateFsExactStats,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function sameStableFile(
  left: CandidateFsExactStats,
  right: CandidateFsExactStats,
): boolean {
  return (
    sameIdentity(left, right) &&
    left.file === right.file &&
    left.symbolicLink === right.symbolicLink &&
    left.linkCount === right.linkCount &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.modifiedNanoseconds === right.modifiedNanoseconds &&
    left.changedNanoseconds === right.changedNanoseconds
  );
}

export function requirePositiveSafeInteger(
  value: number,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || Object.is(value, -0)) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LIMIT_INVALID",
      `${field} must be a positive safe integer`,
    );
  }
  return value;
}

export function snapshotOwnDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  code: string,
  message: string,
): Readonly<Record<string, unknown>> {
  if (
    !value ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    candidateFsError(code, message);
  }
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(allowedKeys);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    requiredKeys.some((key) => !keys.includes(key))
  ) {
    candidateFsError(code, message);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      candidateFsError(code, message);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

export function assertActive(
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): void {
  const signalDescriptor =
    control && typeof control === "object"
      ? Object.getOwnPropertyDescriptor(control, "signal")
      : undefined;
  const deadlineDescriptor =
    control && typeof control === "object"
      ? Object.getOwnPropertyDescriptor(control, "deadlineEpochMs")
      : undefined;
  const signal =
    signalDescriptor && "value" in signalDescriptor
      ? signalDescriptor.value
      : undefined;
  const deadlineEpochMs =
    deadlineDescriptor && "value" in deadlineDescriptor
      ? deadlineDescriptor.value
      : undefined;
  let aborted: boolean;
  try {
    aborted = Boolean(
      ABORT_SIGNAL_ABORTED_GETTER &&
        Reflect.apply(ABORT_SIGNAL_ABORTED_GETTER, signal, []),
    );
  } catch {
    aborted = false;
  }
  if (
    !ABORT_SIGNAL_ABORTED_GETTER ||
    !ABORT_SIGNAL_REASON_GETTER ||
    !signalDescriptor ||
    !("value" in signalDescriptor) ||
    !deadlineDescriptor ||
    !("value" in deadlineDescriptor) ||
    !Number.isSafeInteger(deadlineEpochMs) ||
    deadlineEpochMs <= 0 ||
    Object.is(deadlineEpochMs, -0) ||
    (!aborted &&
      (() => {
        try {
          Reflect.apply(ABORT_SIGNAL_REASON_GETTER, signal, []);
          return false;
        } catch {
          return true;
        }
      })())
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CONTROL_INVALID",
      "Candidate filesystem requires an explicit canonical signal and deadline",
    );
  }
  if (aborted) {
    const reason = Reflect.apply(ABORT_SIGNAL_REASON_GETTER, signal, []);
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ABORTED",
      "Candidate filesystem operation was cancelled",
      {
        ...(reason === undefined ? {} : { cause: reason }),
        severity: "ephemeral",
      },
    );
  }
  if (Date.now() >= deadlineEpochMs) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_DEADLINE_EXCEEDED",
      "Candidate filesystem operation exceeded its deadline",
      { severity: "ephemeral" },
    );
  }
}

export function snapshotOperationControl(
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Readonly<AgentBackupRestoreV3OperationControl> {
  const record = snapshotOwnDataRecord(
    control,
    ["signal", "deadlineEpochMs"],
    ["signal", "deadlineEpochMs"],
    "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CONTROL_INVALID",
    "Candidate filesystem requires an explicit canonical signal and deadline",
  );
  const snapshot = Object.freeze({
    signal: record.signal,
    deadlineEpochMs: record.deadlineEpochMs,
  }) as Readonly<AgentBackupRestoreV3OperationControl>;
  assertActive(snapshot);
  return snapshot;
}

export async function controlled<T>(
  operation: () => Promise<T>,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<T> {
  assertActive(control);
  const value = await operation();
  assertActive(control);
  return value;
}

export async function boundedInternalCleanup(
  operation: () => Promise<void>,
): Promise<void> {
  const deadlineEpochMs = Date.now() + INTERNAL_CLEANUP_DEADLINE_MS;
  // Node's local filesystem promises are not cancellable. Never abandon one
  // on a timer: doing so would permit a late unlink/close after the inode lock
  // was released. Await exact settlement, then fail the cleanup deadline if
  // the operation did not settle within the independent acceptance bound.
  await operation();
  if (Date.now() >= deadlineEpochMs) {
    throw new AgentBackupRestoreV3CandidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_DEADLINE",
      "Candidate filesystem internal cleanup exceeded its independent deadline after exact settlement",
      { severity: "ephemeral" },
    );
  }
}

export async function runAllBoundedInternalCleanup(
  operations: readonly (() => Promise<void>)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const operation of operations) {
    try {
      await boundedInternalCleanup(operation);
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures);
}

export async function controlledAcquire<T>(
  operation: () => Promise<T>,
  dispose: (value: T) => Promise<void>,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<T> {
  assertActive(control);
  const value = await operation();
  try {
    assertActive(control);
    return value;
  } catch (cause) {
    try {
      await boundedInternalCleanup(() => dispose(value));
    } catch (cleanupCause) {
      throw new AgentBackupRestoreV3CandidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LATE_ACQUIRE_CLEANUP_FAILED",
        "Candidate filesystem acquired a resource after cancellation and could not dispose it",
        { cause: new AggregateError([cause, cleanupCause]) },
      );
    }
    throw cause;
  }
}

export function internalCleanupControl(): Readonly<AgentBackupRestoreV3OperationControl> {
  return Object.freeze({
    signal: new AbortController().signal,
    deadlineEpochMs: Date.now() + INTERNAL_CONTROL_DEADLINE_MS,
  });
}

function requireAbsoluteCanonicalPath(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    value.includes("\0")
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ROOT_INVALID",
      `${field} must be an absolute canonical path`,
    );
  }
  return value;
}

function isStrictlyWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function hasAsciiControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

export function requireControlName(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.trim() !== value ||
    value.includes("/") ||
    value.includes("\\") ||
    hasAsciiControl(value) ||
    Buffer.byteLength(value, "utf8") > MAX_CONTROL_NAME_BYTES
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PATH_FORBIDDEN",
      `${field} must be one bounded direct-child name`,
    );
  }
  return value;
}

export function requirePathSegment(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    hasAsciiControl(value) ||
    Buffer.byteLength(value, "utf8") > 255
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PATH_FORBIDDEN",
      `${field} must be one bounded no-follow path component`,
    );
  }
  return value;
}

export function requireRelativePath(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_RELATIVE_PATH_BYTES
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PATH_FORBIDDEN",
      `${field} must be one bounded relative path`,
    );
  }
  const segments = value.split("/");
  if (
    segments.some((segment) => {
      try {
        requirePathSegment(segment, field);
        return false;
      } catch {
        return true;
      }
    })
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PATH_FORBIDDEN",
      `${field} contains an unsafe path segment`,
    );
  }
  return segments.join(path.sep);
}

export function requirePrivateDirectory(
  stats: CandidateFsExactStats,
  message: string,
): void {
  if (!stats.directory || stats.symbolicLink || (stats.mode & 0o7077) !== 0) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ROOT_INVALID",
      message,
    );
  }
}

export function requirePrivateSingleLinkFile(
  stats: CandidateFsExactStats,
  code: string,
  message: string,
): void {
  if (
    !stats.file ||
    stats.symbolicLink ||
    stats.linkCount !== 1 ||
    (stats.mode & 0o7077) !== 0
  ) {
    candidateFsError(code, message);
  }
}

export function candidateFsIdentity(
  stats: CandidateFsExactStats,
): AgentBackupRestoreV3CandidateFsIdentity {
  return Object.freeze({
    device: stats.device.toString(10),
    inode: stats.inode.toString(10),
  });
}

async function resolveDirectoryAuthority(
  requested: string,
  field: string,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  testOnlyPathnameEmulation: boolean,
): Promise<CandidateFsDirectoryAuthority> {
  const canonical = requireAbsoluteCanonicalPath(requested, field);
  let handle: FileHandle | undefined;
  try {
    handle = await controlledAcquire(
      () =>
        fs.open(
          canonical,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ),
      (lateHandle) => lateHandle.close(),
      control,
    );
    const [realPath, visible, opened] = await controlled(
      () =>
        Promise.all([
          fs.realpath(canonical),
          lstatExact(canonical),
          fileStatExact(handle as FileHandle),
        ]),
      control,
    );
    requirePrivateDirectory(
      opened,
      `${field} must be a private real directory`,
    );
    if (
      realPath !== canonical ||
      !sameIdentity(visible, opened) ||
      visible.mode !== opened.mode
    ) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ROOT_INVALID",
        `${field} cannot traverse a symbolic link or change while opening`,
      );
    }
    return Object.freeze({
      path: canonical,
      stats: opened,
      handle,
      anchor: testOnlyPathnameEmulation
        ? canonical
        : `/proc/self/fd/${handle.fd}`,
      testOnlyPathnameEmulation,
    });
  } catch (cause) {
    let failure: unknown = cause;
    if (handle) {
      try {
        await boundedInternalCleanup(() => (handle as FileHandle).close());
      } catch (cleanupCause) {
        failure = new AggregateError([cause, cleanupCause]);
      }
    }
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ROOT_INVALID",
      `${field} is unavailable`,
      { cause: failure },
    );
  }
}

async function resolveDescendantDirectoryAuthority(
  trusted: CandidateFsDirectoryAuthority,
  requested: string,
  field: string,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<CandidateFsDirectoryAuthority> {
  const canonical = requireAbsoluteCanonicalPath(requested, field);
  if (!isStrictlyWithin(trusted.path, canonical)) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PATH_FORBIDDEN",
      "Candidate attempt must be a strict descendant of its trusted root",
    );
  }
  const relative = path.relative(trusted.path, canonical);
  const segments = requireRelativePath(relative, field).split(path.sep);
  let currentAuthority = trusted;
  let ownedHandle: FileHandle | undefined;
  try {
    for (const segment of segments) {
      const childPath = path.join(currentAuthority.anchor, segment);
      const childHandle = await controlledAcquire(
        () =>
          fs.open(
            childPath,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          ),
        (lateHandle) => lateHandle.close(),
        control,
      );
      try {
        const childStats = await controlled(
          () => fileStatExact(childHandle),
          control,
        );
        requirePrivateDirectory(
          childStats,
          `${field} contains a non-private directory`,
        );
        const previousHandle = ownedHandle;
        const previousAnchor = currentAuthority.anchor;
        if (previousHandle) await previousHandle.close();
        ownedHandle = childHandle;
        currentAuthority = Object.freeze({
          path: canonical,
          stats: childStats,
          handle: childHandle,
          anchor: trusted.testOnlyPathnameEmulation
            ? path.join(previousAnchor, segment)
            : `/proc/self/fd/${childHandle.fd}`,
          testOnlyPathnameEmulation: trusted.testOnlyPathnameEmulation,
        });
      } catch (cause) {
        await boundedInternalCleanup(() => childHandle.close());
        if (ownedHandle === childHandle) ownedHandle = undefined;
        throw cause;
      }
    }
    if (!ownedHandle) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ROOT_INVALID",
        `${field} did not resolve to a descendant directory`,
      );
    }
    const [visible, realPath] = await controlled(
      () => Promise.all([lstatExact(canonical), fs.realpath(canonical)]),
      control,
    );
    if (
      realPath !== canonical ||
      !sameIdentity(visible, currentAuthority.stats)
    ) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ROOT_INVALID",
        `${field} changed while its no-follow descriptor chain was opened`,
      );
    }
    ownedHandle = undefined;
    return currentAuthority;
  } catch (cause) {
    const handleToClose = ownedHandle;
    if (handleToClose) {
      await boundedInternalCleanup(() => handleToClose.close());
    }
    throw cause;
  }
}

async function assertDirectoryAuthority(
  authority: CandidateFsDirectoryAuthority,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<void> {
  const current = await controlled(
    () => fileStatExact(authority.handle),
    control,
  );
  requirePrivateDirectory(
    current,
    "Candidate filesystem directory authority is no longer private",
  );
  if (!sameIdentity(current, authority.stats)) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ROOT_CHANGED",
      "Candidate filesystem directory identity changed",
    );
  }
  if (authority.testOnlyPathnameEmulation) {
    const [realPath, visible] = await controlled(
      () =>
        Promise.all([fs.realpath(authority.path), lstatExact(authority.path)]),
      control,
    );
    if (
      realPath !== authority.path ||
      !sameIdentity(visible, authority.stats)
    ) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ROOT_CHANGED",
        "Candidate filesystem emulated directory pathname changed",
      );
    }
  }
}

export async function syncDirectory(
  authority: CandidateFsDirectoryAuthority,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<void> {
  await assertDirectoryAuthority(authority, control);
  await controlled(() => authority.handle.sync(), control);
}

export async function assertBoundFile(
  handle: FileHandle,
  filePath: string,
  expected: CandidateFsExactStats,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<CandidateFsExactStats> {
  const [opened, visible] = await controlled(
    () => Promise.all([fileStatExact(handle), lstatExact(filePath)]),
    control,
  );
  requirePrivateSingleLinkFile(
    opened,
    "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_UNSAFE",
    "Candidate file descriptor is not one private regular file",
  );
  requirePrivateSingleLinkFile(
    visible,
    "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_UNSAFE",
    "Candidate file pathname is not one private regular file",
  );
  if (!sameIdentity(opened, expected) || !sameIdentity(visible, expected)) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_CHANGED",
      "Candidate file identity changed",
    );
  }
  return opened;
}

export async function writeAll(
  handle: FileHandle,
  bytes: Uint8Array,
  position: number,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await controlled(
      () =>
        handle.write(
          bytes,
          offset,
          bytes.byteLength - offset,
          position + offset,
        ),
      control,
    );
    if (written.bytesWritten <= 0) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_NO_PROGRESS",
        "Candidate filesystem write made no progress",
      );
    }
    offset += written.bytesWritten;
  }
}

interface KernelLockLease {
  readonly release: () => Promise<void>;
}

async function waitForLockProcessReady(child: ChildProcess): Promise<void> {
  const readyStream = child.stdout;
  if (!readyStream) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_SETUP_FAILED",
      "Candidate filesystem lock helper did not expose its readiness pipe",
    );
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (failure?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      readyStream.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (failure === undefined) resolve();
      else reject(failure);
    };
    const onData = (bytes: Buffer) => {
      if (bytes.includes(0x31)) finish();
    };
    const onError = (cause: unknown) => finish(cause);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const errorCode =
        code === 73
          ? "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_BUSY"
          : "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_SETUP_FAILED";
      finish(
        new AgentBackupRestoreV3CandidateFsError(
          errorCode,
          code === 73
            ? "Candidate filesystem root inode is already exclusively locked"
            : "Candidate filesystem lock helper exited before acquiring its kernel lock",
          { context: { exitCode: code, signal } },
        ),
      );
    };
    const timer = setTimeout(() => {
      finish(
        new AgentBackupRestoreV3CandidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_SETUP_FAILED",
          "Candidate filesystem lock helper did not become ready within its bound",
          { severity: "ephemeral" },
        ),
      );
    }, LOCK_START_DEADLINE_MS);
    timer.unref?.();
    readyStream.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
    }
  });
}

async function stopLockProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let deadlineFailure: AgentBackupRestoreV3CandidateFsError | undefined;
    const finish = (failure?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (failure === undefined) resolve();
      else reject(failure);
    };
    const onError = (cause: unknown) => finish(cause);
    const onExit = () => finish(deadlineFailure);
    const timer = setTimeout(() => {
      deadlineFailure = new AgentBackupRestoreV3CandidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_RELEASE_FAILED",
        "Candidate filesystem lock helper required SIGKILL after its cleanup bound",
        { severity: "ephemeral" },
      );
      child.kill("SIGKILL");
    }, INTERNAL_CLEANUP_DEADLINE_MS);
    timer.unref?.();
    child.once("error", onError);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit();
      return;
    }
    child.kill("SIGTERM");
  });
}

interface CandidateFsLockOwner {
  detachLock(lock: AgentBackupRestoreV3CandidateFsLock): void;
}

const LOCK_USE_AUTHORITY = Symbol("candidate-fs-lock-use-authority");

export class AgentBackupRestoreV3CandidateFsLock {
  readonly name: string;
  #owner: CandidateFsLockOwner;
  #lease: KernelLockLease;
  #state: "active" | "releasing" | "released" = "active";
  #releasePromise: Promise<void> | null = null;
  #activeUses = 0;
  #drainWaiters: Array<() => void> = [];

  constructor(input: {
    owner: CandidateFsLockOwner;
    name: string;
    lease: KernelLockLease;
  }) {
    this.#owner = input.owner;
    this.name = input.name;
    this.#lease = input.lease;
  }

  isActive(): boolean {
    return this.#state === "active";
  }

  acquireUse(authority: symbol): () => void {
    if (authority !== LOCK_USE_AUTHORITY || this.#state !== "active") {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_INVALID",
        "Candidate filesystem inode-lock lease is not available for use",
      );
    }
    this.#activeUses += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeUses -= 1;
      if (this.#activeUses === 0) {
        const waiters = this.#drainWaiters;
        this.#drainWaiters = [];
        for (const resolve of waiters) resolve();
      }
    };
  }

  #waitForUses(): Promise<void> {
    if (this.#activeUses === 0) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.push(resolve));
  }

  release(
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<void> {
    void control;
    if (this.#releasePromise) return this.#releasePromise;
    this.#state = "releasing";
    this.#releasePromise = (async () => {
      try {
        await this.#waitForUses();
        await boundedInternalCleanup(() => this.#lease.release());
      } finally {
        this.#owner.detachLock(this);
        this.#state = "released";
      }
    })();
    return this.#releasePromise;
  }
}

export class AgentBackupRestoreV3CandidateFsControl {
  readonly trustedRoot: string;
  readonly attemptRoot: string;
  readonly trustedRootIdentity: AgentBackupRestoreV3CandidateFsIdentity;
  readonly attemptRootIdentity: AgentBackupRestoreV3CandidateFsIdentity;
  readonly #trustedAuthority: CandidateFsDirectoryAuthority;
  readonly #attemptAuthority: CandidateFsDirectoryAuthority;
  #activeLock: AgentBackupRestoreV3CandidateFsLock | null = null;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #pendingLockAcquisitions = 0;
  #lockAcquisitionDrainWaiters: Array<() => void> = [];

  private constructor(input: {
    trustedAuthority: CandidateFsDirectoryAuthority;
    attemptAuthority: CandidateFsDirectoryAuthority;
  }) {
    this.#trustedAuthority = input.trustedAuthority;
    this.#attemptAuthority = input.attemptAuthority;
    this.trustedRoot = input.trustedAuthority.path;
    this.attemptRoot = input.attemptAuthority.path;
    this.trustedRootIdentity = candidateFsIdentity(
      input.trustedAuthority.stats,
    );
    this.attemptRootIdentity = candidateFsIdentity(
      input.attemptAuthority.stats,
    );
  }

  get attemptAuthority(): CandidateFsDirectoryAuthority {
    return this.#attemptAuthority;
  }

  static async open(
    input: Readonly<OpenAgentBackupRestoreV3CandidateFsInput>,
  ): Promise<AgentBackupRestoreV3CandidateFsControl> {
    const openInput = snapshotOwnDataRecord(
      input,
      [
        "trustedRoot",
        "attemptRoot",
        "control",
        "testOnlyAllowNonLinuxFdEmulation",
      ],
      ["trustedRoot", "attemptRoot", "control"],
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ROOT_INVALID",
      "Candidate filesystem requires one explicit data-property open contract",
    );
    const trustedRoot = openInput.trustedRoot as string;
    const attemptRoot = openInput.attemptRoot as string;
    const control = snapshotOperationControl(
      openInput.control as Readonly<AgentBackupRestoreV3OperationControl>,
    );
    const allowTestEmulation = openInput.testOnlyAllowNonLinuxFdEmulation;
    if (allowTestEmulation !== undefined && allowTestEmulation !== true) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ROOT_INVALID",
        "Candidate filesystem test emulation flag is invalid",
      );
    }
    const testOnlyPathnameEmulation =
      process.platform !== "linux" &&
      allowTestEmulation === true &&
      process.env.NODE_ENV === "test";
    if (process.platform !== "linux" && !testOnlyPathnameEmulation) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PLATFORM_UNSUPPORTED",
        "Candidate filesystem requires Linux /proc descriptor anchors and kernel flock",
      );
    }
    const trustedAuthority = await resolveDirectoryAuthority(
      trustedRoot,
      "trustedRoot",
      control,
      testOnlyPathnameEmulation,
    );
    let attemptAuthority: CandidateFsDirectoryAuthority;
    try {
      attemptAuthority = await resolveDescendantDirectoryAuthority(
        trustedAuthority,
        attemptRoot,
        "attemptRoot",
        control,
      );
    } catch (cause) {
      await boundedInternalCleanup(() => trustedAuthority.handle.close());
      if (cause instanceof AgentBackupRestoreV3CandidateFsError) throw cause;
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ROOT_INVALID",
        "attemptRoot could not be opened through its no-follow descriptor chain",
        { cause },
      );
    }
    const candidate = new AgentBackupRestoreV3CandidateFsControl({
      trustedAuthority,
      attemptAuthority,
    });
    try {
      await candidate.assertAuthority(control);
      return candidate;
    } catch (cause) {
      try {
        await candidate.close();
      } catch (cleanupCause) {
        throw new AgentBackupRestoreV3CandidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ROOT_INVALID",
          "Candidate filesystem authority validation and descriptor cleanup both failed",
          { cause: new AggregateError([cause, cleanupCause]) },
        );
      }
      throw cause;
    }
  }

  async assertAuthority(
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<void> {
    if (this.#closed) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLOSED",
        "Candidate filesystem authority is closed",
      );
    }
    await assertDirectoryAuthority(this.#trustedAuthority, control);
    await assertDirectoryAuthority(this.#attemptAuthority, control);
    if (!isStrictlyWithin(this.trustedRoot, this.attemptRoot)) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PATH_FORBIDDEN",
        "Candidate attempt escaped its trusted root",
      );
    }
  }

  async syncAttemptRoot(
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<void> {
    await syncDirectory(this.#attemptAuthority, control);
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      if (this.#pendingLockAcquisitions > 0) {
        await new Promise<void>((resolve) =>
          this.#lockAcquisitionDrainWaiters.push(resolve),
        );
      }
      const activeLock = this.#activeLock;
      await runAllBoundedInternalCleanup([
        ...(activeLock
          ? [() => activeLock.release(internalCleanupControl())]
          : []),
        () => this.#attemptAuthority.handle.close(),
        () => this.#trustedAuthority.handle.close(),
      ]);
    })();
    return this.#closePromise;
  }

  detachLock(lock: AgentBackupRestoreV3CandidateFsLock): void {
    if (this.#activeLock === lock) this.#activeLock = null;
  }

  async assertLockHeld(
    lock: AgentBackupRestoreV3CandidateFsLock,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<void> {
    await this.assertAuthority(control);
    if (this.#activeLock !== lock || !lock.isActive()) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_INVALID",
        "Candidate filesystem inode-lock lease is no longer active",
      );
    }
  }

  beginLockUse(lock: AgentBackupRestoreV3CandidateFsLock): () => void {
    if (this.#closed || this.#activeLock !== lock || !lock.isActive()) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_INVALID",
        "Candidate filesystem inode-lock lease cannot begin another operation",
      );
    }
    return lock.acquireUse(LOCK_USE_AUTHORITY);
  }

  directPath(name: string, field: string): string {
    return path.join(
      this.#attemptAuthority.anchor,
      requireControlName(name, field),
    );
  }

  directoryAnchor(handle: FileHandle, testPath: string): string {
    return this.#attemptAuthority.testOnlyPathnameEmulation
      ? testPath
      : `/proc/self/fd/${handle.fd}`;
  }

  async openDirectorySegments(
    segments: readonly string[],
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<Readonly<CandidateFsOpenedDirectory>> {
    let testPath = this.attemptRoot;
    let handle = await controlledAcquire(
      () =>
        fs.open(
          this.#attemptAuthority.anchor,
          constants.O_RDONLY | constants.O_DIRECTORY,
        ),
      (lateHandle) => lateHandle.close(),
      control,
    );
    try {
      for (const rawSegment of segments) {
        const segment = requirePathSegment(rawSegment, "directory segment");
        const anchor = this.directoryAnchor(handle, testPath);
        const childPath = path.join(anchor, segment);
        const childHandle = await controlledAcquire(
          () =>
            fs.open(
              childPath,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            ),
          (lateHandle) => lateHandle.close(),
          control,
        );
        try {
          const [visible, opened] = await controlled(
            () =>
              Promise.all([lstatExact(childPath), fileStatExact(childHandle)]),
            control,
          );
          requirePrivateDirectory(
            opened,
            "Candidate directory descent found a non-private directory",
          );
          if (!sameIdentity(visible, opened)) {
            candidateFsError(
              "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_CHANGED",
              "Candidate directory changed during no-follow descent",
            );
          }
        } catch (cause) {
          await boundedInternalCleanup(() => childHandle.close());
          throw cause;
        }
        await handle.close();
        handle = childHandle;
        testPath = path.join(testPath, segment);
      }
      const stats = await controlled(() => fileStatExact(handle), control);
      requirePrivateDirectory(
        stats,
        "Candidate directory descriptor is no longer private",
      );
      return Object.freeze({
        handle,
        stats,
        anchor: this.directoryAnchor(handle, testPath),
        testPath,
      });
    } catch (cause) {
      await boundedInternalCleanup(() => handle.close());
      throw cause;
    }
  }

  acquireLock(
    name: string,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<AgentBackupRestoreV3CandidateFsLock> {
    if (this.#closed) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLOSED",
        "Candidate filesystem authority is closed",
      );
    }
    this.#pendingLockAcquisitions += 1;
    return this.#acquireLockOnce(name, control).finally(() => {
      this.#pendingLockAcquisitions -= 1;
      if (this.#pendingLockAcquisitions === 0) {
        const waiters = this.#lockAcquisitionDrainWaiters;
        this.#lockAcquisitionDrainWaiters = [];
        for (const resolve of waiters) resolve();
      }
    });
  }

  async #acquireLockOnce(
    name: string,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<AgentBackupRestoreV3CandidateFsLock> {
    requireControlName(name, "lock name");
    await this.assertAuthority(control);
    if (this.#activeLock) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_BUSY",
        "Candidate filesystem root inode is already exclusively locked by this authority",
      );
    }
    let lease: KernelLockLease;
    if (this.#attemptAuthority.testOnlyPathnameEmulation) {
      const key = `${this.attemptRootIdentity.device}:${this.attemptRootIdentity.inode}`;
      if (TEST_PLATFORM_LOCKS.has(key)) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_BUSY",
          "Candidate filesystem emulated root inode is already locked",
        );
      }
      TEST_PLATFORM_LOCKS.add(key);
      lease = Object.freeze({
        release: async () => {
          TEST_PLATFORM_LOCKS.delete(key);
        },
      });
    } else {
      const lockHandle = await controlledAcquire(
        () =>
          fs.open(
            this.#attemptAuthority.anchor,
            constants.O_RDONLY | constants.O_DIRECTORY,
          ),
        (lateHandle) => lateHandle.close(),
        control,
      );
      const child = spawn(
        "/bin/sh",
        [
          "-c",
          "command -v flock >/dev/null 2>&1 || exit 74; flock --exclusive --nonblock 3 || exit 73; printf 1; exec sleep 2147483647",
        ],
        {
          stdio: ["ignore", "pipe", "ignore", lockHandle.fd],
        },
      );
      try {
        await waitForLockProcessReady(child);
        assertActive(control);
      } catch (cause) {
        try {
          await boundedInternalCleanup(async () => {
            await stopLockProcess(child);
            await lockHandle.close();
          });
        } catch (cleanupCause) {
          throw new AgentBackupRestoreV3CandidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_SETUP_FAILED",
            "Candidate filesystem lock setup and late cleanup both failed",
            { cause: new AggregateError([cause, cleanupCause]) },
          );
        }
        throw cause;
      }
      lease = Object.freeze({
        release: async () => {
          let processFailure: unknown;
          try {
            await stopLockProcess(child);
          } catch (cause) {
            processFailure = cause;
          }
          try {
            await lockHandle.close();
          } catch (cause) {
            if (processFailure !== undefined) {
              throw new AggregateError([processFailure, cause]);
            }
            throw cause;
          }
          if (processFailure !== undefined) throw processFailure;
        },
      });
    }
    if (this.#closed) {
      try {
        await boundedInternalCleanup(() => lease.release());
      } catch (cleanupCause) {
        throw new AgentBackupRestoreV3CandidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLOSED",
          "Candidate filesystem closed during lock acquisition and lease cleanup failed",
          { cause: cleanupCause },
        );
      }
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLOSED",
        "Candidate filesystem closed during lock acquisition",
      );
    }
    const lock = new AgentBackupRestoreV3CandidateFsLock({
      owner: this,
      name,
      lease,
    });
    this.#activeLock = lock;
    return lock;
  }

  async operationLock(
    name: string,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
    heldLock?: AgentBackupRestoreV3CandidateFsLock,
  ): Promise<AgentBackupRestoreV3CandidateFsLock | null> {
    if (this.#activeLock) {
      if (heldLock === this.#activeLock && heldLock.isActive()) return null;
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_BUSY",
        "Candidate filesystem operation must present the exact active inode-lock lease",
      );
    }
    if (heldLock) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_INVALID",
        "Candidate filesystem operation received a stale inode-lock lease",
      );
    }
    return this.acquireLock(name, control);
  }
}
