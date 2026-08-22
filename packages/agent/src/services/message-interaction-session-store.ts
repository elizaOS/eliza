/**
 * Persists message-interaction sessions for one host with cross-process atomic
 * transitions. Multi-host deployments should implement the same store contract
 * with a transactional database row or outbox rather than sharing this file.
 */

import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  applyMessageInteractionClaim,
  applyMessageInteractionCompletion,
  applyMessageInteractionRevocation,
  ElizaError,
  type MessageInteractionClaimContext,
  type MessageInteractionClaimResult,
  type MessageInteractionCompleteContext,
  type MessageInteractionSession,
  type MessageInteractionSessionStore,
} from "@elizaos/core";

interface SessionFile {
  version: 1;
  sessions: Record<string, MessageInteractionSession>;
}

interface LockOwner {
  pid: number;
  token: string;
  createdAt: number;
  expiresAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validIsoDate(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function structurallyValidConsume(value: Record<string, unknown>): boolean {
  if (value.state === "pending") return true;
  if (value.state !== "claimed" && value.state !== "completed") return false;
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
  if (value.state === "claimed") return validIsoDate(value.claimExpiresAt);
  const receipt = value.receipt;
  return (
    validIsoDate(value.completedAt) &&
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
    typeof value.purpose === "string" &&
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
    (authorization.revokedAt === null ||
      validIsoDate(authorization.revokedAt)) &&
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
  pollMs?: number;
  retentionMs?: number;
  clock?: () => number;
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
 * complete prior or next revision across process/power loss; the lock directory
 * serializes independent host processes.
 */
export class FileMessageInteractionSessionStore
  implements MessageInteractionSessionStore
{
  private readonly directory: string;
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly pollMs: number;
  private readonly retentionMs: number;
  private readonly clock: () => number;
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
    this.pollMs = safeInteger(options.pollMs ?? 10, "pollMs", 1);
    this.retentionMs = safeInteger(
      options.retentionMs ?? 7 * 24 * 60 * 60 * 1_000,
      "retentionMs",
      0,
    );
    this.clock = options.clock ?? Date.now;
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

  private async readLockOwner(): Promise<LockOwner | null> {
    try {
      const raw = await fs.readFile(
        path.join(this.lockPath, "owner.json"),
        "utf8",
      );
      const value = JSON.parse(raw) as Partial<LockOwner>;
      if (
        !Number.isSafeInteger(value.pid) ||
        typeof value.token !== "string" ||
        !Number.isSafeInteger(value.createdAt) ||
        !Number.isSafeInteger(value.expiresAt)
      ) {
        return null;
      }
      return value as LockOwner;
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

  private async recoverStaleLock(now: number): Promise<boolean> {
    const lockStat = await existsLstat(this.lockPath);
    if (!lockStat) return true;
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
      storeError(
        "UNSAFE_INTERACTION_STORE_LOCK",
        "Interaction store lock is not a real directory.",
      );
    }
    const owner = await this.readLockOwner();
    const stale = owner
      ? owner.expiresAt <= now && !this.processAlive(owner.pid)
      : lockStat.mtimeMs + this.staleLockMs <= now;
    if (!stale) return false;
    const quarantine = `${this.lockPath}.stale-${process.pid}-${newToken()}`;
    try {
      await fs.rename(this.lockPath, quarantine);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return true;
      throw error;
    }
    try {
      await fs.rm(quarantine, { recursive: true });
    } catch {
      // error-policy:J6 renamed stale lock no longer blocks the authority.
    }
    return true;
  }

  private async acquireLock(): Promise<LockOwner> {
    await this.initialize();
    const startedAt = performance.now();
    while (performance.now() - startedAt <= this.lockTimeoutMs) {
      const now = this.clock();
      let createdLock = false;
      try {
        await fs.mkdir(this.lockPath, { mode: 0o700 });
        createdLock = true;
        const owner: LockOwner = {
          pid: process.pid,
          token: newToken(),
          createdAt: now,
          expiresAt: now + this.staleLockMs,
        };
        await this.writeAndSync(path.join(this.lockPath, "owner.json"), owner);
        return owner;
      } catch (error) {
        if (createdLock) {
          try {
            await fs.rm(this.lockPath, { recursive: true });
          } catch {
            // error-policy:J6 failed lock construction is already fatal; cleanup
            // must not replace its originating filesystem error.
          }
        }
        if (!isErrno(error, "EEXIST")) throw error;
        await this.recoverStaleLock(now);
        await delay(this.pollMs);
      }
    }
    return storeError(
      "INTERACTION_STORE_LOCK_TIMEOUT",
      "Timed out acquiring interaction store lock.",
    );
  }

  private async releaseLock(owner: LockOwner): Promise<void> {
    const current = await this.readLockOwner();
    if (!current || current.token !== owner.token) {
      storeError(
        "INTERACTION_STORE_LOCK_LOST",
        "Interaction store lock ownership changed.",
      );
    }
    await fs.rm(this.lockPath, { recursive: true });
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
    if (!value || typeof value !== "object" || Array.isArray(value)) {
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
    const handle = await fs.open(
      this.filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
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
      if (Date.parse(session.expiresAt) + this.retentionMs <= now) {
        delete document.sessions[reference];
        deleted += 1;
      }
    }
    return deleted;
  }

  private async writeFile(document: SessionFile): Promise<void> {
    const temp = `${this.filePath}.tmp-${process.pid}-${newToken()}`;
    try {
      await this.writeAndSync(temp, document);
      await fs.rename(temp, this.filePath);
      const directoryHandle = await fs.open(this.directory, constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
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
    try {
      await this.assertDirectoryIdentity();
      const document = await this.readFile();
      this.prune(document, this.clock());
      const result = await operation(document);
      await this.assertDirectoryIdentity();
      await this.writeFile(document);
      return result;
    } finally {
      await this.releaseLock(owner);
    }
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
        if (Date.parse(session.expiresAt) <= before) {
          delete document.sessions[reference];
          deleted += 1;
        }
      }
      return deleted;
    });
  }
}
