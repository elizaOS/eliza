/** Canonical and crash-reconcilable durable JSON publication. */

import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import type { AgentBackupRestoreV3OperationControl } from "@elizaos/shared";
import {
  type AgentBackupRestoreV3CandidateFsControl,
  AgentBackupRestoreV3CandidateFsError,
  type AgentBackupRestoreV3CandidateFsLock,
  assertActive,
  assertBoundFile,
  boundedInternalCleanup,
  type CandidateFsExactStats,
  candidateFsError,
  controlled,
  controlledAcquire,
  fileStatExact,
  internalCleanupControl,
  isErrno,
  lstatExact,
  requireControlName,
  requirePositiveSafeInteger,
  requirePrivateSingleLinkFile,
  sameIdentity,
  sameStableFile,
  syncDirectory,
  writeAll,
} from "./agent-backup-restore-v3-candidate-fs-control";

export interface AgentBackupRestoreV3CandidateDurableJsonReceipt {
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly replayed: boolean;
}

export interface PublishAgentBackupRestoreV3CandidateDurableJsonOptions {
  readonly maximumBytes: number;
}

export function candidateFsCanonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const encode = (current: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > 100_000 || depth > 32) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
        "Candidate durable JSON exceeds its structural bound",
      );
    }
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      if (!Number.isSafeInteger(current) || Object.is(current, -0)) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
          "Candidate durable JSON contains a non-canonical number",
        );
      }
      return String(current);
    }
    if (typeof current !== "object" || current === undefined) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
        "Candidate durable JSON contains a non-JSON value",
      );
    }
    if (seen.has(current)) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
        "Candidate durable JSON contains a cycle",
      );
    }
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > 10_000) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
            "Candidate durable JSON array exceeds its entry bound",
          );
        }
        const ownKeys = Reflect.ownKeys(current);
        if (
          ownKeys.length !== current.length + 1 ||
          ownKeys.some(
            (key, index) =>
              typeof key !== "string" ||
              (index < current.length
                ? key !== String(index)
                : key !== "length"),
          )
        ) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
            "Candidate durable JSON arrays must be dense and have no additional keys or symbols",
          );
        }
        const entries: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            current,
            String(index),
          );
          if (
            !descriptor ||
            !("value" in descriptor) ||
            !descriptor.enumerable
          ) {
            candidateFsError(
              "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
              "Candidate durable JSON arrays cannot contain holes or accessors",
            );
          }
          entries.push(encode(descriptor.value, depth + 1));
        }
        return `[${entries.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
          "Candidate durable JSON must contain only plain objects",
        );
      }
      const ownKeys = Reflect.ownKeys(current);
      if (
        ownKeys.length > 10_000 ||
        ownKeys.some((key) => typeof key !== "string")
      ) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
          "Candidate durable JSON object has unsafe keys or symbols",
        );
      }
      const keys = ownKeys as string[];
      return `{${keys
        .sort()
        .map((key) => {
          if (
            key === "__proto__" ||
            key === "prototype" ||
            key === "constructor" ||
            Buffer.byteLength(key, "utf8") > 512
          ) {
            candidateFsError(
              "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
              "Candidate durable JSON contains an unsafe field name",
            );
          }
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (
            !descriptor ||
            !("value" in descriptor) ||
            !descriptor.enumerable
          ) {
            candidateFsError(
              "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
              "Candidate durable JSON objects cannot contain accessors or non-enumerable fields",
            );
          }
          return `${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`;
        })
        .join(",")}}`;
    } finally {
      seen.delete(current);
    }
  };
  return encode(value, 0);
}

async function readBoundRegularFile(
  filePath: string,
  maximumBytes: number,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<Uint8Array | null> {
  let visible: CandidateFsExactStats;
  try {
    visible = await controlled(() => lstatExact(filePath), control);
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return null;
    throw cause;
  }
  requirePrivateSingleLinkFile(
    visible,
    "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_UNSAFE",
    "Candidate durable file is not one private regular file",
  );
  if (visible.size > maximumBytes) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_LIMIT",
      "Candidate durable file exceeds its explicit byte bound",
    );
  }
  const handle = await controlledAcquire(
    () => fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW),
    (lateHandle) => lateHandle.close(),
    control,
  );
  try {
    const opened = await assertBoundFile(handle, filePath, visible, control);
    const bytes = new Uint8Array(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await controlled(
        () => handle.read(bytes, offset, bytes.byteLength - offset, offset),
        control,
      );
      if (read.bytesRead <= 0) {
        bytes.fill(0);
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_TRUNCATED",
          "Candidate durable file ended before its descriptor size",
        );
      }
      offset += read.bytesRead;
    }
    const after = await assertBoundFile(handle, filePath, visible, control);
    if (!sameStableFile(opened, after)) {
      bytes.fill(0);
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_CHANGED",
        "Candidate durable file changed while it was read",
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function reconcileDurableJsonPublication(
  authority: AgentBackupRestoreV3CandidateFsControl,
  name: string,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<void> {
  const finalPath = authority.directPath(name, "durable JSON name");
  const prefix = `.publish-${createHash("sha256")
    .update(name)
    .digest("hex")
    .slice(0, 16)}-`;
  let finalStats = null;
  try {
    finalStats = await controlled(() => lstatExact(finalPath), control);
  } catch (cause) {
    if (!isErrno(cause, "ENOENT")) throw cause;
  }
  if (finalStats && finalStats.linkCount === 1) return;
  if (finalStats) {
    if (
      !finalStats.file ||
      finalStats.symbolicLink ||
      finalStats.linkCount !== 2 ||
      (finalStats.mode & 0o077) !== 0
    ) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_UNSAFE",
        "Candidate durable JSON has an unexplained link topology",
      );
    }
  }
  const names = await controlled(
    () => fs.readdir(authority.attemptAuthority.anchor),
    control,
  );
  const aliases: string[] = [];
  for (const entry of names) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) continue;
    requireControlName(entry, "durable JSON temp name");
    const aliasPath = authority.directPath(entry, "durable JSON temp name");
    const aliasStats = await controlled(() => lstatExact(aliasPath), control);
    if (
      !aliasStats.file ||
      aliasStats.symbolicLink ||
      aliasStats.linkCount !== (finalStats ? 2 : 1) ||
      (aliasStats.mode & 0o077) !== 0
    ) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_UNSAFE",
        "Candidate durable JSON temp has an unsafe link topology",
      );
    }
    if (!finalStats || sameIdentity(aliasStats, finalStats)) {
      aliases.push(aliasPath);
    }
  }
  if (finalStats && aliases.length !== 1) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_COMMIT_AMBIGUOUS",
      "Candidate durable JSON linked commit cannot be reconciled exactly",
      { context: { aliases: aliases.length, name } },
    );
  }
  assertActive(control);
  await boundedInternalCleanup(async () => {
    for (const alias of aliases) await fs.unlink(alias);
    if (aliases.length > 0) {
      await syncDirectory(authority.attemptAuthority, internalCleanupControl());
    }
  });
  if (finalStats) {
    const reconciled = await controlled(() => lstatExact(finalPath), control);
    requirePrivateSingleLinkFile(
      reconciled,
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_UNSAFE",
      "Candidate durable JSON did not reconcile to one private link",
    );
    if (!sameIdentity(reconciled, finalStats)) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_COMMIT_AMBIGUOUS",
        "Candidate durable JSON identity changed during reconciliation",
      );
    }
  }
}

export async function readCandidateFsCanonicalJson(
  authority: AgentBackupRestoreV3CandidateFsControl,
  name: string,
  maximumBytes: number,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<unknown | null> {
  await reconcileDurableJsonPublication(authority, name, control);
  await authority.syncAttemptRoot(control);
  const filePath = authority.directPath(name, "durable JSON name");
  const bytes = await readBoundRegularFile(filePath, maximumBytes, control);
  if (bytes === null) return null;
  try {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
        "Candidate durable JSON is not valid UTF-8",
        { cause },
      );
    }
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
        "Candidate durable JSON does not have its exact framing",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(0, -1));
    } catch (cause) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
        "Candidate durable JSON is malformed",
        { cause },
      );
    }
    if (`${candidateFsCanonicalJson(parsed)}\n` !== text) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
        "Candidate durable JSON is not in canonical byte form",
      );
    }
    return parsed;
  } finally {
    bytes.fill(0);
  }
}

export async function publishCandidateFsDurableJson(
  authority: AgentBackupRestoreV3CandidateFsControl,
  name: string,
  value: unknown,
  options: Readonly<PublishAgentBackupRestoreV3CandidateDurableJsonOptions>,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  heldLock?: AgentBackupRestoreV3CandidateFsLock,
): Promise<Readonly<AgentBackupRestoreV3CandidateDurableJsonReceipt>> {
  const maximumBytes = requirePositiveSafeInteger(
    options?.maximumBytes,
    "maximumBytes",
  );
  const finalPath = authority.directPath(name, "durable JSON name");
  const canonical = candidateFsCanonicalJson(value);
  const persisted = Buffer.from(`${canonical}\n`, "utf8");
  if (persisted.byteLength > maximumBytes) {
    persisted.fill(0);
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_LIMIT",
      "Candidate durable JSON exceeds its explicit byte bound",
    );
  }
  const sha256 = createHash("sha256").update(persisted).digest("hex");
  const expectedResult = {
    sizeBytes: persisted.byteLength,
    sha256,
  } as const;
  const compareExisting = async (): Promise<"absent" | "exact"> => {
    const existing = await readBoundRegularFile(
      finalPath,
      maximumBytes,
      control,
    );
    if (existing === null) return "absent";
    try {
      if (!Buffer.from(existing).equals(persisted)) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_CONFLICT",
          "Candidate durable JSON replay differs from the persisted value",
        );
      }
      return "exact";
    } finally {
      existing.fill(0);
    }
  };

  let operationLock: AgentBackupRestoreV3CandidateFsLock | null = null;
  let tempPath: string | null = null;
  let tempHandle: FileHandle | null = null;
  let primaryFailure: unknown;
  let result: Readonly<AgentBackupRestoreV3CandidateDurableJsonReceipt> | null =
    null;
  try {
    await authority.assertAuthority(control);
    operationLock = await authority.operationLock(
      `.publish-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`,
      control,
      heldLock,
    );
    const activeLock = operationLock ?? heldLock;
    if (!activeLock) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_INVALID",
        "Candidate JSON publication did not obtain an exact inode-lock lease",
      );
    }
    await authority.assertLockHeld(activeLock, control);
    await reconcileDurableJsonPublication(authority, name, control);
    await authority.syncAttemptRoot(control);
    if ((await compareExisting()) === "exact") {
      result = Object.freeze({ ...expectedResult, replayed: true });
    } else {
      const tempName = `.publish-${createHash("sha256")
        .update(name)
        .digest("hex")
        .slice(0, 16)}-${randomUUID()}.tmp`;
      tempPath = authority.directPath(tempName, "durable JSON temp name");
      tempHandle = await controlledAcquire(
        () =>
          fs.open(
            tempPath as string,
            constants.O_CREAT |
              constants.O_EXCL |
              constants.O_RDWR |
              constants.O_NOFOLLOW,
            0o600,
          ),
        (lateHandle) => lateHandle.close(),
        control,
      );
      const opened = await controlled(
        () => fileStatExact(tempHandle as FileHandle),
        control,
      );
      requirePrivateSingleLinkFile(
        opened,
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_UNSAFE",
        "Candidate durable JSON temp is not one private regular file",
      );
      await writeAll(tempHandle, persisted, 0, control);
      await controlled(() => (tempHandle as FileHandle).sync(), control);
      await assertBoundFile(tempHandle, tempPath, opened, control);
      assertActive(control);
      let published = false;
      try {
        await fs.link(tempPath, finalPath);
        published = true;
      } catch (cause) {
        if (!isErrno(cause, "EEXIST")) throw cause;
      }
      await boundedInternalCleanup(async () => {
        try {
          await fs.unlink(tempPath as string);
        } catch (cause) {
          if (!isErrno(cause, "ENOENT")) throw cause;
        }
        tempPath = null;
        await syncDirectory(
          authority.attemptAuthority,
          internalCleanupControl(),
        );
      });
      await tempHandle.close();
      tempHandle = null;
      assertActive(control);
      await authority.assertLockHeld(activeLock, control);
      if ((await compareExisting()) !== "exact") {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_CONFLICT",
          "Candidate durable JSON differs after no-replace publication",
        );
      }
      result = Object.freeze({ ...expectedResult, replayed: !published });
    }
    await authority.assertLockHeld(activeLock, control);
  } catch (cause) {
    primaryFailure = cause;
  }

  let cleanupFailure: unknown;
  try {
    await boundedInternalCleanup(async () => {
      if (tempHandle) {
        await tempHandle.close();
        tempHandle = null;
      }
      if (tempPath) {
        try {
          await fs.unlink(tempPath);
        } catch (cause) {
          if (!isErrno(cause, "ENOENT")) throw cause;
        }
        tempPath = null;
        await syncDirectory(
          authority.attemptAuthority,
          internalCleanupControl(),
        );
      }
      if (operationLock) {
        await operationLock.release(internalCleanupControl());
        operationLock = null;
      }
    });
  } catch (cause) {
    cleanupFailure = cause;
  } finally {
    persisted.fill(0);
  }
  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw new AgentBackupRestoreV3CandidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PUBLICATION_FAILED",
      "Candidate durable JSON publication and bounded cleanup both failed",
      { cause: new AggregateError([primaryFailure, cleanupFailure]) },
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (!result) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PUBLICATION_FAILED",
      "Candidate durable JSON publication ended without a receipt",
    );
  }
  return result;
}
