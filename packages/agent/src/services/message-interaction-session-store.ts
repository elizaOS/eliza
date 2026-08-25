/**
 * Persists message-interaction sessions for one host with cross-process atomic
 * transitions. Multi-host deployments should implement the same store contract
 * with a transactional database row or outbox rather than sharing this file.
 * An abandoned lifecycle marker fails closed until an operator stops every
 * store user, verifies no owner remains, and removes the marker.
 */

import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  applyMessageInteractionClaim,
  applyMessageInteractionCommit,
  applyMessageInteractionCompletion,
  applyMessageInteractionReconciliation,
  applyMessageInteractionRevocation,
  ElizaError,
  type MessageInteractionClaimContext,
  type MessageInteractionClaimResult,
  type MessageInteractionCommitContext,
  type MessageInteractionCompleteContext,
  type MessageInteractionReconcileContext,
  type MessageInteractionSession,
  type MessageInteractionSessionStore,
} from "@elizaos/core";

interface SessionFile {
  version: 1;
  sessions: Record<string, MessageInteractionSession>;
}

interface LockOwner {
  pid: number;
  processIdentity: string | null;
  lockIdentity: string;
  token: string;
  createdAt: number;
  expiresAt: number;
}

interface LockRaceHooks {
  beforeLockPublish?: () => Promise<void>;
  afterTransitionCheckBeforeLockPublish?: () => Promise<void>;
  afterLockPublishBeforeCandidateCleanup?: () => Promise<void>;
  beforeOwnerCandidateCleanup?: () => Promise<void>;
  beforeStateDirectorySync?: () => Promise<void>;
  afterStateDirectoryClose?: () => Promise<void>;
  beforePublicationCandidateValidation?: () => Promise<void>;
  beforeStaleRetire?: () => Promise<void>;
  beforeReleaseRetire?: () => Promise<void>;
  beforeTransitionValidation?: () => Promise<void>;
  beforeTransitionAbortCleanup?: () => Promise<void>;
  beforeLockUnlink?: () => Promise<void>;
  beforeTransitionMarkerCleanup?: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validIsoDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validBoundedJson(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > 32 || ++nodes > 100_000) return false;
    if (typeof current.value === "string") {
      if (new TextEncoder().encode(current.value).length > 65_536) return false;
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > 10_000) return false;
      for (const child of current.value)
        stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (isRecord(current.value)) {
      const entries = Object.entries(current.value);
      if (entries.length > 10_000) return false;
      for (const [key, child] of entries) {
        if (
          key === "__proto__" ||
          key === "prototype" ||
          key === "constructor" ||
          new TextEncoder().encode(key).length > 512
        )
          return false;
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return true;
}

function structurallyValidConsume(value: Record<string, unknown>): boolean {
  if (value.state === "pending") return true;
  if (
    value.state !== "claimed" &&
    value.state !== "committed" &&
    value.state !== "completed"
  )
    return false;
  if (
    typeof value.claimId !== "string" ||
    typeof value.replayKey !== "string" ||
    typeof value.responseDigest !== "string" ||
    !isRecord(value.response) ||
    !validIsoDate(value.claimedAt) ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1
  )
    return false;
  if (value.state === "claimed")
    return (
      validIsoDate(value.claimExpiresAt) &&
      Date.parse(String(value.claimExpiresAt)) >
        Date.parse(String(value.claimedAt))
    );
  if (value.state === "committed")
    return (
      validIsoDate(value.committedAt) &&
      Date.parse(String(value.committedAt)) >=
        Date.parse(String(value.claimedAt))
    );
  const receipt = value.receipt;
  return (
    validIsoDate(value.committedAt) &&
    validIsoDate(value.completedAt) &&
    Date.parse(String(value.committedAt)) >=
      Date.parse(String(value.claimedAt)) &&
    Date.parse(String(value.completedAt)) >=
      Date.parse(String(value.committedAt)) &&
    isRecord(receipt) &&
    typeof receipt.receiptId === "string" &&
    receipt.idempotencyKey === value.replayKey &&
    receipt.status === "completed" &&
    validIsoDate(receipt.completedAt) &&
    isRecord(receipt.result)
  );
}

function structurallyValidSession(value: unknown, reference: string): boolean {
  if (!isRecord(value)) return false;
  const bindings = value.bindings;
  const authorization = value.authorization;
  const consume = value.consume;
  return (
    value.sessionVersion === 1 &&
    value.reference === reference &&
    [
      "choice",
      "form",
      "approval",
      "setup",
      "auth",
      "task",
      "file",
      "followup",
    ].includes(String(value.purpose)) &&
    ["choice", "form", "followups", "task", "secret"].includes(
      String(value.blockKind),
    ) &&
    ["native", "conversational", "signed-hosted", "sensitive-request"].includes(
      String(value.flow),
    ) &&
    typeof value.profileId === "string" &&
    isRecord(bindings) &&
    typeof bindings.actorId === "string" &&
    isRecord(bindings.audience) &&
    typeof bindings.audience.kind === "string" &&
    typeof bindings.audience.id === "string" &&
    typeof bindings.agentId === "string" &&
    isRecord(bindings.connector) &&
    typeof bindings.connector.source === "string" &&
    typeof bindings.connector.accountId === "string" &&
    typeof bindings.roomId === "string" &&
    typeof bindings.sourceMessageId === "string" &&
    isRecord(value.responseSchema) &&
    Array.isArray(value.responseSchema.fields) &&
    value.responseSchema.additionalFields === false &&
    isRecord(authorization) &&
    typeof authorization.decisionId === "string" &&
    typeof authorization.policyRevision === "string" &&
    validIsoDate(authorization.decidedAt) &&
    ["active", "revoked"].includes(String(authorization.state)) &&
    ((authorization.state === "active" && authorization.revokedAt === null) ||
      (authorization.state === "revoked" &&
        validIsoDate(authorization.revokedAt))) &&
    isRecord(value.effect) &&
    typeof value.effect.kind === "string" &&
    validIsoDate(value.createdAt) &&
    validIsoDate(value.expiresAt) &&
    isRecord(consume) &&
    structurallyValidConsume(consume) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0
  );
}

export interface FileMessageInteractionSessionStoreOptions {
  stateDirectory: string;
  fileName?: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  /** Absolute recovery ceiling for an owner record that was never published. */
  hardStaleLockMs?: number;
  pollMs?: number;
  retentionMs?: number;
  committedRetentionMs?: number;
  maxStoreBytes?: number;
  maxSessions?: number;
  clock?: () => number;
  /** @internal Deterministic coordination for filesystem race tests. */
  lockRaceHooks?: LockRaceHooks;
}

function storeError(
  code: string,
  message: string,
  context?: Record<string, unknown>,
): never {
  throw new ElizaError(message, { code, context });
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function existsLstat(filePath: string) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      // error-policy:J4 absence is the designed initial state for this store.
      return null;
    }
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeInteger(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    return storeError(
      "INVALID_INTERACTION_STORE_CONFIG",
      `${name} is invalid.`,
      {
        name,
        value,
      },
    );
  }
  return value;
}

function newToken(): string {
  return crypto.randomUUID();
}

/**
 * A single-machine durable store. Atomic rename and directory fsync preserve a
 * complete prior or next revision across process/power loss; the lock owner
 * inode and transition marker serialize independent host processes.
 */
export class FileMessageInteractionSessionStore
  implements MessageInteractionSessionStore
{
  private readonly directory: string;
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly hardStaleLockMs: number;
  private readonly pollMs: number;
  private readonly retentionMs: number;
  private readonly committedRetentionMs: number;
  private readonly maxStoreBytes: number;
  private readonly maxSessions: number;
  private readonly clock: () => number;
  private readonly lockRaceHooks: LockRaceHooks;
  private directoryIdentity: {
    realPath: string;
    device: number;
    inode: number;
  } | null = null;
  private initialized = false;

  constructor(options: FileMessageInteractionSessionStoreOptions) {
    this.directory = path.resolve(options.stateDirectory);
    const fileName = options.fileName ?? "message-interaction-sessions.v1.json";
    if (
      path.basename(fileName) !== fileName ||
      fileName === "." ||
      fileName === ".."
    ) {
      storeError(
        "INVALID_INTERACTION_STORE_PATH",
        "Interaction store filename must be a plain basename.",
      );
    }
    this.filePath = path.join(this.directory, fileName);
    this.lockPath = `${this.filePath}.lock`;
    this.lockTimeoutMs = safeInteger(
      options.lockTimeoutMs ?? 5_000,
      "lockTimeoutMs",
      1,
    );
    this.staleLockMs = safeInteger(
      options.staleLockMs ?? 30_000,
      "staleLockMs",
      1,
    );
    this.hardStaleLockMs = safeInteger(
      options.hardStaleLockMs ?? Math.max(this.staleLockMs * 10, 300_000),
      "hardStaleLockMs",
      this.staleLockMs,
    );
    this.pollMs = safeInteger(options.pollMs ?? 10, "pollMs", 1);
    this.retentionMs = safeInteger(
      options.retentionMs ?? 7 * 24 * 60 * 60 * 1_000,
      "retentionMs",
      0,
    );
    this.committedRetentionMs = safeInteger(
      options.committedRetentionMs ?? 30 * 24 * 60 * 60 * 1_000,
      "committedRetentionMs",
      0,
    );
    this.maxStoreBytes = safeInteger(
      options.maxStoreBytes ?? 4 * 1024 * 1024,
      "maxStoreBytes",
      1,
    );
    this.maxSessions = safeInteger(
      options.maxSessions ?? 10_000,
      "maxSessions",
      1,
    );
    this.clock = options.clock ?? Date.now;
    this.lockRaceHooks = options.lockRaceHooks ?? {};
  }

  private async initialize(): Promise<void> {
    if (this.initialized) {
      await this.assertDirectoryIdentity();
      return;
    }
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directoryStat = await fs.lstat(this.directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      storeError(
        "UNSAFE_INTERACTION_STORE_PATH",
        "Interaction store directory must be a real directory.",
      );
    }
    if ((directoryStat.mode & 0o077) !== 0) {
      storeError(
        "UNSAFE_INTERACTION_STORE_PATH",
        "Interaction store directory permissions expose private state.",
      );
    }
    const realDirectory = await fs.realpath(this.directory);
    if (realDirectory !== this.directory) {
      storeError(
        "UNSAFE_INTERACTION_STORE_PATH",
        "Interaction store directory cannot traverse a symlink.",
      );
    }
    this.directoryIdentity = {
      realPath: realDirectory,
      device: directoryStat.dev,
      inode: directoryStat.ino,
    };
    const existing = await existsLstat(this.filePath);
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      storeError(
        "UNSAFE_INTERACTION_STORE_PATH",
        "Interaction store file must be a regular file.",
      );
    }
    if (existing && (existing.nlink !== 1 || (existing.mode & 0o077) !== 0)) {
      storeError(
        "UNSAFE_INTERACTION_STORE_PATH",
        "Interaction store file must be private and have one filesystem link.",
      );
    }
    this.initialized = true;
  }

  private async assertDirectoryIdentity(): Promise<void> {
    const expected = this.directoryIdentity;
    if (!expected)
      storeError(
        "INTERACTION_STORE_NOT_INITIALIZED",
        "Interaction store directory identity is unavailable.",
      );
    const stat = await fs.lstat(this.directory);
    const realPath = await fs.realpath(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realPath !== expected.realPath ||
      stat.dev !== expected.device ||
      stat.ino !== expected.inode
    ) {
      storeError(
        "UNSAFE_INTERACTION_STORE_PATH",
        "Interaction store directory identity changed after initialization.",
      );
    }
  }

  private processAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (isErrno(error, "ESRCH")) return false;
      if (isErrno(error, "EPERM")) return true;
      throw error;
    }
  }

  private async readProcessIdentity(pid: number): Promise<string | null> {
    if (process.platform !== "linux" || !this.processAlive(pid)) return null;
    try {
      const [bootId, stat] = await Promise.all([
        fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        fs.readFile(`/proc/${pid}/stat`, "utf8"),
      ]);
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return null;
      const fieldsAfterCommand = stat
        .slice(commandEnd + 2)
        .trim()
        .split(/\s+/);
      const startTimeTicks = fieldsAfterCommand[19];
      if (!startTimeTicks || !bootId.trim()) return null;
      return `${bootId.trim()}:${startTimeTicks}`;
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ESRCH")) return null;
      // error-policy:J4 Process identity is an optional strengthening signal;
      // PID liveness plus the absolute recovery ceiling remains authoritative.
      if (isErrno(error, "EACCES") || isErrno(error, "EPERM")) return null;
      throw error;
    }
  }

  private lockIdentity(entry: { dev: number; ino: number }): string {
    return `${entry.dev}-${entry.ino}`;
  }

  private transitionRecoveryContext(marker: string): Record<string, unknown> {
    return {
      markerPath: marker,
      recovery:
        "Stop all store users, verify no process owns the lock, remove markerPath, fsync its parent directory, then restart.",
    };
  }

  private transitionCleanupError(
    marker: string,
    phase: "recovery" | "release",
    cleanupError: unknown,
    primaryError?: unknown,
  ): ElizaError {
    return new ElizaError("Interaction transition marker cleanup failed.", {
      code:
        phase === "recovery"
          ? "INTERACTION_STORE_RECOVERY_CLEANUP_FAILED"
          : "INTERACTION_STORE_RELEASE_CLEANUP_FAILED",
      cause: primaryError ?? cleanupError,
      context: {
        ...this.transitionRecoveryContext(marker),
        ...(phase === "recovery"
          ? { committed: false, retrySafeAfterRecovery: true }
          : {}),
        cleanupError:
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
      },
    });
  }

  private async beginLockTransition(
    lockIdentity: string,
    phase: "recovery" | "release",
  ): Promise<string | null> {
    const marker = `${this.lockPath}.transition`;
    const token = newToken();
    const candidate = `${marker}-${token}.tmp`;
    try {
      await this.writeAndSync(candidate, {
        pid: process.pid,
        processIdentity: await this.readProcessIdentity(process.pid),
        token,
      });
      await fs.link(candidate, marker);
    } catch (error) {
      if (
        isErrno(error, "ENOENT") ||
        isErrno(error, "EEXIST") ||
        isErrno(error, "ENOTEMPTY")
      ) {
        return null;
      }
      throw error;
    } finally {
      try {
        await fs.rm(candidate, { force: true });
      } catch {
        // error-policy:J6 a unique transition candidate never grants authority.
      }
    }
    const current = await existsLstat(this.lockPath);
    if (
      !current?.isFile() ||
      current.isSymbolicLink() ||
      this.lockIdentity(current) !== lockIdentity
    ) {
      try {
        await this.lockRaceHooks.beforeTransitionAbortCleanup?.();
        await fs.rm(marker, { force: true });
      } catch (cleanupError) {
        // error-policy:J2 A marker targeting a replaced lock must remain a
        // typed outage if its pathname cannot be cleared safely.
        throw this.transitionCleanupError(marker, phase, cleanupError);
      }
      return null;
    }
    return marker;
  }

  /** The transition hardlink excludes release and all competing recoverers. */
  private async retireObservedLock(
    lockIdentity: string,
    validate: () => Promise<boolean>,
    phase: "recovery" | "release",
    ownerToken?: string,
  ): Promise<boolean> {
    const marker = await this.beginLockTransition(lockIdentity, phase);
    if (!marker) return false;
    let valid: boolean;
    try {
      await this.lockRaceHooks.beforeTransitionValidation?.();
      valid = await validate();
    } catch (primaryError) {
      try {
        await this.lockRaceHooks.beforeTransitionAbortCleanup?.();
        await fs.rm(marker, { force: true });
      } catch (cleanupError) {
        // error-policy:J2 Preserve the validation failure while exposing the
        // fail-closed marker and its exact offline recovery procedure.
        throw this.transitionCleanupError(
          marker,
          phase,
          cleanupError,
          primaryError,
        );
      }
      throw primaryError;
    }
    if (!valid) {
      try {
        await this.lockRaceHooks.beforeTransitionAbortCleanup?.();
        await fs.rm(marker, { force: true });
      } catch (cleanupError) {
        // error-policy:J2 A failed validation grants no detach authority; an
        // uncleared marker is a typed outage rather than a raw teardown error.
        throw this.transitionCleanupError(marker, phase, cleanupError);
      }
      return false;
    }
    try {
      await this.lockRaceHooks.beforeLockUnlink?.();
      await fs.rm(this.lockPath);
    } catch (unlinkError) {
      try {
        await this.lockRaceHooks.beforeTransitionAbortCleanup?.();
        await fs.rm(marker, { force: true });
      } catch (cleanupError) {
        // error-policy:J2 Preserve both failures and the exact offline
        // authority needed to recover the still-published owner generation.
        throw new ElizaError(
          "Interaction lock unlink and transition cleanup both failed.",
          {
            code:
              phase === "recovery"
                ? "INTERACTION_STORE_RECOVERY_CLEANUP_FAILED"
                : "INTERACTION_STORE_RELEASE_CLEANUP_FAILED",
            cause: unlinkError,
            context: {
              ...this.transitionRecoveryContext(marker),
              lockPath: this.lockPath,
              lockIdentity,
              ...(ownerToken ? { ownerToken } : {}),
              cleanupError:
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError),
              recovery:
                "Stop all store users, verify lockPath still has lockIdentity and ownerToken when reported, remove markerPath and lockPath, fsync their parent directory, then restart.",
              ...(phase === "recovery"
                ? { committed: false, retrySafeAfterRecovery: true }
                : {}),
            },
          },
        );
      }
      if (isErrno(unlinkError, "ENOENT")) return false;
      throw unlinkError;
    }
    try {
      await this.lockRaceHooks.beforeTransitionMarkerCleanup?.();
      await fs.rm(marker);
    } catch (error) {
      // error-policy:J2 The lock is already detached, so acquisition or release
      // must surface the fail-closed marker instead of permitting a successor.
      throw this.transitionCleanupError(marker, phase, error);
    }
    return true;
  }

  private async readLockOwner(): Promise<LockOwner | null> {
    try {
      const ownerPath = this.lockPath;
      const entry = await fs.lstat(ownerPath);
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        entry.nlink < 1 ||
        entry.nlink > 2 ||
        (entry.mode & 0o077) !== 0 ||
        entry.size > 4_096
      ) {
        storeError(
          "UNSAFE_INTERACTION_STORE_LOCK",
          "Interaction store lock owner file is unsafe.",
          {
            isFile: entry.isFile(),
            isSymbolicLink: entry.isSymbolicLink(),
            linkCount: entry.nlink,
            mode: entry.mode & 0o777,
            size: entry.size,
          },
        );
      }
      const handle = await fs.open(
        ownerPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let raw: string;
      let openedNlink = 0;
      try {
        const opened = await handle.stat();
        openedNlink = opened.nlink;
        if (
          opened.dev !== entry.dev ||
          opened.ino !== entry.ino ||
          opened.nlink < 1 ||
          opened.nlink > 2 ||
          opened.size > 4_096
        ) {
          // The prior owner may release and a contender may create a new lock
          // between lstat and open. The changed file grants no authority; the
          // caller treats it like an incomplete owner and waits/retries.
          return null;
        }
        raw = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
      const value = JSON.parse(raw) as Partial<LockOwner>;
      if (
        !Number.isSafeInteger(value.pid) ||
        (value.processIdentity !== null &&
          typeof value.processIdentity !== "string") ||
        typeof value.lockIdentity !== "string" ||
        !/^\d+-\d+$/.test(value.lockIdentity) ||
        typeof value.token !== "string" ||
        !Number.isSafeInteger(value.createdAt) ||
        !Number.isSafeInteger(value.expiresAt)
      ) {
        return null;
      }
      if (entry.nlink === 2 || openedNlink === 2) {
        await this.lockRaceHooks.beforePublicationCandidateValidation?.();
        const expectedCandidate = `${path.basename(this.lockPath)}.owner-${String(value.pid)}-${value.token}.tmp`;
        const names = await fs.readdir(this.directory);
        if (!names.includes(expectedCandidate)) {
          const completed = await existsLstat(this.lockPath);
          if (
            !completed ||
            completed.dev !== entry.dev ||
            completed.ino !== entry.ino
          ) {
            // The publisher finished its candidate cleanup, transaction, and
            // release (and a successor may already have linked a new owner)
            // inside the read window. The inode this reader opened grants no
            // authority any more; the caller re-observes the current lock.
            return null;
          }
          if (completed.nlink === 1) {
            return {
              ...(value as LockOwner),
              processIdentity: value.processIdentity ?? null,
            };
          }
          storeError(
            "UNSAFE_INTERACTION_STORE_LOCK",
            "Interaction store lock has an unexpected hardlink.",
            {
              linkCount: completed.nlink,
              lockPath: this.lockPath,
            },
          );
        }
        let candidate: Awaited<ReturnType<typeof fs.lstat>>;
        try {
          candidate = await fs.lstat(
            path.join(this.directory, expectedCandidate),
          );
        } catch (error) {
          if (!isErrno(error, "ENOENT")) throw error;
          const completed = await existsLstat(this.lockPath);
          if (
            completed &&
            completed.dev === entry.dev &&
            completed.ino === entry.ino &&
            completed.nlink === 1
          ) {
            return {
              ...(value as LockOwner),
              processIdentity: value.processIdentity ?? null,
            };
          }
          return null;
        }
        if (candidate.dev !== entry.dev || candidate.ino !== entry.ino) {
          storeError(
            "UNSAFE_INTERACTION_STORE_LOCK",
            "Interaction store lock publication hardlink changed.",
          );
        }
        return {
          ...(value as LockOwner),
          processIdentity: value.processIdentity ?? null,
        };
      }
      return {
        ...(value as LockOwner),
        processIdentity: value.processIdentity ?? null,
      };
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        // error-policy:J4 a creator may exist before its owner file is durable.
        return null;
      }
      if (error instanceof SyntaxError) {
        // error-policy:J3 malformed owner data has no authority; lock age still
        // has to cross the stale threshold before recovery.
        return null;
      }
      throw error;
    }
  }

  private async lockIsStale(
    lockStat: { dev: number; ino: number; mtimeMs: number },
    now: number,
    unpublishedMtimeMs = lockStat.mtimeMs,
  ): Promise<boolean> {
    const observedIdentity = this.lockIdentity(lockStat);
    const owner = await this.readLockOwner();
    if (!owner) {
      // A creator publishes owner.json only after the lease is fully synced.
      // Without an owner identity there is no safe PID-liveness decision, so
      // incomplete or malformed locks use an absolute recovery ceiling instead
      // of the short lease interval.
      return unpublishedMtimeMs + this.hardStaleLockMs <= now;
    }
    if (owner.lockIdentity !== observedIdentity) {
      // The owner belongs to a different directory generation. It grants no
      // authority to remove the currently observed lock.
      return false;
    }
    if (owner.expiresAt > now) return false;
    const live = this.processAlive(owner.pid);
    const currentIdentity = live
      ? await this.readProcessIdentity(owner.pid)
      : null;
    const reusedPid = Boolean(
      live &&
        owner.processIdentity &&
        currentIdentity &&
        owner.processIdentity !== currentIdentity,
    );
    // If this platform cannot qualify a live PID generation, fail closed.
    // A wall-clock ceiling would eventually steal from a paused but valid
    // owner and reintroduce the same PID-aliasing race it is meant to solve.
    return !live || reusedPid;
  }

  private async recoverStaleLock(now: number): Promise<boolean> {
    const lockStat = await existsLstat(this.lockPath);
    if (!lockStat) return true;
    if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
      storeError(
        "UNSAFE_INTERACTION_STORE_LOCK",
        "Interaction store lock is not a regular file.",
      );
    }
    if (!(await this.lockIsStale(lockStat, now))) return false;
    const observedIdentity = this.lockIdentity(lockStat);
    await this.lockRaceHooks.beforeStaleRetire?.();
    return this.retireObservedLock(
      observedIdentity,
      async () => {
        const current = await existsLstat(this.lockPath);
        return Boolean(
          current &&
            this.lockIdentity(current) === observedIdentity &&
            (await this.lockIsStale(current, now, lockStat.mtimeMs)),
        );
      },
      "recovery",
    );
  }

  private async acquireLock(): Promise<LockOwner> {
    await this.initialize();
    const startedAt = performance.now();
    while (performance.now() - startedAt <= this.lockTimeoutMs) {
      const now = this.clock();
      const token = newToken();
      const candidate = `${this.lockPath}.owner-${process.pid}-${token}.tmp`;
      let owner: LockOwner | null = null;
      let published = false;
      let transitionObserved = false;
      let publicationError: unknown;
      let candidateCleanupError: unknown;
      try {
        const handle = await fs.open(
          candidate,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          const created = await handle.stat();
          owner = {
            pid: process.pid,
            processIdentity: await this.readProcessIdentity(process.pid),
            lockIdentity: this.lockIdentity(created),
            token,
            createdAt: now,
            expiresAt: now + this.staleLockMs,
          };
          await handle.writeFile(JSON.stringify(owner, null, 2), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        // link(2) publishes the already complete owner inode with no-replace
        // semantics. A delayed creator never writes through the shared path.
        await this.lockRaceHooks.beforeLockPublish?.();
        if (await existsLstat(`${this.lockPath}.transition`)) {
          // A transition is in flight; this candidate is discarded and a
          // fresh one is written on the next attempt. Candidate cleanup still
          // runs below so a cleanup failure cannot be swallowed by the retry.
          transitionObserved = true;
        } else {
          await this.lockRaceHooks.afterTransitionCheckBeforeLockPublish?.();
          await fs.link(candidate, this.lockPath);
          published = true;
          await this.lockRaceHooks.afterLockPublishBeforeCandidateCleanup?.();
        }
      } catch (error) {
        // error-policy:J2 EEXIST is the designed contention signal and runs
        // stale recovery; any other publication failure is rethrown after
        // candidate cleanup so a cleanup failure is reported beside it.
        if (!isErrno(error, "EEXIST")) {
          publicationError = error;
        } else {
          await this.recoverStaleLock(now);
          await delay(this.pollMs);
        }
      } finally {
        try {
          await this.lockRaceHooks.beforeOwnerCandidateCleanup?.();
          await fs.rm(candidate, { force: true });
        } catch (error) {
          candidateCleanupError = error;
        }
      }
      if (published && owner) {
        while (
          (await existsLstat(`${this.lockPath}.transition`)) &&
          performance.now() - startedAt <= this.lockTimeoutMs
        ) {
          await delay(this.pollMs);
        }
        if (await existsLstat(`${this.lockPath}.transition`)) {
          const marker = `${this.lockPath}.transition`;
          storeError(
            "INTERACTION_STORE_RECOVERY_REQUIRED",
            "Interaction store recovery requires all users to stop before the abandoned transition marker is removed.",
            {
              ...this.transitionRecoveryContext(marker),
              lockPath: this.lockPath,
              lockIdentity: owner.lockIdentity,
              ownerToken: owner.token,
              committed: false,
              recovery:
                "Stop all store users, verify lockPath still has lockIdentity and ownerToken, remove markerPath and lockPath, fsync their parent directory, then restart.",
              retrySafeAfterRecovery: true,
            },
          );
        }
        const canonical = await existsLstat(this.lockPath);
        const current = await this.readLockOwner();
        if (
          !canonical ||
          this.lockIdentity(canonical) !== owner.lockIdentity ||
          current?.token !== owner.token
        ) {
          storeError(
            "INTERACTION_STORE_LOCK_LOST",
            "Interaction store lock ownership changed during publication.",
          );
        }
        if (candidateCleanupError) {
          let releaseError: unknown;
          try {
            await this.releaseLock(owner);
          } catch (error) {
            releaseError = error;
          }
          throw new ElizaError(
            "Interaction lock owner candidate cleanup failed before mutation.",
            {
              code: "INTERACTION_STORE_OWNER_CANDIDATE_CLEANUP_FAILED",
              cause: candidateCleanupError,
              context: {
                candidatePath: candidate,
                committed: false,
                lockPath: this.lockPath,
                markerPath: `${this.lockPath}.transition`,
                published: true,
                recoveryRequired: Boolean(releaseError),
                retrySafeAfterRecovery: true,
                retrySafeNow: !releaseError,
                ...(releaseError instanceof ElizaError
                  ? {
                      releaseErrorCode: releaseError.code,
                      releaseErrorContext: releaseError.context,
                    }
                  : releaseError
                    ? { releaseError: String(releaseError) }
                    : {}),
              },
            },
          );
        }
        return owner;
      }
      if (candidateCleanupError) {
        // The candidate never became the canonical owner, so nothing was
        // mutated and no release is owed; the leftover candidate inode is the
        // only residue and a retry publishes a fresh one.
        throw new ElizaError(
          "Interaction lock owner candidate cleanup failed before publication.",
          {
            code: "INTERACTION_STORE_OWNER_CANDIDATE_CLEANUP_FAILED",
            cause: candidateCleanupError,
            context: {
              candidatePath: candidate,
              committed: false,
              lockPath: this.lockPath,
              markerPath: `${this.lockPath}.transition`,
              published: false,
              recoveryRequired: false,
              retrySafeAfterRecovery: true,
              retrySafeNow: true,
              ...(publicationError instanceof ElizaError
                ? {
                    publicationErrorCode: publicationError.code,
                    publicationErrorContext: publicationError.context,
                  }
                : publicationError
                  ? { publicationError: String(publicationError) }
                  : {}),
            },
          },
        );
      }
      if (publicationError) throw publicationError;
      if (transitionObserved) await delay(this.pollMs);
    }
    if (await existsLstat(`${this.lockPath}.transition`)) {
      const marker = `${this.lockPath}.transition`;
      storeError(
        "INTERACTION_STORE_RECOVERY_REQUIRED",
        "Interaction store recovery requires all users to stop before the abandoned transition marker is removed.",
        this.transitionRecoveryContext(marker),
      );
    }
    return storeError(
      "INTERACTION_STORE_LOCK_TIMEOUT",
      "Timed out acquiring interaction store lock.",
    );
  }

  private async releaseLock(owner: LockOwner): Promise<void> {
    await this.lockRaceHooks.beforeReleaseRetire?.();
    const startedAt = performance.now();
    while (performance.now() - startedAt <= this.lockTimeoutMs) {
      if (
        await this.retireObservedLock(
          owner.lockIdentity,
          async () => {
            const current = await this.readLockOwner();
            return Boolean(current && current.token === owner.token);
          },
          "release",
          owner.token,
        )
      ) {
        return;
      }
      const currentDirectory = await existsLstat(this.lockPath);
      if (
        !currentDirectory ||
        this.lockIdentity(currentDirectory) !== owner.lockIdentity
      ) {
        break;
      }
      await delay(this.pollMs);
    }
    if (await existsLstat(`${this.lockPath}.transition`)) {
      const marker = `${this.lockPath}.transition`;
      storeError(
        "INTERACTION_STORE_RECOVERY_REQUIRED",
        "Interaction store recovery requires all users to stop before the abandoned transition marker is removed.",
        this.transitionRecoveryContext(marker),
      );
    }
    storeError(
      "INTERACTION_STORE_LOCK_LOST",
      "Interaction store lock ownership changed.",
    );
  }

  private async writeAndSync(filePath: string, value: unknown): Promise<void> {
    const handle = await fs.open(
      filePath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private assertFile(value: unknown): SessionFile {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !validBoundedJson(value)
    ) {
      return storeError(
        "CORRUPT_INTERACTION_SESSION_STORE",
        "Interaction store root is invalid.",
      );
    }
    const document = value as Partial<SessionFile>;
    if (
      document.version !== 1 ||
      !document.sessions ||
      typeof document.sessions !== "object" ||
      Array.isArray(document.sessions)
    ) {
      return storeError(
        "CORRUPT_INTERACTION_SESSION_STORE",
        "Interaction store schema is invalid.",
      );
    }
    if (Object.keys(document.sessions).length > this.maxSessions) {
      return storeError(
        "INTERACTION_SESSION_STORE_LIMIT_EXCEEDED",
        "Interaction store contains too many sessions.",
      );
    }
    for (const [reference, session] of Object.entries(document.sessions)) {
      if (
        !/^[a-f0-9]{32}$/.test(reference) ||
        !structurallyValidSession(session, reference)
      ) {
        return storeError(
          "CORRUPT_INTERACTION_SESSION_STORE",
          "Interaction store contains an invalid session.",
          { reference },
        );
      }
    }
    return document as SessionFile;
  }

  private async readFile(): Promise<SessionFile> {
    const stat = await existsLstat(this.filePath);
    if (!stat) return { version: 1, sessions: {} };
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return storeError(
        "UNSAFE_INTERACTION_STORE_PATH",
        "Interaction store became a non-regular file.",
      );
    }
    if (
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > this.maxStoreBytes
    ) {
      return storeError(
        stat.size > this.maxStoreBytes
          ? "INTERACTION_SESSION_STORE_LIMIT_EXCEEDED"
          : "UNSAFE_INTERACTION_STORE_PATH",
        "Interaction store file is unsafe or exceeds its byte limit.",
      );
    }
    const handle = await fs.open(
      this.filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== stat.dev ||
        opened.ino !== stat.ino ||
        opened.nlink !== 1 ||
        (opened.mode & 0o077) !== 0 ||
        opened.size > this.maxStoreBytes
      ) {
        return storeError(
          "UNSAFE_INTERACTION_STORE_PATH",
          "Interaction store file identity changed while opening.",
        );
      }
      const raw = await handle.readFile("utf8");
      return this.assertFile(JSON.parse(raw) as unknown);
    } catch (error) {
      if (error instanceof SyntaxError) {
        // error-policy:J1 persistence corruption is surfaced, never reset.
        return storeError(
          "CORRUPT_INTERACTION_SESSION_STORE",
          "Interaction store JSON is corrupt.",
        );
      }
      throw error;
    } finally {
      await handle.close();
    }
  }

  private prune(document: SessionFile, now: number): number {
    let deleted = 0;
    for (const [reference, session] of Object.entries(document.sessions)) {
      const collectAt =
        session.consume.state === "completed"
          ? Date.parse(session.consume.completedAt) + this.retentionMs
          : session.consume.state === "committed"
            ? Date.parse(session.consume.committedAt) +
              this.committedRetentionMs
            : Date.parse(session.expiresAt) + this.retentionMs;
      if (collectAt <= now) {
        delete document.sessions[reference];
        deleted += 1;
      }
    }
    return deleted;
  }

  private async writeFile(document: SessionFile): Promise<void> {
    if (
      Object.keys(document.sessions).length > this.maxSessions ||
      !validBoundedJson(document)
    ) {
      storeError(
        "INTERACTION_SESSION_STORE_LIMIT_EXCEEDED",
        "Interaction store exceeds its structural limits.",
      );
    }
    if (
      Buffer.byteLength(JSON.stringify(document), "utf8") > this.maxStoreBytes
    ) {
      storeError(
        "INTERACTION_SESSION_STORE_LIMIT_EXCEEDED",
        "Interaction store exceeds its byte limit.",
      );
    }
    const temp = `${this.filePath}.tmp-${process.pid}-${newToken()}`;
    let renameCommitted = false;
    let directorySynced = false;
    try {
      await this.writeAndSync(temp, document);
      await fs.rename(temp, this.filePath);
      renameCommitted = true;
      const directoryHandle = await fs.open(this.directory, constants.O_RDONLY);
      try {
        await this.lockRaceHooks.beforeStateDirectorySync?.();
        await directoryHandle.sync();
        directorySynced = true;
      } finally {
        await directoryHandle.close();
        await this.lockRaceHooks.afterStateDirectoryClose?.();
      }
    } catch (error) {
      if (renameCommitted) {
        // error-policy:J2 The new row is visible after rename; failed directory
        // durability/teardown makes retry unsafe and requires state inspection.
        throw new ElizaError(
          "Interaction store commit requires reconciliation after a post-rename failure.",
          {
            code: "INTERACTION_STORE_COMMIT_AMBIGUOUS",
            cause: error,
            context: {
              committed: directorySynced ? true : "unknown",
              filePath: this.filePath,
              reconciliationRequired: true,
              retrySafe: false,
            },
          },
        );
      }
      throw error;
    } finally {
      try {
        await fs.rm(temp, { force: true });
      } catch {
        // error-policy:J6 temp cleanup must not mask the durable write outcome.
      }
    }
  }

  private async transaction<T>(
    operation: (document: SessionFile) => T | Promise<T>,
  ): Promise<T> {
    const owner = await this.acquireLock();
    let result: T | undefined;
    let operationError: unknown;
    try {
      await this.assertDirectoryIdentity();
      const document = await this.readFile();
      this.prune(document, this.clock());
      result = await operation(document);
      await this.assertDirectoryIdentity();
      await this.writeFile(document);
    } catch (error) {
      operationError = error;
    }
    let releaseError: unknown;
    try {
      await this.releaseLock(owner);
    } catch (error) {
      releaseError = error;
    }
    if (operationError && releaseError) {
      // error-policy:J2 Preserve the transaction failure as the cause when lock
      // teardown also fails, instead of replacing the useful error.
      throw new ElizaError(
        "Interaction transaction failed and lock ownership was lost.",
        {
          code: "INTERACTION_STORE_TRANSACTION_AND_RELEASE_FAILED",
          cause: operationError,
          context: {
            ...(operationError instanceof ElizaError
              ? {
                  operationErrorCode: operationError.code,
                  operationErrorContext: operationError.context,
                }
              : {}),
            releaseError:
              releaseError instanceof Error
                ? releaseError.message
                : String(releaseError),
            ...(releaseError instanceof ElizaError
              ? {
                  releaseErrorCode: releaseError.code,
                  releaseErrorContext: releaseError.context,
                }
              : {}),
          },
        },
      );
    }
    if (operationError) throw operationError;
    if (releaseError) {
      // error-policy:J2 The state rename and directory fsync completed before
      // every release path, so no release failure is safe for caller retry.
      throw new ElizaError(
        "Interaction transaction committed but lock release failed; do not retry the mutation.",
        {
          code:
            releaseError instanceof ElizaError &&
            releaseError.code === "INTERACTION_STORE_RELEASE_CLEANUP_FAILED"
              ? "INTERACTION_STORE_COMMITTED_CLEANUP_FAILED"
              : "INTERACTION_STORE_COMMITTED_RELEASE_FAILED",
          cause: releaseError,
          context: {
            ...(releaseError instanceof ElizaError
              ? {
                  ...releaseError.context,
                  releaseErrorCode: releaseError.code,
                }
              : {
                  releaseError:
                    releaseError instanceof Error
                      ? releaseError.message
                      : String(releaseError),
                }),
            committed: true,
            retrySafeAfterRecovery: false,
          },
        },
      );
    }
    return result as T;
  }

  async create(session: MessageInteractionSession): Promise<void> {
    await this.transaction((document) => {
      if (document.sessions[session.reference]) {
        storeError(
          "MESSAGE_INTERACTION_REFERENCE_COLLISION",
          "Interaction reference already exists.",
        );
      }
      document.sessions[session.reference] = structuredClone(session);
    });
  }

  async get(reference: string): Promise<MessageInteractionSession | null> {
    await this.initialize();
    const document = await this.readFile();
    return document.sessions[reference]
      ? structuredClone(document.sessions[reference])
      : null;
  }

  async claimIfCurrent(
    context: MessageInteractionClaimContext,
  ): Promise<MessageInteractionClaimResult> {
    return this.transaction((document) => {
      const current = document.sessions[context.reference];
      if (!current)
        storeError(
          "MESSAGE_INTERACTION_NOT_FOUND",
          "Interaction session was not found.",
        );
      const result = applyMessageInteractionClaim(current, context);
      document.sessions[context.reference] = structuredClone(result.session);
      return result;
    });
  }

  async completeIfClaimed(
    context: MessageInteractionCompleteContext,
  ): Promise<MessageInteractionSession> {
    return this.transaction((document) => {
      const current = document.sessions[context.reference];
      if (!current)
        storeError(
          "MESSAGE_INTERACTION_NOT_FOUND",
          "Interaction session was not found.",
        );
      const completed = applyMessageInteractionCompletion(current, context);
      document.sessions[context.reference] = structuredClone(completed);
      return completed;
    });
  }

  async listCommitted(args: {
    committedBefore: number;
    limit: number;
  }): Promise<MessageInteractionSession[]> {
    safeInteger(args.committedBefore, "committedBefore", 0);
    safeInteger(args.limit, "limit", 1);
    await this.initialize();
    const document = await this.readFile();
    return Object.values(document.sessions)
      .filter(
        (session) =>
          session.consume.state === "committed" &&
          Date.parse(session.consume.committedAt) <= args.committedBefore,
      )
      .sort((a, b) => a.reference.localeCompare(b.reference))
      .slice(0, args.limit)
      .map((session) => structuredClone(session));
  }

  async reconcileCommitted(
    context: MessageInteractionReconcileContext,
  ): Promise<MessageInteractionSession> {
    return this.transaction((document) => {
      const current = document.sessions[context.reference];
      if (!current)
        storeError(
          "MESSAGE_INTERACTION_NOT_FOUND",
          "Interaction session was not found.",
        );
      const completed = applyMessageInteractionReconciliation(current, context);
      document.sessions[context.reference] = structuredClone(completed);
      return completed;
    });
  }

  async commitIfClaimed(
    context: MessageInteractionCommitContext,
  ): Promise<MessageInteractionSession> {
    return this.transaction((document) => {
      const current = document.sessions[context.reference];
      if (!current)
        storeError(
          "MESSAGE_INTERACTION_NOT_FOUND",
          "Interaction session was not found.",
        );
      const committed = applyMessageInteractionCommit(current, context);
      document.sessions[context.reference] = structuredClone(committed);
      return committed;
    });
  }

  async revokeAuthorization(args: {
    reference: string;
    decisionId: string;
    now: number;
  }): Promise<MessageInteractionSession> {
    return this.transaction((document) => {
      const current = document.sessions[args.reference];
      if (!current)
        storeError(
          "MESSAGE_INTERACTION_NOT_FOUND",
          "Interaction session was not found.",
        );
      const revoked = applyMessageInteractionRevocation(
        current,
        args.decisionId,
        args.now,
      );
      document.sessions[args.reference] = structuredClone(revoked);
      return revoked;
    });
  }

  async deleteExpired(before: number): Promise<number> {
    safeInteger(before, "before", 0);
    return this.transaction((document) => {
      let deleted = 0;
      for (const [reference, session] of Object.entries(document.sessions)) {
        const terminalAt =
          session.consume.state === "completed"
            ? Date.parse(session.consume.completedAt)
            : session.consume.state === "committed"
              ? Date.parse(session.consume.committedAt)
              : Date.parse(session.expiresAt);
        if (terminalAt <= before) {
          delete document.sessions[reference];
          deleted += 1;
        }
      }
      return deleted;
    });
  }
}
