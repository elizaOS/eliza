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
  applyMessageInteractionCommit,
  applyMessageInteractionCompletion,
  applyMessageInteractionRevocation,
  ElizaError,
  type MessageInteractionClaimContext,
  type MessageInteractionClaimResult,
  type MessageInteractionCommitContext,
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
  pollMs?: number;
  retentionMs?: number;
  maxStoreBytes?: number;
  maxSessions?: number;
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
  private readonly maxStoreBytes: number;
  private readonly maxSessions: number;
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

  private async readLockOwner(): Promise<LockOwner | null> {
    try {
      const ownerPath = path.join(this.lockPath, "owner.json");
      const entry = await fs.lstat(ownerPath);
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        entry.nlink !== 1 ||
        (entry.mode & 0o077) !== 0 ||
        entry.size > 4_096
      ) {
        storeError(
          "UNSAFE_INTERACTION_STORE_LOCK",
          "Interaction store lock owner file is unsafe.",
        );
      }
      const handle = await fs.open(
        ownerPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let raw: string;
      try {
        const opened = await handle.stat();
        if (
          opened.dev !== entry.dev ||
          opened.ino !== entry.ino ||
          opened.nlink !== 1 ||
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
      if (
        Date.parse(session.expiresAt) + this.retentionMs <= now &&
        session.consume.state !== "committed" &&
        session.consume.state !== "completed"
      ) {
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
        if (
          Date.parse(session.expiresAt) <= before &&
          session.consume.state !== "committed" &&
          session.consume.state !== "completed"
        ) {
          delete document.sessions[reference];
          deleted += 1;
        }
      }
      return deleted;
    });
  }
}
