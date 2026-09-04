/**
 * Exact, immutable restore-v3 record inbox below one candidate filesystem.
 *
 * This layer owns only durable record slots. It does not interpret character,
 * database, or file-set payloads and has no path to live runtime state.
 */

import {
  createHash,
  createHmac,
  Hash,
  Hmac,
  timingSafeEqual,
} from "node:crypto";
import { isProxy, isUint8Array } from "node:util/types";
import { ElizaError } from "@elizaos/core";
import {
  AGENT_BACKUP_CAPTURE_V2_LIMITS,
  AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS,
  type AgentBackupRestoreV3OperationControl,
  type AgentBackupRestoreV3StagedRecord,
  type AgentBackupRestoreV3StageRecordReceipt,
  type AgentBackupRestoreV3StagingSession,
  type AgentBackupRestoreV3StreamComponentName,
} from "@elizaos/shared";
import {
  type AgentBackupRestoreV3CandidateFs,
  type AgentBackupRestoreV3CandidateFsLock,
  type AgentBackupRestoreV3CandidatePayloadReceipt,
  type AgentBackupRestoreV3CandidatePayloadWriter,
  isAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import {
  candidateFsNativeIoView,
  snapshotOwnDataRecord,
} from "./agent-backup-restore-v3-candidate-fs-control";
import { candidateFsCanonicalJson } from "./agent-backup-restore-v3-candidate-fs-json";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
const UINT64_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const BOUNDED_OPAQUE_TEXT_MAXIMUM_CODE_UNITS = 2_048;
const BOUNDED_OPAQUE_TEXT_MAXIMUM_BYTES = 2_048;
const RECORD_COMPONENT_MAXIMUM_INDEX =
  AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.length - 1;
const RECORD_DATA_MAXIMUM_INDEX =
  AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDataFrames - 1;
const RECORD_OFFSET_MAXIMUM_BYTES =
  AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPlainBytes;
const RECORD_PAYLOAD_MAXIMUM_BYTES =
  AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes;
const RECORD_ENTRY_PATH_MAXIMUM_BYTES =
  AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPathBytes;
const RECORD_RECEIPT_MAXIMUM_BYTES = 32 * 1024;
const SESSION_JOURNAL_MAXIMUM_BYTES = 8 * 1024;
const RECORD_LOCK_NAME = "restore-v3-record-inbox.lock";
const SESSION_JOURNAL_NAME = ".restore-v3-record-inbox.session.json";
const INTRINSIC_CREATE_HASH = createHash;
const INTRINSIC_CREATE_HMAC = createHmac;
const INTRINSIC_TIMING_SAFE_EQUAL = timingSafeEqual;
const INTRINSIC_IS_PROXY = isProxy;
const INTRINSIC_IS_UINT8_ARRAY = isUint8Array;
const INTRINSIC_REFLECT_APPLY = Reflect.apply;
const INTRINSIC_OBJECT_FREEZE = Object.freeze;
const INTRINSIC_OBJECT_IS = Object.is;
const INTRINSIC_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR =
  Object.getOwnPropertyDescriptor;
const INTRINSIC_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const INTRINSIC_BIGINT = BigInt;
const MAXIMUM_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const INTRINSIC_REGEXP_EXEC = RegExp.prototype.exec;
const INTRINSIC_STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const TYPED_ARRAY_PROTOTYPE = INTRINSIC_OBJECT_GET_PROTOTYPE_OF(
  Uint8Array.prototype,
) as object;
const TYPED_ARRAY_BYTE_LENGTH_GETTER =
  INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
    TYPED_ARRAY_PROTOTYPE,
    "byteLength",
  )?.get;
const TYPED_ARRAY_BUFFER_GETTER = INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "buffer",
)?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER =
  INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
    TYPED_ARRAY_PROTOTYPE,
    "byteOffset",
  )?.get;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER =
  INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
    ArrayBuffer.prototype,
    "byteLength",
  )?.get;
const INTRINSIC_UINT8_ARRAY = Uint8Array;
const INTRINSIC_UINT8_ARRAY_SET = Uint8Array.prototype.set;
const INTRINSIC_UINT8_ARRAY_FILL = Uint8Array.prototype.fill;
const INTRINSIC_TEXT_ENCODER = new TextEncoder();
const INTRINSIC_TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const INTRINSIC_TEXT_ENCODER_ENCODE = TextEncoder.prototype.encode;
const INTRINSIC_TEXT_DECODER_DECODE = TextDecoder.prototype.decode;
const INTRINSIC_HASH_UPDATE = Hash.prototype.update;
const INTRINSIC_HASH_DIGEST = Hash.prototype.digest;
const INTRINSIC_HASH_DESTROY = Hash.prototype.destroy;
const INTRINSIC_HMAC_UPDATE = Hmac.prototype.update;
const INTRINSIC_HMAC_DIGEST = Hmac.prototype.digest;
const INTRINSIC_HMAC_DESTROY = Hmac.prototype.destroy;
const HMAC_SEPARATOR = new INTRINSIC_UINT8_ARRAY([0]);
const ABORT_SIGNAL_ABORTED_GETTER =
  INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
    AbortSignal.prototype,
    "aborted",
  )?.get;
const ABORT_SIGNAL_REASON_GETTER = INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  AbortSignal.prototype,
  "reason",
)?.get;

export const AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_FORMAT =
  "elizaos.agent-backup.restore-v3-candidate-record.v1" as const;
export const AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_COMMAND_CONTEXT =
  "elizaos.agent-backup.restore-v3-candidate-record-command.v1" as const;
export const AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_CHAIN_CONTEXT =
  "elizaos.agent-backup.restore-v3-candidate-record-chain.v1" as const;
export const AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_OWNER_CONTEXT =
  "elizaos.agent-backup.restore-v3-candidate-record-owner.v1" as const;
export const AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_MAXIMUM_BYTES =
  256 * 1024;

interface CandidateRecordSessionJournal {
  readonly version: 1;
  readonly format: "elizaos.agent-backup.restore-v3-candidate-record-session.v1";
  readonly restoreAttemptId: string;
  readonly operationId: string;
  readonly expectedManifestSha256: string;
  readonly stagingHandleSha256: string;
  readonly cleanupHandleSha256: string;
  readonly executionTokenSha256: string;
  readonly cleanupRegistered: true;
  readonly isolatedCandidate: true;
  readonly sessionSha256: string;
}

export interface AgentBackupRestoreV3CandidateRecordReceipt {
  readonly version: 1;
  readonly format: typeof AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_FORMAT;
  readonly sessionSha256: string;
  readonly commandSha256: string;
  readonly ownerTokenSha256: string;
  readonly payloadName: string;
  readonly previousReceiptSha256: string;
  readonly record: Readonly<AgentBackupRestoreV3StageRecordReceipt>;
  readonly payload: Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>;
  readonly receiptSha256: string;
}

export interface AgentBackupRestoreV3CandidateRecordRead {
  readonly receipt: Readonly<AgentBackupRestoreV3CandidateRecordReceipt>;
  /** Caller-owned plaintext copy; the caller must zeroize it after use. */
  readonly payload: Uint8Array;
}

/** Test-only crash/response-loss seams. Production callers omit this object. */
export interface AgentBackupRestoreV3CandidateRecordLifecycle {
  readonly afterPayloadFinalized?: (
    receipt: Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>,
  ) => void;
  readonly afterDurableReceipt?: (
    receipt: Readonly<AgentBackupRestoreV3CandidateRecordReceipt>,
  ) => void;
}

export interface StageAgentBackupRestoreV3CandidateRecordInput {
  readonly candidateFs: AgentBackupRestoreV3CandidateFs;
  readonly session: Readonly<AgentBackupRestoreV3StagingSession>;
  readonly record: Readonly<AgentBackupRestoreV3StagedRecord>;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
  readonly testOnlyLifecycle?: Readonly<AgentBackupRestoreV3CandidateRecordLifecycle>;
}

export interface ReadAgentBackupRestoreV3CandidateRecordInput {
  readonly candidateFs: AgentBackupRestoreV3CandidateFs;
  readonly session: Readonly<AgentBackupRestoreV3StagingSession>;
  readonly componentIndex: number;
  readonly dataIndex: number;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
  /** Exact caller-held attempt lock for bounded component materialization. */
  readonly heldLock?: AgentBackupRestoreV3CandidateFsLock;
}

export interface BindAgentBackupRestoreV3CandidateRecordSessionInput {
  readonly candidateFs: AgentBackupRestoreV3CandidateFs;
  readonly session: Readonly<AgentBackupRestoreV3StagingSession>;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
  readonly heldLock?: AgentBackupRestoreV3CandidateFsLock;
}

export class AgentBackupRestoreV3CandidateRecordError extends ElizaError {
  override readonly name = "AgentBackupRestoreV3CandidateRecordError";

  constructor(
    code: string,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, {
      code,
      severity: "fatal",
      ...(options?.cause === undefined ? {} : { cause: options.cause }),
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function recordError(code: string, message: string, cause?: unknown): never {
  throw new AgentBackupRestoreV3CandidateRecordError(code, message, {
    cause,
  });
}

function requireCandidateFs(value: unknown): AgentBackupRestoreV3CandidateFs {
  if (
    !value ||
    typeof value !== "object" ||
    INTRINSIC_IS_PROXY(value) ||
    !isAgentBackupRestoreV3CandidateFs(value)
  ) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      "Candidate record filesystem authority must be one non-proxy capability",
    );
  }
  return value as AgentBackupRestoreV3CandidateFs;
}

function snapshotHeldLock(
  value: unknown,
): AgentBackupRestoreV3CandidateFsLock | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || isProxy(value)) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      "Candidate record held lock must be one non-proxy capability",
    );
  }
  return value as AgentBackupRestoreV3CandidateFsLock;
}

function snapshotTestOnlyLifecycle(
  value: unknown,
): Readonly<AgentBackupRestoreV3CandidateRecordLifecycle> | undefined {
  if (value === undefined) return undefined;
  if (process.env.NODE_ENV !== "test") {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_TEST_HOOK_FORBIDDEN",
      "Candidate record lifecycle hooks are forbidden outside tests",
    );
  }
  const record = snapshotPlainDataRecord(
    value,
    ["afterPayloadFinalized", "afterDurableReceipt"],
    [],
    "Candidate record test lifecycle",
  );
  if (
    (record.afterPayloadFinalized !== undefined &&
      typeof record.afterPayloadFinalized !== "function") ||
    (record.afterDurableReceipt !== undefined &&
      typeof record.afterDurableReceipt !== "function")
  ) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      "Candidate record test lifecycle hooks must be synchronous functions",
    );
  }
  return INTRINSIC_OBJECT_FREEZE({
    ...(record.afterPayloadFinalized === undefined
      ? {}
      : {
          afterPayloadFinalized:
            record.afterPayloadFinalized as AgentBackupRestoreV3CandidateRecordLifecycle["afterPayloadFinalized"],
        }),
    ...(record.afterDurableReceipt === undefined
      ? {}
      : {
          afterDurableReceipt:
            record.afterDurableReceipt as AgentBackupRestoreV3CandidateRecordLifecycle["afterDurableReceipt"],
        }),
  });
}

function invokeTestOnlyLifecycleHook<T>(
  hook: ((value: T) => void) | undefined,
  value: T,
  label: string,
): void {
  if (!hook) return;
  if (process.env.NODE_ENV !== "test") {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_TEST_HOOK_FORBIDDEN",
      "Candidate record lifecycle hooks are forbidden outside tests",
    );
  }
  const returned = (hook as (value: T) => unknown)(value);
  if (returned !== undefined) {
    if (returned instanceof Promise) {
      void returned.catch(() => undefined);
    }
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_TEST_HOOK_ASYNC",
      `${label} test hook must settle synchronously`,
    );
  }
}

function sha256Utf8(value: string): string {
  const encoded = encodeUtf8Owned(value);
  try {
    return sha256Bytes(encoded);
  } finally {
    zeroize(encoded);
  }
}

function sha256Bytes(value: Uint8Array): string {
  const hash = INTRINSIC_CREATE_HASH("sha256");
  try {
    INTRINSIC_REFLECT_APPLY(INTRINSIC_HASH_UPDATE, hash, [
      candidateFsNativeIoView(value),
    ]);
    return INTRINSIC_REFLECT_APPLY(INTRINSIC_HASH_DIGEST, hash, [
      "hex",
    ]) as string;
  } finally {
    INTRINSIC_REFLECT_APPLY(INTRINSIC_HASH_DESTROY, hash, []);
  }
}

function exactDigestMatches(left: string, right: string): boolean {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    !regexpMatches(SHA256_PATTERN, left) ||
    !regexpMatches(SHA256_PATTERN, right)
  ) {
    return false;
  }
  const leftDigest = decodeSha256Hex(left);
  const rightDigest = decodeSha256Hex(right);
  try {
    return INTRINSIC_TIMING_SAFE_EQUAL(
      candidateFsNativeIoView(leftDigest),
      candidateFsNativeIoView(rightDigest),
    );
  } finally {
    zeroize(rightDigest);
    zeroize(leftDigest);
  }
}

function exactByteLength(value: Uint8Array): number {
  if (!TYPED_ARRAY_BYTE_LENGTH_GETTER) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_PAYLOAD_INVALID",
      "Candidate record byte-array contract is unavailable",
    );
  }
  try {
    return INTRINSIC_REFLECT_APPLY(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      value,
      [],
    ) as number;
  } catch (cause) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_PAYLOAD_INVALID",
      "Candidate record byte array lacks exact TypedArray internal slots",
      cause,
    );
  }
}

function exactSubarray(value: Uint8Array, start: number): Uint8Array {
  if (!TYPED_ARRAY_BUFFER_GETTER || !TYPED_ARRAY_BYTE_OFFSET_GETTER) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_PAYLOAD_INVALID",
      "Candidate record byte-array contract is unavailable",
    );
  }
  try {
    const buffer = INTRINSIC_REFLECT_APPLY(
      TYPED_ARRAY_BUFFER_GETTER,
      value,
      [],
    );
    const byteOffset = INTRINSIC_REFLECT_APPLY(
      TYPED_ARRAY_BYTE_OFFSET_GETTER,
      value,
      [],
    ) as number;
    return new INTRINSIC_UINT8_ARRAY(
      buffer as ArrayBuffer,
      byteOffset + start,
      exactByteLength(value) - start,
    );
  } catch (cause) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_PAYLOAD_INVALID",
      "Candidate record byte array could not produce its exact suffix",
      cause,
    );
  }
}

function zeroize(value: Uint8Array | null | undefined): void {
  if (!value) return;
  INTRINSIC_REFLECT_APPLY(INTRINSIC_UINT8_ARRAY_FILL, value, [0]);
}

function regexpMatches(pattern: RegExp, value: string): boolean {
  return (
    INTRINSIC_REFLECT_APPLY(INTRINSIC_REGEXP_EXEC, pattern, [value]) !== null
  );
}

function stringCharCodeAt(value: string, index: number): number {
  return INTRINSIC_REFLECT_APPLY(INTRINSIC_STRING_CHAR_CODE_AT, value, [
    index,
  ]) as number;
}

function encodeUtf8Owned(value: string): Uint8Array {
  let encoded: Uint8Array | null = null;
  try {
    encoded = INTRINSIC_REFLECT_APPLY(
      INTRINSIC_TEXT_ENCODER_ENCODE,
      INTRINSIC_TEXT_ENCODER,
      [value],
    ) as Uint8Array;
    if (
      INTRINSIC_IS_PROXY(encoded) ||
      !INTRINSIC_IS_UINT8_ARRAY(encoded) ||
      INTRINSIC_OBJECT_GET_PROTOTYPE_OF(encoded) !==
        INTRINSIC_UINT8_ARRAY.prototype ||
      !TYPED_ARRAY_BUFFER_GETTER ||
      !ARRAY_BUFFER_BYTE_LENGTH_GETTER
    ) {
      throw new TypeError("UTF-8 encoder returned a non-intrinsic byte array");
    }
    const buffer = INTRINSIC_REFLECT_APPLY(
      TYPED_ARRAY_BUFFER_GETTER,
      encoded,
      [],
    );
    INTRINSIC_REFLECT_APPLY(ARRAY_BUFFER_BYTE_LENGTH_GETTER, buffer, []);
    return encoded;
  } catch (cause) {
    zeroize(encoded);
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      "Candidate record UTF-8 encoder contract is unavailable",
      cause,
    );
  }
}

function decodeSha256Hex(value: string): Uint8Array {
  if (!regexpMatches(SHA256_PATTERN, value)) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      "Candidate record SHA-256 digest is not exact and canonical",
    );
  }
  const decoded = new INTRINSIC_UINT8_ARRAY(32);
  for (let index = 0; index < 32; index += 1) {
    const highCode = stringCharCodeAt(value, index * 2);
    const lowCode = stringCharCodeAt(value, index * 2 + 1);
    const high = highCode <= 57 ? highCode - 48 : highCode - 87;
    const low = lowCode <= 57 ? lowCode - 48 : lowCode - 87;
    decoded[index] = high * 16 + low;
  }
  return decoded;
}

function isBoundedOpaqueText(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > BOUNDED_OPAQUE_TEXT_MAXIMUM_CODE_UNITS
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = stringCharCodeAt(value, index);
    if (codeUnit <= 31 || codeUnit === 127) return false;
  }
  let encoded: Uint8Array | null = null;
  try {
    encoded = encodeUtf8Owned(value);
    return (
      exactByteLength(encoded) <= BOUNDED_OPAQUE_TEXT_MAXIMUM_BYTES &&
      (INTRINSIC_REFLECT_APPLY(
        INTRINSIC_TEXT_DECODER_DECODE,
        INTRINSIC_TEXT_DECODER,
        [candidateFsNativeIoView(encoded)],
      ) as string) === value
    );
  } catch {
    return false;
  } finally {
    zeroize(encoded);
  }
}

function snapshotPlainDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string,
  code = "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
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
    if (cause instanceof AgentBackupRestoreV3CandidateRecordError) throw cause;
    recordError(code, `${label} must be one exact plain data object`, cause);
  }
}

function requirePlainRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  return snapshotPlainDataRecord(value, keys, keys, label);
}

function snapshotSession(
  input: Readonly<AgentBackupRestoreV3StagingSession>,
): Readonly<AgentBackupRestoreV3StagingSession> {
  const record = requirePlainRecord(
    input,
    [
      "restoreAttemptId",
      "operationId",
      "expectedManifestSha256",
      "stagingHandle",
      "cleanupHandle",
      "executionToken",
      "cleanupRegistered",
      "isolatedCandidate",
    ],
    "Candidate staging session",
  );
  if (
    typeof record.restoreAttemptId !== "string" ||
    !regexpMatches(UUID_PATTERN, record.restoreAttemptId) ||
    typeof record.operationId !== "string" ||
    !regexpMatches(UUID_PATTERN, record.operationId) ||
    typeof record.expectedManifestSha256 !== "string" ||
    !regexpMatches(SHA256_PATTERN, record.expectedManifestSha256) ||
    !isBoundedOpaqueText(record.stagingHandle) ||
    !isBoundedOpaqueText(record.cleanupHandle) ||
    !isBoundedOpaqueText(record.executionToken) ||
    record.cleanupRegistered !== true ||
    record.isolatedCandidate !== true
  ) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_SESSION_INVALID",
      "Candidate record session is not exact and canonical",
    );
  }
  return INTRINSIC_OBJECT_FREEZE({
    restoreAttemptId: record.restoreAttemptId,
    operationId: record.operationId,
    expectedManifestSha256: record.expectedManifestSha256,
    stagingHandle: record.stagingHandle,
    cleanupHandle: record.cleanupHandle,
    executionToken: record.executionToken,
    cleanupRegistered: true,
    isolatedCandidate: true,
  });
}

function isSafeNonNegativeInteger(
  value: unknown,
  maximum = MAXIMUM_SAFE_INTEGER,
): value is number {
  return (
    typeof value === "number" &&
    INTRINSIC_NUMBER_IS_SAFE_INTEGER(value) &&
    value >= 0 &&
    !INTRINSIC_OBJECT_IS(value, -0) &&
    value <= maximum
  );
}

function isDotPathSegment(value: string, start: number, end: number): boolean {
  const length = end - start;
  return (
    (length === 1 && stringCharCodeAt(value, start) === 46) ||
    (length === 2 &&
      stringCharCodeAt(value, start) === 46 &&
      stringCharCodeAt(value, start + 1) === 46)
  );
}

function isExactRelativeFilePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > RECORD_ENTRY_PATH_MAXIMUM_BYTES
  ) {
    return false;
  }
  let segmentStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = stringCharCodeAt(value, index);
    if (codeUnit === 0 || codeUnit === 92) return false;
    if (codeUnit !== 47) continue;
    if (
      index === segmentStart ||
      isDotPathSegment(value, segmentStart, index)
    ) {
      return false;
    }
    segmentStart = index + 1;
  }
  if (
    segmentStart === value.length ||
    isDotPathSegment(value, segmentStart, value.length)
  ) {
    return false;
  }
  let encoded: Uint8Array | null = null;
  try {
    encoded = encodeUtf8Owned(value);
    return (
      exactByteLength(encoded) <= RECORD_ENTRY_PATH_MAXIMUM_BYTES &&
      (INTRINSIC_REFLECT_APPLY(
        INTRINSIC_TEXT_DECODER_DECODE,
        INTRINSIC_TEXT_DECODER,
        [candidateFsNativeIoView(encoded)],
      ) as string) === value
    );
  } catch {
    return false;
  } finally {
    zeroize(encoded);
  }
}

function snapshotEntry(
  value: unknown,
  code = "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
  label = "Candidate record entry",
): AgentBackupRestoreV3StagedRecord["entry"] {
  if (value === null) return null;
  const record = snapshotPlainDataRecord(
    value,
    ["path", "fileOffsetBytes", "fileSizeBytes", "mode", "mtimeMs"],
    ["path", "fileOffsetBytes", "fileSizeBytes", "mode", "mtimeMs"],
    label,
    code,
  );
  if (
    !isExactRelativeFilePath(record.path) ||
    !isSafeNonNegativeInteger(record.fileOffsetBytes) ||
    !isSafeNonNegativeInteger(record.fileSizeBytes) ||
    !isSafeNonNegativeInteger(record.mode, 0o777) ||
    !isSafeNonNegativeInteger(record.mtimeMs)
  ) {
    recordError(code, `${label} is not exact and canonical`);
  }
  return INTRINSIC_OBJECT_FREEZE({
    path: record.path,
    fileOffsetBytes: record.fileOffsetBytes,
    fileSizeBytes: record.fileSizeBytes,
    mode: record.mode,
    mtimeMs: record.mtimeMs,
  });
}

function snapshotExactStageReceipt(
  value: unknown,
  code: string,
  label: string,
): Readonly<AgentBackupRestoreV3StageRecordReceipt> {
  const record = snapshotPlainDataRecord(
    value,
    [
      "componentIndex",
      "componentName",
      "dataIndex",
      "offsetBytes",
      "entry",
      "payloadBytes",
      "payloadSha256",
    ],
    [
      "componentIndex",
      "componentName",
      "dataIndex",
      "offsetBytes",
      "entry",
      "payloadBytes",
      "payloadSha256",
    ],
    label,
    code,
  );
  if (
    !isSafeNonNegativeInteger(
      record.componentIndex,
      RECORD_COMPONENT_MAXIMUM_INDEX,
    ) ||
    AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS[record.componentIndex] !==
      record.componentName ||
    !isSafeNonNegativeInteger(record.dataIndex, RECORD_DATA_MAXIMUM_INDEX) ||
    !isSafeNonNegativeInteger(
      record.offsetBytes,
      RECORD_OFFSET_MAXIMUM_BYTES,
    ) ||
    !isSafeNonNegativeInteger(
      record.payloadBytes,
      RECORD_PAYLOAD_MAXIMUM_BYTES,
    ) ||
    typeof record.payloadSha256 !== "string" ||
    !regexpMatches(SHA256_PATTERN, record.payloadSha256)
  ) {
    recordError(code, `${label} is not exact and canonical`);
  }
  const entry = snapshotEntry(record.entry, code, `${label} entry`);
  return INTRINSIC_OBJECT_FREEZE({
    componentIndex: record.componentIndex,
    componentName:
      record.componentName as AgentBackupRestoreV3StreamComponentName,
    dataIndex: record.dataIndex,
    offsetBytes: record.offsetBytes,
    entry,
    payloadBytes: record.payloadBytes,
    payloadSha256: record.payloadSha256,
  });
}

interface CopiedRecord {
  readonly receipt: Readonly<AgentBackupRestoreV3StageRecordReceipt>;
  readonly payload: Uint8Array;
}

function assertSnapshotControl(
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): void {
  if (
    !ABORT_SIGNAL_ABORTED_GETTER ||
    !ABORT_SIGNAL_REASON_GETTER ||
    INTRINSIC_IS_PROXY(control.signal)
  ) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_CONTROL_INVALID",
      "Candidate record snapshot requires one exact AbortSignal",
    );
  }
  let aborted: boolean;
  try {
    aborted = Boolean(
      INTRINSIC_REFLECT_APPLY(ABORT_SIGNAL_ABORTED_GETTER, control.signal, []),
    );
  } catch (cause) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_CONTROL_INVALID",
      "Candidate record snapshot requires one exact AbortSignal",
      cause,
    );
  }
  if (aborted) {
    let reason: unknown;
    try {
      reason = INTRINSIC_REFLECT_APPLY(
        ABORT_SIGNAL_REASON_GETTER,
        control.signal,
        [],
      );
    } catch (cause) {
      recordError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_CONTROL_INVALID",
        "Candidate record snapshot requires one exact AbortSignal",
        cause,
      );
    }
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_ABORTED",
      "Candidate record snapshot was cancelled",
      reason,
    );
  }
  if (
    !INTRINSIC_NUMBER_IS_SAFE_INTEGER(control.deadlineEpochMs) ||
    control.deadlineEpochMs <= Date.now()
  ) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_DEADLINE_EXCEEDED",
      "Candidate record snapshot exceeded its exact deadline",
    );
  }
}

function snapshotRecordControl(
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Readonly<AgentBackupRestoreV3OperationControl> {
  const record = snapshotPlainDataRecord(
    control,
    ["signal", "deadlineEpochMs"],
    ["signal", "deadlineEpochMs"],
    "Candidate record operation control",
    "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_CONTROL_INVALID",
  );
  const snapshot = INTRINSIC_OBJECT_FREEZE({
    signal: record.signal as AbortSignal,
    deadlineEpochMs: record.deadlineEpochMs as number,
  });
  assertSnapshotControl(snapshot);
  return snapshot;
}

function snapshotRecord(
  input: Readonly<AgentBackupRestoreV3StagedRecord>,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): CopiedRecord {
  assertSnapshotControl(control);
  const record = requirePlainRecord(
    input,
    [
      "componentIndex",
      "componentName",
      "dataIndex",
      "offsetBytes",
      "entry",
      "payload",
    ],
    "Candidate staged record",
  );
  const payloadValue = record.payload;
  if (
    !payloadValue ||
    typeof payloadValue !== "object" ||
    INTRINSIC_IS_PROXY(payloadValue) ||
    !INTRINSIC_IS_UINT8_ARRAY(payloadValue) ||
    INTRINSIC_OBJECT_GET_PROTOTYPE_OF(payloadValue) !==
      INTRINSIC_UINT8_ARRAY.prototype ||
    INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
      payloadValue,
      Symbol.iterator,
    ) !== undefined ||
    !TYPED_ARRAY_BYTE_LENGTH_GETTER ||
    !TYPED_ARRAY_BUFFER_GETTER ||
    !ARRAY_BUFFER_BYTE_LENGTH_GETTER
  ) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_PAYLOAD_INVALID",
      "Candidate record payload must be one intrinsic non-proxy Uint8Array",
    );
  }
  let payloadBytes: number;
  let payloadBuffer: unknown;
  try {
    payloadBytes = INTRINSIC_REFLECT_APPLY(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      payloadValue,
      [],
    ) as number;
    payloadBuffer = INTRINSIC_REFLECT_APPLY(
      TYPED_ARRAY_BUFFER_GETTER,
      payloadValue,
      [],
    );
    INTRINSIC_REFLECT_APPLY(ARRAY_BUFFER_BYTE_LENGTH_GETTER, payloadBuffer, []);
  } catch (cause) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_PAYLOAD_INVALID",
      "Candidate record payload lacks exact TypedArray internal slots",
      cause,
    );
  }
  if (payloadBytes > AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_MAXIMUM_BYTES) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_PAYLOAD_INVALID",
      "Candidate record payload exceeds 256 KiB or uses shared storage",
    );
  }
  const payload = new INTRINSIC_UINT8_ARRAY(payloadBytes);
  try {
    INTRINSIC_REFLECT_APPLY(INTRINSIC_UINT8_ARRAY_SET, payload, [
      payloadValue,
      0,
    ]);
    assertSnapshotControl(control);
    const receipt = snapshotExactStageReceipt(
      {
        componentIndex: record.componentIndex,
        componentName: record.componentName,
        dataIndex: record.dataIndex,
        offsetBytes: record.offsetBytes,
        entry: record.entry,
        payloadBytes: exactByteLength(payload),
        payloadSha256: sha256Bytes(payload),
      },
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      "Candidate staged record metadata",
    );
    return INTRINSIC_OBJECT_FREEZE({
      receipt,
      payload,
    });
  } catch (cause) {
    zeroize(payload);
    if (cause instanceof AgentBackupRestoreV3CandidateRecordError) throw cause;
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      "Candidate record metadata is not exact and canonical",
      cause,
    );
  }
}

function freezeStageReceipt(
  receipt: AgentBackupRestoreV3StageRecordReceipt,
): Readonly<AgentBackupRestoreV3StageRecordReceipt> {
  return INTRINSIC_OBJECT_FREEZE({
    ...receipt,
    entry: receipt.entry ? INTRINSIC_OBJECT_FREEZE({ ...receipt.entry }) : null,
  });
}

function buildSessionJournal(
  session: Readonly<AgentBackupRestoreV3StagingSession>,
): Readonly<CandidateRecordSessionJournal> {
  const body = INTRINSIC_OBJECT_FREEZE({
    version: 1 as const,
    format:
      "elizaos.agent-backup.restore-v3-candidate-record-session.v1" as const,
    restoreAttemptId: session.restoreAttemptId,
    operationId: session.operationId,
    expectedManifestSha256: session.expectedManifestSha256,
    stagingHandleSha256: sha256Utf8(session.stagingHandle),
    cleanupHandleSha256: sha256Utf8(session.cleanupHandle),
    executionTokenSha256: sha256Utf8(session.executionToken),
    cleanupRegistered: true as const,
    isolatedCandidate: true as const,
  });
  return INTRINSIC_OBJECT_FREEZE({
    ...body,
    sessionSha256: sha256Utf8(candidateFsCanonicalJson(body)),
  });
}

/** Privacy-safe binding shared by downstream candidate materializers. */
export function snapshotAgentBackupRestoreV3CandidateSession(
  sessionInput: Readonly<AgentBackupRestoreV3StagingSession>,
): Readonly<AgentBackupRestoreV3StagingSession> {
  return snapshotSession(sessionInput);
}

/** Privacy-safe binding shared by downstream candidate materializers. */
export function computeAgentBackupRestoreV3CandidateSessionSha256(
  sessionInput: Readonly<AgentBackupRestoreV3StagingSession>,
): string {
  return buildSessionJournal(
    snapshotAgentBackupRestoreV3CandidateSession(sessionInput),
  ).sessionSha256;
}

function validateSessionJournal(
  value: unknown,
  expected: Readonly<CandidateRecordSessionJournal>,
): Readonly<CandidateRecordSessionJournal> {
  const record = requirePlainRecord(
    value,
    [
      "version",
      "format",
      "restoreAttemptId",
      "operationId",
      "expectedManifestSha256",
      "stagingHandleSha256",
      "cleanupHandleSha256",
      "executionTokenSha256",
      "cleanupRegistered",
      "isolatedCandidate",
      "sessionSha256",
    ],
    "Candidate record session journal",
  );
  if (candidateFsCanonicalJson(record) !== candidateFsCanonicalJson(expected)) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_SESSION_CONFLICT",
      "Candidate record session differs from its durable attempt binding",
    );
  }
  return expected;
}

function recordPayloadName(componentIndex: number, dataIndex: number): string {
  return `.restore-v3-record-c${componentIndex}-d${dataIndex}.payload`;
}

function recordReceiptName(componentIndex: number, dataIndex: number): string {
  return `.restore-v3-record-c${componentIndex}-d${dataIndex}.receipt.json`;
}

function commandBody(
  sessionSha256: string,
  receipt: Readonly<AgentBackupRestoreV3StageRecordReceipt>,
  previousReceiptSha256: string,
): Readonly<Record<string, unknown>> {
  return INTRINSIC_OBJECT_FREEZE({
    context: AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_COMMAND_CONTEXT,
    sessionSha256,
    previousReceiptSha256,
    record: receipt,
  });
}

function snapshotStageReceipt(
  value: Readonly<AgentBackupRestoreV3StageRecordReceipt>,
): Readonly<AgentBackupRestoreV3StageRecordReceipt> {
  return snapshotExactStageReceipt(
    value,
    "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
    "Candidate command receipt",
  );
}

export function computeAgentBackupRestoreV3CandidateRecordCommandSha256(
  sessionInput: Readonly<AgentBackupRestoreV3StagingSession>,
  receiptInput: Readonly<AgentBackupRestoreV3StageRecordReceipt>,
  previousReceiptSha256: string,
): string {
  const session = snapshotSession(sessionInput);
  const receipt = snapshotStageReceipt(receiptInput);
  if (
    AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS[receipt.componentIndex] !==
      receipt.componentName ||
    typeof previousReceiptSha256 !== "string" ||
    !regexpMatches(SHA256_PATTERN, previousReceiptSha256)
  ) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      "Candidate command component or previous receipt is not exact",
    );
  }
  return sha256Utf8(
    candidateFsCanonicalJson(
      commandBody(
        buildSessionJournal(session).sessionSha256,
        receipt,
        previousReceiptSha256,
      ),
    ),
  );
}

interface DerivedOwnerCapability {
  readonly capability: Uint8Array;
  readonly sha256: string;
}

function deriveOwnerCapability(
  executionToken: string,
  commandSha256: string,
): DerivedOwnerCapability {
  let key: Uint8Array | null = null;
  let commandDigest: Uint8Array | null = null;
  let context: Uint8Array | null = null;
  let hmac: Hmac | null = null;
  let digest: Uint8Array | null = null;
  try {
    key = encodeUtf8Owned(executionToken);
    commandDigest = decodeSha256Hex(commandSha256);
    context = encodeUtf8Owned(
      AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_OWNER_CONTEXT,
    );
    hmac = INTRINSIC_CREATE_HMAC("sha256", candidateFsNativeIoView(key));
    INTRINSIC_REFLECT_APPLY(INTRINSIC_HMAC_UPDATE, hmac, [
      candidateFsNativeIoView(context),
    ]);
    INTRINSIC_REFLECT_APPLY(INTRINSIC_HMAC_UPDATE, hmac, [
      candidateFsNativeIoView(HMAC_SEPARATOR),
    ]);
    INTRINSIC_REFLECT_APPLY(INTRINSIC_HMAC_UPDATE, hmac, [
      candidateFsNativeIoView(commandDigest),
    ]);
    digest = INTRINSIC_REFLECT_APPLY(
      INTRINSIC_HMAC_DIGEST,
      hmac,
      [],
    ) as Uint8Array;
    const capability = new INTRINSIC_UINT8_ARRAY(exactByteLength(digest));
    INTRINSIC_REFLECT_APPLY(INTRINSIC_UINT8_ARRAY_SET, capability, [digest, 0]);
    return INTRINSIC_OBJECT_FREEZE({
      capability,
      sha256: sha256Bytes(capability),
    });
  } finally {
    zeroize(digest);
    zeroize(context);
    zeroize(commandDigest);
    zeroize(key);
    if (hmac) {
      INTRINSIC_REFLECT_APPLY(INTRINSIC_HMAC_DESTROY, hmac, []);
    }
  }
}

function chainGenesis(
  sessionSha256: string,
  componentIndex: number,
  componentName: AgentBackupRestoreV3StreamComponentName,
): string {
  return sha256Utf8(
    candidateFsCanonicalJson({
      context: AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_CHAIN_CONTEXT,
      kind: "component-genesis",
      sessionSha256,
      componentIndex,
      componentName,
    }),
  );
}

function receiptBody(
  receipt: Omit<AgentBackupRestoreV3CandidateRecordReceipt, "receiptSha256">,
): Omit<AgentBackupRestoreV3CandidateRecordReceipt, "receiptSha256"> {
  return INTRINSIC_OBJECT_FREEZE({
    version: 1,
    format: AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_FORMAT,
    sessionSha256: receipt.sessionSha256,
    commandSha256: receipt.commandSha256,
    ownerTokenSha256: receipt.ownerTokenSha256,
    payloadName: receipt.payloadName,
    previousReceiptSha256: receipt.previousReceiptSha256,
    record: receipt.record,
    payload: receipt.payload,
  });
}

function freezeRecordReceipt(
  body: Omit<AgentBackupRestoreV3CandidateRecordReceipt, "receiptSha256">,
): Readonly<AgentBackupRestoreV3CandidateRecordReceipt> {
  const exactBody = receiptBody(body);
  return INTRINSIC_OBJECT_FREEZE({
    ...exactBody,
    record: freezeStageReceipt({ ...exactBody.record }),
    payload: INTRINSIC_OBJECT_FREEZE({ ...exactBody.payload }),
    receiptSha256: sha256Utf8(candidateFsCanonicalJson(exactBody)),
  });
}

function parsePayloadReceipt(
  value: unknown,
): Readonly<AgentBackupRestoreV3CandidatePayloadReceipt> {
  const record = requirePlainRecord(
    value,
    ["device", "inode", "sizeBytes", "sha256"],
    "Candidate record payload receipt",
  );
  if (
    !isSafeNonNegativeInteger(
      record.sizeBytes,
      AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_MAXIMUM_BYTES,
    ) ||
    typeof record.sha256 !== "string" ||
    !regexpMatches(SHA256_PATTERN, record.sha256) ||
    typeof record.device !== "string" ||
    !regexpMatches(UINT64_PATTERN, record.device) ||
    INTRINSIC_BIGINT(record.device) > MAX_UINT64 ||
    typeof record.inode !== "string" ||
    !regexpMatches(UINT64_PATTERN, record.inode) ||
    INTRINSIC_BIGINT(record.inode) > MAX_UINT64
  ) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_RECEIPT_INVALID",
      "Candidate payload receipt is not exact and bounded",
    );
  }
  return INTRINSIC_OBJECT_FREEZE({
    device: record.device,
    inode: record.inode,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
  }) as Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>;
}

function parseRecordReceipt(
  value: unknown,
  session: Readonly<AgentBackupRestoreV3StagingSession>,
  sessionJournal: Readonly<CandidateRecordSessionJournal>,
): Readonly<AgentBackupRestoreV3CandidateRecordReceipt> {
  const persisted = requirePlainRecord(
    value,
    [
      "version",
      "format",
      "sessionSha256",
      "commandSha256",
      "ownerTokenSha256",
      "payloadName",
      "previousReceiptSha256",
      "record",
      "payload",
      "receiptSha256",
    ],
    "Candidate record receipt",
  );
  const stageReceipt = snapshotExactStageReceipt(
    persisted.record,
    "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_RECEIPT_INVALID",
    "Candidate record receipt metadata",
  );
  const payload = parsePayloadReceipt(persisted.payload);
  if (
    typeof persisted.previousReceiptSha256 !== "string" ||
    !regexpMatches(SHA256_PATTERN, persisted.previousReceiptSha256)
  ) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_RECEIPT_INVALID",
      "Candidate record previous receipt digest is malformed",
    );
  }
  const commandSha256 = sha256Utf8(
    candidateFsCanonicalJson(
      commandBody(
        sessionJournal.sessionSha256,
        stageReceipt,
        persisted.previousReceiptSha256,
      ),
    ),
  );
  const owner = deriveOwnerCapability(session.executionToken, commandSha256);
  try {
    const expectedBody = receiptBody({
      version: 1,
      format: AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_FORMAT,
      sessionSha256: sessionJournal.sessionSha256,
      commandSha256,
      ownerTokenSha256: owner.sha256,
      payloadName: recordPayloadName(
        stageReceipt.componentIndex,
        stageReceipt.dataIndex,
      ),
      previousReceiptSha256: persisted.previousReceiptSha256 as string,
      record: freezeStageReceipt(stageReceipt),
      payload,
    });
    if (
      persisted.version !== 1 ||
      persisted.format !== AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_FORMAT ||
      typeof persisted.receiptSha256 !== "string" ||
      !regexpMatches(SHA256_PATTERN, persisted.receiptSha256) ||
      !exactDigestMatches(
        persisted.sessionSha256 as string,
        sessionJournal.sessionSha256,
      ) ||
      !exactDigestMatches(persisted.commandSha256 as string, commandSha256) ||
      !exactDigestMatches(persisted.ownerTokenSha256 as string, owner.sha256) ||
      persisted.payloadName !== expectedBody.payloadName ||
      payload.sizeBytes !== stageReceipt.payloadBytes ||
      !exactDigestMatches(payload.sha256, stageReceipt.payloadSha256) ||
      !exactDigestMatches(
        persisted.receiptSha256,
        sha256Utf8(candidateFsCanonicalJson(expectedBody)),
      )
    ) {
      recordError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_RECEIPT_CONFLICT",
        "Candidate record receipt differs from its session, command, owner, or payload",
      );
    }
    return INTRINSIC_OBJECT_FREEZE({
      ...expectedBody,
      receiptSha256: persisted.receiptSha256,
    });
  } finally {
    zeroize(owner.capability);
  }
}

async function createOrReplaySessionJournal(
  candidateFs: AgentBackupRestoreV3CandidateFs,
  session: Readonly<AgentBackupRestoreV3StagingSession>,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  lock: AgentBackupRestoreV3CandidateFsLock,
): Promise<Readonly<CandidateRecordSessionJournal>> {
  const expected = buildSessionJournal(session);
  await candidateFs.publishDurableJson(
    SESSION_JOURNAL_NAME,
    expected,
    { maximumBytes: SESSION_JOURNAL_MAXIMUM_BYTES },
    control,
    lock,
  );
  const persisted = await candidateFs.readDurableJson(
    SESSION_JOURNAL_NAME,
    { maximumBytes: SESSION_JOURNAL_MAXIMUM_BYTES },
    control,
    lock,
  );
  if (persisted === null) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_SESSION_CONFLICT",
      "Candidate record session disappeared after durable publication",
    );
  }
  return validateSessionJournal(persisted, expected);
}

async function requireExistingSessionJournal(
  candidateFs: AgentBackupRestoreV3CandidateFs,
  session: Readonly<AgentBackupRestoreV3StagingSession>,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  lock: AgentBackupRestoreV3CandidateFsLock,
): Promise<Readonly<CandidateRecordSessionJournal>> {
  const expected = buildSessionJournal(session);
  const persisted = await candidateFs.readDurableJson(
    SESSION_JOURNAL_NAME,
    { maximumBytes: SESSION_JOURNAL_MAXIMUM_BYTES },
    control,
    lock,
  );
  if (persisted === null) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_SESSION_ABSENT",
      "Candidate record read requires an existing durable session binding",
    );
  }
  return validateSessionJournal(persisted, expected);
}

async function readReceiptSlot(
  candidateFs: AgentBackupRestoreV3CandidateFs,
  session: Readonly<AgentBackupRestoreV3StagingSession>,
  sessionJournal: Readonly<CandidateRecordSessionJournal>,
  componentIndex: number,
  dataIndex: number,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  lock: AgentBackupRestoreV3CandidateFsLock,
): Promise<Readonly<AgentBackupRestoreV3CandidateRecordReceipt> | null> {
  const value = await candidateFs.readDurableJson(
    recordReceiptName(componentIndex, dataIndex),
    { maximumBytes: RECORD_RECEIPT_MAXIMUM_BYTES },
    control,
    lock,
  );
  if (value === null) return null;
  const receipt = parseRecordReceipt(value, session, sessionJournal);
  if (
    receipt.record.componentIndex !== componentIndex ||
    receipt.record.dataIndex !== dataIndex
  ) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_RECEIPT_CONFLICT",
      "Candidate record receipt occupies the wrong deterministic slot",
    );
  }
  return receipt;
}

async function previousChainReceipt(
  candidateFs: AgentBackupRestoreV3CandidateFs,
  session: Readonly<AgentBackupRestoreV3StagingSession>,
  sessionJournal: Readonly<CandidateRecordSessionJournal>,
  record: Readonly<AgentBackupRestoreV3StageRecordReceipt>,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  lock: AgentBackupRestoreV3CandidateFsLock,
): Promise<string> {
  if (record.dataIndex === 0) {
    if (record.offsetBytes !== 0) {
      recordError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_CHAIN_CONFLICT",
        "First candidate record must begin at component offset zero",
      );
    }
    return chainGenesis(
      sessionJournal.sessionSha256,
      record.componentIndex,
      record.componentName,
    );
  }
  const previous = await readReceiptSlot(
    candidateFs,
    session,
    sessionJournal,
    record.componentIndex,
    record.dataIndex - 1,
    control,
    lock,
  );
  if (
    !previous ||
    previous.record.componentName !== record.componentName ||
    previous.record.offsetBytes + previous.record.payloadBytes !==
      record.offsetBytes
  ) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_CHAIN_CONFLICT",
      "Candidate record does not extend its exact contiguous predecessor",
    );
  }
  return previous.receiptSha256;
}

async function validateReceiptChain(
  candidateFs: AgentBackupRestoreV3CandidateFs,
  session: Readonly<AgentBackupRestoreV3StagingSession>,
  sessionJournal: Readonly<CandidateRecordSessionJournal>,
  receipt: Readonly<AgentBackupRestoreV3CandidateRecordReceipt>,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  lock: AgentBackupRestoreV3CandidateFsLock,
): Promise<void> {
  const expectedPrevious = await previousChainReceipt(
    candidateFs,
    session,
    sessionJournal,
    receipt.record,
    control,
    lock,
  );
  if (!exactDigestMatches(receipt.previousReceiptSha256, expectedPrevious)) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_CHAIN_CONFLICT",
      "Candidate record receipt is not chained to its exact predecessor",
    );
  }
}

async function readPayloadForReceipt(
  candidateFs: AgentBackupRestoreV3CandidateFs,
  session: Readonly<AgentBackupRestoreV3StagingSession>,
  receipt: Readonly<AgentBackupRestoreV3CandidateRecordReceipt>,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  lock: AgentBackupRestoreV3CandidateFsLock,
): Promise<Uint8Array> {
  const owner = deriveOwnerCapability(
    session.executionToken,
    receipt.commandSha256,
  );
  try {
    if (!exactDigestMatches(owner.sha256, receipt.ownerTokenSha256)) {
      recordError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_OWNER_CONFLICT",
        "Candidate record owner differs from its exact execution session",
      );
    }
    const read = await candidateFs.readPayload(
      receipt.payloadName,
      receipt.payload,
      {
        maximumBytes: AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_MAXIMUM_BYTES,
        ownerToken: owner.capability,
      },
      control,
      lock,
    );
    return read.payload;
  } finally {
    zeroize(owner.capability);
  }
}

async function revalidateOwnedPayload(
  candidateFs: AgentBackupRestoreV3CandidateFs,
  payloadName: string,
  payloadReceipt: Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>,
  ownerCapability: Uint8Array,
  expectedPayload: Uint8Array,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  lock: AgentBackupRestoreV3CandidateFsLock,
): Promise<void> {
  await candidateFs.assertAuthority(control);
  await candidateFs.assertLockHeld(lock, control);
  const read = await candidateFs.readPayload(
    payloadName,
    payloadReceipt,
    {
      maximumBytes: AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_MAXIMUM_BYTES,
      ownerToken: ownerCapability,
    },
    control,
    lock,
  );
  try {
    if (
      exactByteLength(read.payload) !== exactByteLength(expectedPayload) ||
      !INTRINSIC_TIMING_SAFE_EQUAL(read.payload, expectedPayload)
    ) {
      recordError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_PAYLOAD_CONFLICT",
        "Candidate record payload changed across its test lifecycle seam",
      );
    }
  } finally {
    zeroize(read.payload);
  }
  await candidateFs.assertAuthority(control);
  await candidateFs.assertLockHeld(lock, control);
}

async function revalidateFinalRecord(
  candidateFs: AgentBackupRestoreV3CandidateFs,
  session: Readonly<AgentBackupRestoreV3StagingSession>,
  sessionJournal: Readonly<CandidateRecordSessionJournal>,
  expectedReceipt: Readonly<AgentBackupRestoreV3CandidateRecordReceipt>,
  expectedPayload: Uint8Array,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  lock: AgentBackupRestoreV3CandidateFsLock,
): Promise<Readonly<AgentBackupRestoreV3CandidateRecordReceipt>> {
  await candidateFs.assertAuthority(control);
  await candidateFs.assertLockHeld(lock, control);
  const persisted = await readReceiptSlot(
    candidateFs,
    session,
    sessionJournal,
    expectedReceipt.record.componentIndex,
    expectedReceipt.record.dataIndex,
    control,
    lock,
  );
  if (
    !persisted ||
    !exactDigestMatches(persisted.receiptSha256, expectedReceipt.receiptSha256)
  ) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_RECEIPT_CONFLICT",
      "Candidate record changed before final acknowledgement",
    );
  }
  await validateReceiptChain(
    candidateFs,
    session,
    sessionJournal,
    persisted,
    control,
    lock,
  );
  const payload = await readPayloadForReceipt(
    candidateFs,
    session,
    persisted,
    control,
    lock,
  );
  try {
    if (
      exactByteLength(payload) !== exactByteLength(expectedPayload) ||
      !INTRINSIC_TIMING_SAFE_EQUAL(payload, expectedPayload)
    ) {
      recordError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_PAYLOAD_CONFLICT",
        "Candidate record payload changed before final acknowledgement",
      );
    }
  } finally {
    zeroize(payload);
  }
  await candidateFs.assertAuthority(control);
  await candidateFs.assertLockHeld(lock, control);
  return persisted;
}

async function stageCopiedRecord(
  input: Omit<
    StageAgentBackupRestoreV3CandidateRecordInput,
    "session" | "record"
  > & {
    readonly session: Readonly<AgentBackupRestoreV3StagingSession>;
    readonly record: Readonly<AgentBackupRestoreV3StageRecordReceipt>;
    readonly payload: Uint8Array;
  },
): Promise<Readonly<AgentBackupRestoreV3CandidateRecordReceipt>> {
  let lock: AgentBackupRestoreV3CandidateFsLock | null = null;
  let writer: AgentBackupRestoreV3CandidatePayloadWriter | null = null;
  let ownerCapability: Uint8Array | null = null;
  let result: Readonly<AgentBackupRestoreV3CandidateRecordReceipt> | null =
    null;
  let primaryFailed = false;
  let primaryFailure: unknown;
  try {
    lock = await input.candidateFs.acquireLock(RECORD_LOCK_NAME, input.control);
    const sessionJournal = await createOrReplaySessionJournal(
      input.candidateFs,
      input.session,
      input.control,
      lock,
    );
    const previousReceiptSha256 = await previousChainReceipt(
      input.candidateFs,
      input.session,
      sessionJournal,
      input.record,
      input.control,
      lock,
    );
    const existing = await readReceiptSlot(
      input.candidateFs,
      input.session,
      sessionJournal,
      input.record.componentIndex,
      input.record.dataIndex,
      input.control,
      lock,
    );
    if (existing) {
      if (
        candidateFsCanonicalJson(existing.record) !==
          candidateFsCanonicalJson(input.record) ||
        !exactDigestMatches(
          existing.previousReceiptSha256,
          previousReceiptSha256,
        )
      ) {
        recordError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_RECEIPT_CONFLICT",
          "Candidate record replay differs from its immutable slot",
        );
      }
      result = await revalidateFinalRecord(
        input.candidateFs,
        input.session,
        sessionJournal,
        existing,
        input.payload,
        input.control,
        lock,
      );
    } else {
      const commandSha256 = sha256Utf8(
        candidateFsCanonicalJson(
          commandBody(
            sessionJournal.sessionSha256,
            input.record,
            previousReceiptSha256,
          ),
        ),
      );
      const owner = deriveOwnerCapability(
        input.session.executionToken,
        commandSha256,
      );
      ownerCapability = owner.capability;
      const payloadName = recordPayloadName(
        input.record.componentIndex,
        input.record.dataIndex,
      );
      writer = await input.candidateFs.createPayload(
        payloadName,
        {
          maximumBytes: AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_MAXIMUM_BYTES,
          ownerToken: owner.capability,
        },
        input.control,
        lock,
      );
      const payloadBytes = exactByteLength(input.payload);
      if (writer.acknowledgedBytes > payloadBytes) {
        recordError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_PAYLOAD_CONFLICT",
          "Candidate record partial payload exceeds the exact command",
        );
      }
      if (writer.acknowledgedBytes < payloadBytes) {
        await writer.write(
          exactSubarray(input.payload, writer.acknowledgedBytes),
          input.control,
        );
      }
      // Once finalize returns, the writer owns settlement and bounded resource
      // cleanup through that promise. Clear our cleanup claim before awaiting
      // so a rejected finalize is not replayed by close() and misclassified as
      // an independent cleanup failure. A synchronous throw deliberately keeps
      // writer non-null so the outer cleanup still closes an unclaimed writer.
      const payloadReceiptPromise = writer.finalize(input.control);
      writer = null;
      const payloadReceipt = await payloadReceiptPromise;
      if (
        payloadReceipt.sizeBytes !== input.record.payloadBytes ||
        !exactDigestMatches(payloadReceipt.sha256, input.record.payloadSha256)
      ) {
        recordError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_PAYLOAD_CONFLICT",
          "Candidate record payload differs from its exact command digest",
        );
      }
      invokeTestOnlyLifecycleHook(
        input.testOnlyLifecycle?.afterPayloadFinalized,
        payloadReceipt,
        "afterPayloadFinalized",
      );
      await revalidateOwnedPayload(
        input.candidateFs,
        payloadName,
        payloadReceipt,
        owner.capability,
        input.payload,
        input.control,
        lock,
      );
      const receipt = freezeRecordReceipt({
        version: 1,
        format: AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_FORMAT,
        sessionSha256: sessionJournal.sessionSha256,
        commandSha256,
        ownerTokenSha256: owner.sha256,
        payloadName,
        previousReceiptSha256,
        record: input.record,
        payload: payloadReceipt,
      });
      await input.candidateFs.publishDurableJson(
        recordReceiptName(input.record.componentIndex, input.record.dataIndex),
        receipt,
        { maximumBytes: RECORD_RECEIPT_MAXIMUM_BYTES },
        input.control,
        lock,
      );
      const persisted = await readReceiptSlot(
        input.candidateFs,
        input.session,
        sessionJournal,
        input.record.componentIndex,
        input.record.dataIndex,
        input.control,
        lock,
      );
      if (
        !persisted ||
        !exactDigestMatches(persisted.receiptSha256, receipt.receiptSha256)
      ) {
        recordError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_RECEIPT_CONFLICT",
          "Candidate record durable receipt could not be replayed exactly",
        );
      }
      invokeTestOnlyLifecycleHook(
        input.testOnlyLifecycle?.afterDurableReceipt,
        persisted,
        "afterDurableReceipt",
      );
      result = await revalidateFinalRecord(
        input.candidateFs,
        input.session,
        sessionJournal,
        persisted,
        input.payload,
        input.control,
        lock,
      );
    }
  } catch (cause) {
    primaryFailed = true;
    primaryFailure = cause;
  }

  let writerCleanupFailed = false;
  let writerCleanupFailure: unknown;
  let lockCleanupFailed = false;
  let lockCleanupFailure: unknown;
  let cleanupFailure: unknown;
  if (writer) {
    try {
      await writer.close();
      writer = null;
    } catch (cause) {
      writerCleanupFailed = true;
      writerCleanupFailure = cause;
    }
  }
  if (lock) {
    try {
      await lock.release(input.control);
      lock = null;
    } catch (cause) {
      lockCleanupFailed = true;
      lockCleanupFailure = cause;
    }
  }
  zeroize(input.payload);
  zeroize(ownerCapability);
  ownerCapability = null;
  const cleanupFailed = writerCleanupFailed || lockCleanupFailed;
  if (writerCleanupFailed && lockCleanupFailed) {
    cleanupFailure = new AggregateError([
      writerCleanupFailure,
      lockCleanupFailure,
    ]);
  } else if (writerCleanupFailed) {
    cleanupFailure = writerCleanupFailure;
  } else if (lockCleanupFailed) {
    cleanupFailure = lockCleanupFailure;
  }
  if (primaryFailed && cleanupFailed) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_CLEANUP_FAILED",
      "Candidate record stage and bounded cleanup both failed",
      new AggregateError([primaryFailure, cleanupFailure]),
    );
  }
  if (primaryFailed) throw primaryFailure;
  if (cleanupFailed) throw cleanupFailure;
  if (!result) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_RECEIPT_INVALID",
      "Candidate record stage ended without an exact receipt",
    );
  }
  return result;
}

/** Copies caller-owned plaintext synchronously, then durably stages one slot. */
export function stageAgentBackupRestoreV3CandidateRecord(
  input: Readonly<StageAgentBackupRestoreV3CandidateRecordInput>,
): Promise<Readonly<AgentBackupRestoreV3CandidateRecordReceipt>> {
  const exactInput = snapshotPlainDataRecord(
    input,
    ["candidateFs", "session", "record", "control", "testOnlyLifecycle"],
    ["candidateFs", "session", "record", "control"],
    "Candidate record stage input",
  );
  const testOnlyLifecycle = snapshotTestOnlyLifecycle(
    exactInput.testOnlyLifecycle,
  );
  const candidateFs = requireCandidateFs(exactInput.candidateFs);
  const control = snapshotRecordControl(
    exactInput.control as Readonly<AgentBackupRestoreV3OperationControl>,
  );
  const session = snapshotSession(
    exactInput.session as Readonly<AgentBackupRestoreV3StagingSession>,
  );
  const copied = snapshotRecord(
    exactInput.record as Readonly<AgentBackupRestoreV3StagedRecord>,
    control,
  );
  return stageCopiedRecord({
    candidateFs,
    session,
    record: copied.receipt,
    payload: copied.payload,
    control,
    testOnlyLifecycle,
  });
}

/** Creates or exactly replays the durable inbox binding, including for 0 records. */
export async function bindAgentBackupRestoreV3CandidateRecordSession(
  input: Readonly<BindAgentBackupRestoreV3CandidateRecordSessionInput>,
): Promise<string> {
  const exactInput = snapshotPlainDataRecord(
    input,
    ["candidateFs", "session", "control", "heldLock"],
    ["candidateFs", "session", "control"],
    "Candidate record session binding input",
  );
  const candidateFs = requireCandidateFs(exactInput.candidateFs);
  const control = snapshotRecordControl(
    exactInput.control as Readonly<AgentBackupRestoreV3OperationControl>,
  );
  const session = snapshotSession(
    exactInput.session as Readonly<AgentBackupRestoreV3StagingSession>,
  );
  const heldLock = snapshotHeldLock(exactInput.heldLock);
  const ownsLock = heldLock === undefined;
  let lock: AgentBackupRestoreV3CandidateFsLock | null = null;
  let result: string | null = null;
  let primaryFailure: unknown;
  try {
    lock =
      heldLock === undefined
        ? await candidateFs.acquireLock(RECORD_LOCK_NAME, control)
        : heldLock;
    await candidateFs.assertLockHeld(lock, control);
    const journal = await createOrReplaySessionJournal(
      candidateFs,
      session,
      control,
      lock,
    );
    result = journal.sessionSha256;
  } catch (cause) {
    primaryFailure = cause;
  }
  let cleanupFailure: unknown;
  if (lock && ownsLock) {
    try {
      await lock.release(control);
    } catch (cause) {
      cleanupFailure = cause;
    }
  }
  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_CLEANUP_FAILED",
      "Candidate record session binding and bounded cleanup both failed",
      new AggregateError([primaryFailure, cleanupFailure]),
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (!result) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_SESSION_INVALID",
      "Candidate record session binding ended without an exact digest",
    );
  }
  return result;
}

/** Reads one immutable record and its already-proved FD-bound payload. */
export async function readAgentBackupRestoreV3CandidateRecord(
  input: Readonly<ReadAgentBackupRestoreV3CandidateRecordInput>,
): Promise<Readonly<AgentBackupRestoreV3CandidateRecordRead>> {
  const exactInput = snapshotPlainDataRecord(
    input,
    [
      "candidateFs",
      "session",
      "componentIndex",
      "dataIndex",
      "control",
      "heldLock",
    ],
    ["candidateFs", "session", "componentIndex", "dataIndex", "control"],
    "Candidate record read input",
  );
  const candidateFs = requireCandidateFs(exactInput.candidateFs);
  const control = snapshotRecordControl(
    exactInput.control as Readonly<AgentBackupRestoreV3OperationControl>,
  );
  const session = snapshotSession(
    exactInput.session as Readonly<AgentBackupRestoreV3StagingSession>,
  );
  const componentIndex = exactInput.componentIndex as number;
  const dataIndex = exactInput.dataIndex as number;
  const heldLock = snapshotHeldLock(exactInput.heldLock);
  if (
    !INTRINSIC_NUMBER_IS_SAFE_INTEGER(componentIndex) ||
    componentIndex < 0 ||
    !AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS[componentIndex] ||
    !INTRINSIC_NUMBER_IS_SAFE_INTEGER(dataIndex) ||
    dataIndex < 0
  ) {
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      "Candidate record slot is not exact and canonical",
    );
  }
  let lock: AgentBackupRestoreV3CandidateFsLock | null = null;
  const ownsLock = heldLock === undefined;
  let payload: Uint8Array | null = null;
  let receipt: Readonly<AgentBackupRestoreV3CandidateRecordReceipt> | null =
    null;
  let primaryFailed = false;
  let primaryFailure: unknown;
  try {
    lock =
      heldLock === undefined
        ? await candidateFs.acquireLock(RECORD_LOCK_NAME, control)
        : heldLock;
    await candidateFs.assertLockHeld(lock, control);
    const sessionJournal = await requireExistingSessionJournal(
      candidateFs,
      session,
      control,
      lock,
    );
    receipt = await readReceiptSlot(
      candidateFs,
      session,
      sessionJournal,
      componentIndex,
      dataIndex,
      control,
      lock,
    );
    if (!receipt) {
      recordError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_ABSENT",
        "Candidate record slot is absent",
      );
    }
    await validateReceiptChain(
      candidateFs,
      session,
      sessionJournal,
      receipt,
      control,
      lock,
    );
    payload = await readPayloadForReceipt(
      candidateFs,
      session,
      receipt,
      control,
      lock,
    );
  } catch (cause) {
    primaryFailed = true;
    primaryFailure = cause;
  }

  let cleanupFailed = false;
  let cleanupFailure: unknown;
  try {
    if (lock && ownsLock) {
      await lock.release(control);
      lock = null;
    }
  } catch (cause) {
    cleanupFailed = true;
    cleanupFailure = cause;
  }
  if (primaryFailed || cleanupFailed || !payload || !receipt) {
    zeroize(payload);
    if (primaryFailed && cleanupFailed) {
      recordError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_CLEANUP_FAILED",
        "Candidate record read and bounded cleanup both failed",
        new AggregateError([primaryFailure, cleanupFailure]),
      );
    }
    if (primaryFailed) throw primaryFailure;
    if (cleanupFailed) throw cleanupFailure;
    recordError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_RECEIPT_INVALID",
      "Candidate record read ended without an exact result",
    );
  }
  return INTRINSIC_OBJECT_FREEZE({ receipt, payload });
}
