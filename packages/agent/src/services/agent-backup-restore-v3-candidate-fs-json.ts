/** Canonical and crash-reconcilable durable JSON publication. */

import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { types as utilTypes } from "node:util";
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
  candidateFsNativeIoView,
  controlled,
  controlledAcquire,
  fileStatExact,
  internalCleanupControl,
  isErrno,
  lstatExact,
  requireControlName,
  requirePositiveSafeInteger,
  requirePrivateSingleLinkFile,
  runAllBoundedInternalCleanup,
  sameIdentity,
  sameStableFile,
  snapshotOwnDataRecord,
  syncDirectory,
  writeAll,
} from "./agent-backup-restore-v3-candidate-fs-control";

const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_IS = Object.is;
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_JOIN = Array.prototype.join;
const ARRAY_SORT = Array.prototype.sort;
const IS_PROXY = utilTypes.isProxy;
const JSON_PARSE = JSON.parse;
const JSON_STRINGIFY = JSON.stringify;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const TYPED_ARRAY_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const TYPED_ARRAY_BUFFER_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "buffer",
)?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "byteOffset",
)?.get;
const REFLECT_APPLY = Reflect.apply;
const INTRINSIC_WEAK_SET = WeakSet;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_DELETE = WeakSet.prototype.delete;
const WEAK_SET_HAS = WeakSet.prototype.has;
const INTRINSIC_UINT8_ARRAY = Uint8Array;
const UINT8_ARRAY_FILL = Uint8Array.prototype.fill;
const BUFFER_FROM = Buffer.from;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const BUFFER_EQUALS = Buffer.prototype.equals;
const BUFFER_TO_STRING = Buffer.prototype.toString;
const IS_UINT8_ARRAY = utilTypes.isUint8Array;
const STRING_ENDS_WITH = String.prototype.endsWith;
const STRING_INCLUDES = String.prototype.includes;
const STRING_SLICE = String.prototype.slice;
const STRING_STARTS_WITH = String.prototype.startsWith;

function typedArrayByteLength(value: Uint8Array): number {
  return REFLECT_APPLY(
    TYPED_ARRAY_BYTE_LENGTH_GETTER as () => number,
    value,
    [],
  );
}

function typedArrayBuffer(value: Uint8Array): ArrayBufferLike {
  return REFLECT_APPLY(
    TYPED_ARRAY_BUFFER_GETTER as () => ArrayBufferLike,
    value,
    [],
  );
}

function typedArrayByteOffset(value: Uint8Array): number {
  return REFLECT_APPLY(
    TYPED_ARRAY_BYTE_OFFSET_GETTER as () => number,
    value,
    [],
  );
}

function zeroBytes(value: Uint8Array, start?: number, end?: number): void {
  REFLECT_APPLY(
    UINT8_ARRAY_FILL,
    value,
    end === undefined
      ? start === undefined
        ? [0]
        : [0, start]
      : [0, start, end],
  );
}

function bufferFromString(value: string, encoding: BufferEncoding): Buffer {
  return REFLECT_APPLY(BUFFER_FROM, Buffer, [value, encoding]);
}

function bufferFromArrayBuffer(
  value: ArrayBufferLike,
  byteOffset: number,
  byteLength: number,
): Buffer {
  return REFLECT_APPLY(BUFFER_FROM, Buffer, [value, byteOffset, byteLength]);
}

function bufferUtf8ByteLength(value: string): number {
  return REFLECT_APPLY(BUFFER_BYTE_LENGTH, Buffer, [value, "utf8"]);
}

function bufferEquals(value: Buffer, other: Uint8Array): boolean {
  return REFLECT_APPLY(BUFFER_EQUALS, value, [other]);
}

function bufferToUtf8(value: Buffer): string {
  return REFLECT_APPLY(BUFFER_TO_STRING, value, ["utf8"]);
}

function joinStrings(value: readonly string[], separator: string): string {
  return REFLECT_APPLY(ARRAY_JOIN, value, [separator]);
}

function sortStrings(value: string[]): string[] {
  REFLECT_APPLY(ARRAY_SORT, value, []);
  return value;
}

function stringEndsWith(value: string, suffix: string): boolean {
  return REFLECT_APPLY(STRING_ENDS_WITH, value, [suffix]);
}

function stringIncludes(value: string, search: string): boolean {
  return REFLECT_APPLY(STRING_INCLUDES, value, [search]);
}

function stringSlice(value: string, start: number, end?: number): string {
  return REFLECT_APPLY(
    STRING_SLICE,
    value,
    end === undefined ? [start] : [start, end],
  );
}

function stringStartsWith(value: string, prefix: string): boolean {
  return REFLECT_APPLY(STRING_STARTS_WITH, value, [prefix]);
}

export interface AgentBackupRestoreV3CandidateDurableJsonReceipt {
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly replayed: boolean;
}

export interface PublishAgentBackupRestoreV3CandidateDurableJsonOptions {
  readonly maximumBytes: number;
}

export function candidateFsCanonicalJson(value: unknown): string {
  const seen = new INTRINSIC_WEAK_SET<object>();
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
      return JSON_STRINGIFY(current);
    }
    if (typeof current === "number") {
      if (!Number.isSafeInteger(current) || OBJECT_IS(current, -0)) {
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
    if (REFLECT_APPLY(WEAK_SET_HAS, seen, [current])) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
        "Candidate durable JSON contains a cycle",
      );
    }
    if (IS_PROXY(current)) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
        "Candidate durable JSON cannot contain proxies",
      );
    }
    REFLECT_APPLY(WEAK_SET_ADD, seen, [current]);
    try {
      if (ARRAY_IS_ARRAY(current)) {
        if (current.length > 10_000) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
            "Candidate durable JSON array exceeds its entry bound",
          );
        }
        const ownKeys = REFLECT_OWN_KEYS(current);
        let exactDenseKeys = ownKeys.length === current.length + 1;
        for (
          let index = 0;
          exactDenseKeys && index < ownKeys.length;
          index += 1
        ) {
          const key = ownKeys[index];
          exactDenseKeys =
            typeof key === "string" &&
            (index < current.length ? key === String(index) : key === "length");
        }
        if (!exactDenseKeys) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
            "Candidate durable JSON arrays must be dense and have no additional keys or symbols",
          );
        }
        const entries: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
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
          entries[entries.length] = encode(descriptor.value, depth + 1);
        }
        return `[${joinStrings(entries, ",")}]`;
      }
      const prototype = OBJECT_GET_PROTOTYPE_OF(current);
      if (prototype !== OBJECT_PROTOTYPE && prototype !== null) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
          "Candidate durable JSON must contain only plain objects",
        );
      }
      const ownKeys = REFLECT_OWN_KEYS(current);
      let exactStringKeys = ownKeys.length <= 10_000;
      for (
        let index = 0;
        exactStringKeys && index < ownKeys.length;
        index += 1
      ) {
        exactStringKeys = typeof ownKeys[index] === "string";
      }
      if (!exactStringKeys) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
          "Candidate durable JSON object has unsafe keys or symbols",
        );
      }
      const keys = sortStrings(ownKeys as string[]);
      const fields: string[] = [];
      for (const key of keys) {
        if (
          key === "__proto__" ||
          key === "prototype" ||
          key === "constructor" ||
          bufferUtf8ByteLength(key) > 512
        ) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
            "Candidate durable JSON contains an unsafe field name",
          );
        }
        const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(current, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
            "Candidate durable JSON objects cannot contain accessors or non-enumerable fields",
          );
        }
        fields[fields.length] = `${JSON_STRINGIFY(key)}:${encode(
          descriptor.value,
          depth + 1,
        )}`;
      }
      return `{${joinStrings(fields, ",")}}`;
    } finally {
      REFLECT_APPLY(WEAK_SET_DELETE, seen, [current]);
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
  let bytes: Uint8Array | null = null;
  let result: Uint8Array | null = null;
  let primaryFailure: unknown;
  let primaryFailed = false;
  try {
    const opened = await assertBoundFile(handle, filePath, visible, control);
    bytes = new INTRINSIC_UINT8_ARRAY(opened.size);
    const ioBytes = candidateFsNativeIoView(bytes);
    const byteLength = typedArrayByteLength(bytes);
    let offset = 0;
    while (offset < byteLength) {
      const read = await controlled(
        () => handle.read(ioBytes, offset, byteLength - offset, offset),
        control,
      );
      if (read.bytesRead <= 0) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_TRUNCATED",
          "Candidate durable file ended before its descriptor size",
        );
      }
      offset += read.bytesRead;
    }
    const after = await assertBoundFile(handle, filePath, visible, control);
    if (!sameStableFile(opened, after)) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_CHANGED",
        "Candidate durable file changed while it was read",
      );
    }
    result = bytes;
  } catch (cause) {
    primaryFailed = true;
    primaryFailure = cause;
  }
  let cleanupFailure: unknown;
  let cleanupFailed = false;
  try {
    await handle.close();
  } catch (cause) {
    cleanupFailed = true;
    cleanupFailure = cause;
  }
  if (primaryFailed || cleanupFailed) {
    if (bytes) zeroBytes(bytes);
    if (primaryFailed && cleanupFailed) {
      throw new AgentBackupRestoreV3CandidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_READ_CLEANUP_FAILED",
        "Candidate durable file read and descriptor cleanup both failed",
        { cause: new AggregateError([primaryFailure, cleanupFailure]) },
      );
    }
    if (primaryFailed) throw primaryFailure;
    throw cleanupFailure;
  }
  if (!result) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
      "Candidate durable file read ended without exact bytes",
    );
  }
  return result;
}

async function reconcileDurableJsonPublication(
  authority: AgentBackupRestoreV3CandidateFsControl,
  name: string,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<void> {
  const finalPath = authority.directPath(name, "durable JSON name");
  const derivation = createHash("sha256").update(name).digest("hex");
  const prefix = `.publish-${stringSlice(derivation, 0, 16)}-`;
  let finalStats = null;
  try {
    finalStats = await controlled(() => lstatExact(finalPath), control);
  } catch (cause) {
    if (!isErrno(cause, "ENOENT")) throw cause;
  }
  if (finalStats && finalStats.linkCount === 1) return;
  if (!finalStats) return;
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
  const directory = await controlledAcquire(
    () =>
      fs.opendir(authority.attemptAuthority.anchor, {
        encoding: "buffer" as BufferEncoding,
      }),
    (lateDirectory) => lateDirectory.close(),
    control,
  );
  const aliases: string[] = [];
  try {
    while (true) {
      const directoryEntry = await controlled(() => directory.read(), control);
      if (directoryEntry === null) break;
      const rawName = IS_UINT8_ARRAY(directoryEntry)
        ? directoryEntry
        : directoryEntry.name;
      if (!IS_UINT8_ARRAY(rawName)) continue;
      const encodedName = bufferFromArrayBuffer(
        typedArrayBuffer(rawName),
        typedArrayByteOffset(rawName),
        typedArrayByteLength(rawName),
      );
      let entry: string;
      try {
        entry = bufferToUtf8(encodedName);
        const roundTrip = bufferFromString(entry, "utf8");
        try {
          if (!bufferEquals(roundTrip, encodedName)) continue;
          if (
            !stringStartsWith(entry, prefix) ||
            !stringEndsWith(entry, ".tmp")
          )
            continue;
          requireControlName(entry, "durable JSON temp name");
          const aliasPath = authority.directPath(
            entry,
            "durable JSON temp name",
          );
          const aliasStats = await controlled(
            () => lstatExact(aliasPath),
            control,
          );
          if (
            !aliasStats.file ||
            aliasStats.symbolicLink ||
            aliasStats.linkCount !== 2 ||
            (aliasStats.mode & 0o7077) !== 0
          ) {
            candidateFsError(
              "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_UNSAFE",
              "Candidate durable JSON temp has an unsafe link topology",
            );
          }
          if (sameIdentity(aliasStats, finalStats)) {
            aliases[aliases.length] = aliasPath;
          }
        } finally {
          zeroBytes(roundTrip);
        }
      } finally {
        zeroBytes(encodedName);
      }
    }
  } finally {
    await boundedInternalCleanup(() => directory.close());
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
    const body = stringSlice(text, 0, -1);
    if (!stringEndsWith(text, "\n") || stringIncludes(body, "\n")) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
        "Candidate durable JSON does not have its exact framing",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON_PARSE(body);
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
    zeroBytes(bytes);
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
  const publicationOptions = snapshotOwnDataRecord(
    options,
    ["maximumBytes"],
    ["maximumBytes"],
    "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LIMIT_INVALID",
    "Candidate durable JSON options must be exact data properties",
  );
  const maximumBytes = requirePositiveSafeInteger(
    publicationOptions.maximumBytes as number,
    "maximumBytes",
  );
  const finalPath = authority.directPath(name, "durable JSON name");
  const canonical = candidateFsCanonicalJson(value);
  const persisted = bufferFromString(`${canonical}\n`, "utf8");
  const persistedByteLength = typedArrayByteLength(persisted);
  if (persistedByteLength > maximumBytes) {
    zeroBytes(persisted);
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_LIMIT",
      "Candidate durable JSON exceeds its explicit byte bound",
    );
  }
  const sha256 = createHash("sha256").update(persisted).digest("hex");
  const expectedResult = {
    sizeBytes: persistedByteLength,
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
      if (!bufferEquals(persisted, existing)) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_CONFLICT",
          "Candidate durable JSON replay differs from the persisted value",
        );
      }
      return "exact";
    } finally {
      zeroBytes(existing);
    }
  };

  let operationLock: AgentBackupRestoreV3CandidateFsLock | null = null;
  let tempPath: string | null = null;
  let tempHandle: FileHandle | null = null;
  let releaseLockUse: (() => void) | null = null;
  let primaryFailure: unknown;
  let result: Readonly<AgentBackupRestoreV3CandidateDurableJsonReceipt> | null =
    null;
  try {
    await authority.assertAuthority(control);
    operationLock = await authority.operationLock(
      `.publish-${stringSlice(
        createHash("sha256").update(name).digest("hex"),
        0,
        16,
      )}`,
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
    releaseLockUse = authority.beginLockUse(activeLock);
    await authority.assertLockHeld(activeLock, control);
    await reconcileDurableJsonPublication(authority, name, control);
    await authority.syncAttemptRoot(control);
    if ((await compareExisting()) === "exact") {
      result = OBJECT_FREEZE({ ...expectedResult, replayed: true });
    } else {
      const tempDerivation = createHash("sha256").update(name).digest("hex");
      const tempName = `.publish-${stringSlice(
        tempDerivation,
        0,
        16,
      )}-${randomUUID()}.tmp`;
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
      result = OBJECT_FREEZE({ ...expectedResult, replayed: !published });
    }
    await authority.assertLockHeld(activeLock, control);
  } catch (cause) {
    primaryFailure = cause;
  }

  let cleanupFailure: unknown;
  try {
    const cleanupOperations: Array<() => Promise<void>> = [];
    if (tempHandle) {
      const handle = tempHandle;
      tempHandle = null;
      cleanupOperations.push(() => handle.close());
    }
    if (tempPath) {
      const pathToRemove = tempPath;
      tempPath = null;
      cleanupOperations.push(async () => {
        try {
          await fs.unlink(pathToRemove);
        } catch (cause) {
          if (!isErrno(cause, "ENOENT")) throw cause;
        }
        await syncDirectory(
          authority.attemptAuthority,
          internalCleanupControl(),
        );
      });
    }
    if (operationLock) {
      if (releaseLockUse) {
        const releaseUse = releaseLockUse;
        releaseLockUse = null;
        cleanupOperations.push(async () => releaseUse());
      }
      const lock = operationLock;
      operationLock = null;
      cleanupOperations.push(() => lock.release(internalCleanupControl()));
    } else if (releaseLockUse) {
      const releaseUse = releaseLockUse;
      releaseLockUse = null;
      cleanupOperations.push(async () => releaseUse());
    }
    await runAllBoundedInternalCleanup(cleanupOperations);
  } catch (cause) {
    cleanupFailure = cause;
  } finally {
    zeroBytes(persisted);
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
