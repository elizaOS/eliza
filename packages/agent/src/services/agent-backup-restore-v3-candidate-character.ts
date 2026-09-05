/** Exact materializer for the authenticated restore-v3 character inbox. */

import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { ElizaError, parseAndValidateCharacter } from "@elizaos/core";
import {
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  type AgentBackupRestoreV3ComponentReceipt,
  AgentBackupRestoreV3ComponentReceiptSchema,
  type AgentBackupRestoreV3OperationControl,
  type AgentBackupRestoreV3StagingSession,
} from "@elizaos/shared";
import {
  type AgentBackupRestoreV3CandidateFileTreeFileProof,
  type AgentBackupRestoreV3CandidateFileTreeProof,
  type AgentBackupRestoreV3CandidateFs,
  type AgentBackupRestoreV3CandidateFsLock,
  isAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import {
  snapshotOperationControl,
  snapshotOwnDataRecord,
} from "./agent-backup-restore-v3-candidate-fs-control";
import { candidateFsCanonicalJson } from "./agent-backup-restore-v3-candidate-fs-json";
import {
  AgentBackupRestoreV3CandidateRecordError,
  bindAgentBackupRestoreV3CandidateRecordSession,
  computeAgentBackupRestoreV3CandidateSessionSha256,
  readAgentBackupRestoreV3CandidateRecord,
  snapshotAgentBackupRestoreV3CandidateSession,
} from "./agent-backup-restore-v3-candidate-records";

const CHARACTER_FORMAT =
  "elizaos.agent-backup.restore-v3-candidate-character.v1";
const CHARACTER_DIRECTORY = "components/character";
const CHARACTER_PATH = "character.json";
const FINISH_MARKER = ".restore-v3-component-c0.character.finish.json";
const FINISH_MAXIMUM_BYTES = 64 * 1024;
const REFLECT_APPLY = Reflect.apply;
const INTRINSIC_UINT8_ARRAY = Uint8Array;
const INTRINSIC_UINT8_ARRAY_SET = Uint8Array.prototype.set;
const INTRINSIC_UINT8_ARRAY_FILL = Uint8Array.prototype.fill;
const INTRINSIC_UINT8_ARRAY_SUBARRAY = Uint8Array.prototype.subarray;

export const AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_MAXIMUM_BYTES =
  16 * 1024 * 1024;

export interface AgentBackupRestoreV3CandidateCharacterLifecycle {
  readonly afterInboxValidated?: () => void;
  readonly afterFilePublished?: (
    proof: Readonly<AgentBackupRestoreV3CandidateFileTreeFileProof>,
  ) => void;
  readonly afterDurableFinish?: (
    receipt: Readonly<AgentBackupRestoreV3CandidateCharacterReceipt>,
  ) => void;
}

export interface MaterializeAgentBackupRestoreV3CandidateCharacterInput {
  readonly candidateFs: AgentBackupRestoreV3CandidateFs;
  readonly session: Readonly<AgentBackupRestoreV3StagingSession>;
  readonly receipt: Readonly<AgentBackupRestoreV3ComponentReceipt>;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
  readonly maximumBytes?: number;
  readonly testOnlyLifecycle?: Readonly<AgentBackupRestoreV3CandidateCharacterLifecycle>;
}

export interface AgentBackupRestoreV3CandidateCharacterReceipt {
  readonly version: 1;
  readonly format: typeof CHARACTER_FORMAT;
  readonly sessionSha256: string;
  readonly component: Readonly<AgentBackupRestoreV3ComponentReceipt>;
  readonly outputDirectory: typeof CHARACTER_DIRECTORY;
  readonly file: Readonly<AgentBackupRestoreV3CandidateFileTreeFileProof>;
  readonly tree: Readonly<AgentBackupRestoreV3CandidateFileTreeProof>;
  readonly lastRecordReceiptSha256: string;
  readonly finishSha256: string;
}

export class AgentBackupRestoreV3CandidateCharacterError extends ElizaError {
  override readonly name = "AgentBackupRestoreV3CandidateCharacterError";

  constructor(code: string, message: string, cause?: unknown) {
    super(message, {
      code,
      severity: "fatal",
      ...(cause === undefined ? {} : { cause }),
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function characterError(code: string, message: string, cause?: unknown): never {
  throw new AgentBackupRestoreV3CandidateCharacterError(code, message, cause);
}

function snapshotPlainDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string,
  code = "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_INPUT_INVALID",
): Readonly<Record<string, unknown>> {
  try {
    return snapshotOwnDataRecord(
      value,
      allowedKeys,
      requiredKeys,
      code,
      `${label} must be one exact plain data object`,
    );
  } catch (cause) {
    if (cause instanceof AgentBackupRestoreV3CandidateCharacterError) {
      throw cause;
    }
    characterError(code, `${label} must be one exact plain data object`, cause);
  }
}

function requireCandidateFs(value: unknown): AgentBackupRestoreV3CandidateFs {
  if (
    !value ||
    typeof value !== "object" ||
    isProxy(value) ||
    !isAgentBackupRestoreV3CandidateFs(value)
  ) {
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_INPUT_INVALID",
      "Candidate character filesystem authority must be one non-proxy capability",
    );
  }
  return value as AgentBackupRestoreV3CandidateFs;
}

function snapshotCharacterControl(
  value: unknown,
): Readonly<AgentBackupRestoreV3OperationControl> {
  try {
    return snapshotOperationControl(
      value as Readonly<AgentBackupRestoreV3OperationControl>,
    );
  } catch (cause) {
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_CONTROL_INVALID",
      "Candidate character requires one exact active operation control",
      cause,
    );
  }
}

function snapshotTestOnlyLifecycle(
  value: unknown,
): Readonly<AgentBackupRestoreV3CandidateCharacterLifecycle> | undefined {
  if (value === undefined) return undefined;
  if (process.env.NODE_ENV !== "test") {
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_TEST_HOOK_FORBIDDEN",
      "Candidate character lifecycle hooks are test-only",
    );
  }
  const record = snapshotPlainDataRecord(
    value,
    ["afterInboxValidated", "afterFilePublished", "afterDurableFinish"],
    [],
    "Candidate character test lifecycle",
  );
  if (
    (record.afterInboxValidated !== undefined &&
      typeof record.afterInboxValidated !== "function") ||
    (record.afterFilePublished !== undefined &&
      typeof record.afterFilePublished !== "function") ||
    (record.afterDurableFinish !== undefined &&
      typeof record.afterDurableFinish !== "function")
  ) {
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_INPUT_INVALID",
      "Candidate character test lifecycle hooks must be synchronous functions",
    );
  }
  return Object.freeze({
    ...(record.afterInboxValidated === undefined
      ? {}
      : {
          afterInboxValidated:
            record.afterInboxValidated as AgentBackupRestoreV3CandidateCharacterLifecycle["afterInboxValidated"],
        }),
    ...(record.afterFilePublished === undefined
      ? {}
      : {
          afterFilePublished:
            record.afterFilePublished as AgentBackupRestoreV3CandidateCharacterLifecycle["afterFilePublished"],
        }),
    ...(record.afterDurableFinish === undefined
      ? {}
      : {
          afterDurableFinish:
            record.afterDurableFinish as AgentBackupRestoreV3CandidateCharacterLifecycle["afterDurableFinish"],
        }),
  });
}

function copyPlaintext(
  target: Uint8Array,
  source: Uint8Array,
  offset: number,
): void {
  REFLECT_APPLY(INTRINSIC_UINT8_ARRAY_SET, target, [source, offset]);
}

function plaintextSubarray(
  value: Uint8Array,
  start: number,
  end: number,
): Uint8Array {
  return REFLECT_APPLY(INTRINSIC_UINT8_ARRAY_SUBARRAY, value, [
    start,
    end,
  ]) as Uint8Array;
}

function zeroizePlaintext(value: Uint8Array): void {
  REFLECT_APPLY(INTRINSIC_UINT8_ARRAY_FILL, value, [0]);
}

function invokeTestOnlyHook<T>(
  hook: ((value: T) => void) | undefined,
  value: T,
  label: string,
): void {
  if (!hook) return;
  if (process.env.NODE_ENV !== "test") {
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_TEST_HOOK_FORBIDDEN",
      "Candidate character lifecycle hooks are test-only",
    );
  }
  const returned = (hook as (value: T) => unknown)(value);
  if (returned !== undefined) {
    if (returned instanceof Promise) void returned.catch(() => undefined);
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_TEST_HOOK_ASYNC",
      `${label} test hook must settle synchronously`,
    );
  }
}

function snapshotReceipt(
  value: Readonly<AgentBackupRestoreV3ComponentReceipt>,
): Readonly<AgentBackupRestoreV3ComponentReceipt> {
  if (
    !value ||
    typeof value !== "object" ||
    isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 7
  ) {
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_INPUT_INVALID",
      "Candidate character receipt must be one exact plain object",
    );
  }
  const keys = [
    "componentIndex",
    "componentName",
    "descriptor",
    "dataFrameCount",
    "payloadBytes",
    "payloadSha256",
    "recordStreamContentHmacSha256",
  ];
  const record = value as unknown as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) {
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_INPUT_INVALID",
      "Candidate character receipt fields differ from its exact contract",
    );
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      characterError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_INPUT_INVALID",
        "Candidate character receipt contains an accessor or hidden field",
      );
    }
  }
  const rawDescriptor = record.descriptor;
  if (
    !rawDescriptor ||
    typeof rawDescriptor !== "object" ||
    isProxy(rawDescriptor) ||
    Object.getPrototypeOf(rawDescriptor) !== Object.prototype
  ) {
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_INPUT_INVALID",
      "Candidate character descriptor must be one exact plain object",
    );
  }
  const descriptorRecord = rawDescriptor as Record<string, unknown>;
  const descriptorKeys = [
    "name",
    "format",
    "compression",
    "contentKind",
    "consistency",
  ];
  if (
    Reflect.ownKeys(descriptorRecord).length !== descriptorKeys.length ||
    Object.keys(descriptorRecord).sort().join("\0") !==
      [...descriptorKeys].sort().join("\0")
  ) {
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_INPUT_INVALID",
      "Candidate character descriptor fields differ from its exact contract",
    );
  }
  for (const key of descriptorKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(descriptorRecord, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      characterError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_INPUT_INVALID",
        "Candidate character descriptor contains an accessor or hidden field",
      );
    }
  }
  let parsed: AgentBackupRestoreV3ComponentReceipt;
  try {
    parsed = AgentBackupRestoreV3ComponentReceiptSchema.parse({
      componentIndex: record.componentIndex,
      componentName: record.componentName,
      descriptor: {
        name: descriptorRecord.name,
        format: descriptorRecord.format,
        compression: descriptorRecord.compression,
        contentKind: descriptorRecord.contentKind,
        consistency: descriptorRecord.consistency,
      },
      dataFrameCount: record.dataFrameCount,
      payloadBytes: record.payloadBytes,
      payloadSha256: record.payloadSha256,
      recordStreamContentHmacSha256: record.recordStreamContentHmacSha256,
    });
  } catch (cause) {
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_INPUT_INVALID",
      "Candidate character receipt is not canonical",
      cause,
    );
  }
  if (
    parsed.componentIndex !== 0 ||
    parsed.componentName !== "character" ||
    candidateFsCanonicalJson(parsed.descriptor) !==
      candidateFsCanonicalJson(AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[0])
  ) {
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_COMPONENT_INVALID",
      "Candidate character receipt differs from its exact opaque descriptor",
    );
  }
  return Object.freeze({
    ...parsed,
    descriptor: Object.freeze({ ...parsed.descriptor }),
  });
}

function resolveMaximumBytes(value: number | undefined): number {
  const resolved =
    value ?? AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_MAXIMUM_BYTES;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved <= 0 ||
    resolved > AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_MAXIMUM_BYTES
  ) {
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_LIMIT_INVALID",
      "Candidate character byte bound is outside its supported range",
    );
  }
  return resolved;
}

async function requireNoAdditionalRecord(
  input: Readonly<MaterializeAgentBackupRestoreV3CandidateCharacterInput>,
  component: Readonly<AgentBackupRestoreV3ComponentReceipt>,
  lock: AgentBackupRestoreV3CandidateFsLock,
): Promise<void> {
  try {
    const unexpected = await readAgentBackupRestoreV3CandidateRecord({
      candidateFs: input.candidateFs,
      session: input.session,
      componentIndex: 0,
      dataIndex: component.dataFrameCount,
      control: input.control,
      heldLock: lock,
    });
    zeroizePlaintext(unexpected.payload);
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_RECORD_COUNT_MISMATCH",
      "Candidate character inbox contains a record beyond its authenticated finish",
    );
  } catch (cause) {
    if (
      cause instanceof AgentBackupRestoreV3CandidateRecordError &&
      cause.code === "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_ABSENT"
    ) {
      return;
    }
    throw cause;
  }
}

function buildFinish(
  sessionSha256: string,
  component: Readonly<AgentBackupRestoreV3ComponentReceipt>,
  file: Readonly<AgentBackupRestoreV3CandidateFileTreeFileProof>,
  tree: Readonly<AgentBackupRestoreV3CandidateFileTreeProof>,
  lastRecordReceiptSha256: string,
): Readonly<AgentBackupRestoreV3CandidateCharacterReceipt> {
  const body = Object.freeze({
    version: 1 as const,
    format: CHARACTER_FORMAT,
    sessionSha256,
    component,
    outputDirectory: CHARACTER_DIRECTORY,
    file,
    tree,
    lastRecordReceiptSha256,
  });
  return Object.freeze({
    ...body,
    finishSha256: createHash("sha256")
      .update(candidateFsCanonicalJson(body), "utf8")
      .digest("hex"),
  });
}

async function validatePersistedFinish(
  input: Readonly<MaterializeAgentBackupRestoreV3CandidateCharacterInput>,
  expected: Readonly<AgentBackupRestoreV3CandidateCharacterReceipt>,
  lock: AgentBackupRestoreV3CandidateFsLock,
): Promise<Readonly<AgentBackupRestoreV3CandidateCharacterReceipt>> {
  const persisted = await input.candidateFs.readDurableJson(
    FINISH_MARKER,
    { maximumBytes: FINISH_MAXIMUM_BYTES },
    input.control,
    lock,
  );
  if (
    persisted === null ||
    candidateFsCanonicalJson(persisted) !== candidateFsCanonicalJson(expected)
  ) {
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_FINISH_CONFLICT",
      "Candidate character finish marker differs from its exact replay",
    );
  }
  const proved = await input.candidateFs.proveFileTree(
    CHARACTER_DIRECTORY,
    [expected.file],
    { maximumBytes: AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_MAXIMUM_BYTES },
    input.control,
    lock,
  );
  if (
    candidateFsCanonicalJson(proved) !== candidateFsCanonicalJson(expected.tree)
  ) {
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_FILE_CONFLICT",
      "Candidate character bytes or inode changed after durable finish",
    );
  }
  return expected;
}

async function materializeCopiedCharacter(
  input: Readonly<MaterializeAgentBackupRestoreV3CandidateCharacterInput>,
  component: Readonly<AgentBackupRestoreV3ComponentReceipt>,
  maximumBytes: number,
): Promise<Readonly<AgentBackupRestoreV3CandidateCharacterReceipt>> {
  if (
    component.payloadBytes <= 0 ||
    component.payloadBytes > maximumBytes ||
    component.dataFrameCount <= 0
  ) {
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_LIMIT",
      "Candidate character must have one bounded non-empty authenticated payload",
    );
  }
  const bytes = new INTRINSIC_UINT8_ARRAY(component.payloadBytes);
  const hash = createHash("sha256");
  let position = 0;
  let lastRecordReceiptSha256 = "";
  let lock: AgentBackupRestoreV3CandidateFsLock | null = null;
  let primaryFailure: unknown;
  let result: Readonly<AgentBackupRestoreV3CandidateCharacterReceipt> | null =
    null;
  try {
    lock = await input.candidateFs.acquireLock(
      ".restore-v3-materialize-c0.lock",
      input.control,
    );
    await bindAgentBackupRestoreV3CandidateRecordSession({
      candidateFs: input.candidateFs,
      session: input.session,
      control: input.control,
      heldLock: lock,
    });
    for (
      let dataIndex = 0;
      dataIndex < component.dataFrameCount;
      dataIndex += 1
    ) {
      const inbox = await readAgentBackupRestoreV3CandidateRecord({
        candidateFs: input.candidateFs,
        session: input.session,
        componentIndex: 0,
        dataIndex,
        control: input.control,
        heldLock: lock,
      });
      try {
        const record = inbox.receipt.record;
        if (
          record.componentIndex !== 0 ||
          record.componentName !== "character" ||
          record.dataIndex !== dataIndex ||
          record.offsetBytes !== position ||
          record.entry !== null ||
          record.payloadBytes !== inbox.payload.byteLength ||
          inbox.payload.byteLength === 0 ||
          inbox.payload.byteLength > bytes.byteLength - position
        ) {
          characterError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_RECORD_INVALID",
            "Candidate character record is not exact, opaque, and contiguous",
          );
        }
        copyPlaintext(bytes, inbox.payload, position);
        hash.update(inbox.payload);
        position += inbox.payload.byteLength;
        lastRecordReceiptSha256 = inbox.receipt.receiptSha256;
      } finally {
        zeroizePlaintext(inbox.payload);
      }
    }
    await requireNoAdditionalRecord(input, component, lock);
    if (
      position !== component.payloadBytes ||
      hash.digest("hex") !== component.payloadSha256
    ) {
      characterError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_COMPONENT_CONFLICT",
        "Candidate character inbox differs from its authenticated finish",
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
      characterError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_UTF8_INVALID",
        "Candidate character is not exact UTF-8 JSON",
        cause,
      );
    }
    const validation = parseAndValidateCharacter(text);
    if (!validation.success || !validation.data) {
      characterError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_INVALID",
        "Candidate character JSON failed runtime schema validation without fallback",
        validation.error,
      );
    }
    invokeTestOnlyHook(
      input.testOnlyLifecycle?.afterInboxValidated,
      undefined,
      "afterInboxValidated",
    );
    await input.candidateFs.ensureFileTreeDirectory(
      CHARACTER_DIRECTORY,
      input.control,
      lock,
    );
    const writer = await input.candidateFs.createFileTreeFile(
      CHARACTER_DIRECTORY,
      {
        path: CHARACTER_PATH,
        sizeBytes: bytes.byteLength,
        mode: 0o600,
        mtimeMs: 0,
      },
      { maximumBytes },
      input.control,
      lock,
    );
    try {
      if (!writer.replayed) {
        for (let offset = 0; offset < bytes.byteLength; offset += 256 * 1024) {
          await writer.write(
            plaintextSubarray(
              bytes,
              offset,
              Math.min(bytes.byteLength, offset + 256 * 1024),
            ),
            input.control,
          );
        }
      }
      const file = await writer.finalize(input.control);
      if (file.sha256 !== component.payloadSha256) {
        characterError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_FILE_CONFLICT",
          "Candidate character file differs from its exact original JSON bytes",
        );
      }
      invokeTestOnlyHook(
        input.testOnlyLifecycle?.afterFilePublished,
        file,
        "afterFilePublished",
      );
      const tree = await input.candidateFs.proveFileTree(
        CHARACTER_DIRECTORY,
        [file],
        { maximumBytes },
        input.control,
        lock,
      );
      const finish = buildFinish(
        computeAgentBackupRestoreV3CandidateSessionSha256(input.session),
        component,
        file,
        tree,
        lastRecordReceiptSha256,
      );
      await input.candidateFs.publishDurableJson(
        FINISH_MARKER,
        finish,
        { maximumBytes: FINISH_MAXIMUM_BYTES },
        input.control,
        lock,
      );
      result = await validatePersistedFinish(input, finish, lock);
      invokeTestOnlyHook(
        input.testOnlyLifecycle?.afterDurableFinish,
        result,
        "afterDurableFinish",
      );
      result = await validatePersistedFinish(input, finish, lock);
    } finally {
      await writer.close();
    }
  } catch (cause) {
    primaryFailure = cause;
  }
  let cleanupFailure: unknown;
  if (lock) {
    try {
      await lock.release(input.control);
    } catch (cause) {
      cleanupFailure = cause;
    }
  }
  zeroizePlaintext(bytes);
  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_CLEANUP_FAILED",
      "Candidate character materialization and bounded cleanup both failed",
      new AggregateError([primaryFailure, cleanupFailure]),
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (!result) {
    characterError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_FINISH_INVALID",
      "Candidate character materialization ended without an exact finish receipt",
    );
  }
  return result;
}

/** Validates and preserves the exact original JSON bytes below the candidate. */
export function materializeAgentBackupRestoreV3CandidateCharacter(
  input: Readonly<MaterializeAgentBackupRestoreV3CandidateCharacterInput>,
): Promise<Readonly<AgentBackupRestoreV3CandidateCharacterReceipt>> {
  const exactInput = snapshotPlainDataRecord(
    input,
    [
      "candidateFs",
      "session",
      "receipt",
      "control",
      "maximumBytes",
      "testOnlyLifecycle",
    ],
    ["candidateFs", "session", "receipt", "control"],
    "Candidate character materialization input",
  );
  const testOnlyLifecycle = snapshotTestOnlyLifecycle(
    exactInput.testOnlyLifecycle,
  );
  const candidateFs = requireCandidateFs(exactInput.candidateFs);
  const control = snapshotCharacterControl(exactInput.control);
  const session = snapshotAgentBackupRestoreV3CandidateSession(
    exactInput.session as Readonly<AgentBackupRestoreV3StagingSession>,
  );
  const receipt = snapshotReceipt(
    exactInput.receipt as Readonly<AgentBackupRestoreV3ComponentReceipt>,
  );
  const maximumBytes = resolveMaximumBytes(
    exactInput.maximumBytes as number | undefined,
  );
  return materializeCopiedCharacter(
    Object.freeze({
      candidateFs,
      session,
      receipt,
      control,
      maximumBytes,
      testOnlyLifecycle,
    }),
    receipt,
    maximumBytes,
  );
}
