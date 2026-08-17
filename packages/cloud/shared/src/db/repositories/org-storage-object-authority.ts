/**
 * Owns the authoritative, generation-fenced state machine for organization R2 objects.
 * Provider I/O stays outside this repository; ambiguous outcomes retain quota until reconciled.
 */

import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { type DbTransaction, dbWrite } from "../client";
import { sqlRows } from "../execute-helpers";
import {
  type OrgStorageObject,
  type OrgStorageObjectPresence,
  orgStorageObjects,
} from "../schemas/org-storage-objects";
import {
  type OrgStorageOperation,
  type OrgStorageOperationKind,
  orgStorageOperations,
} from "../schemas/org-storage-operations";
import { type OrgStorageQuota, orgStorageQuota } from "../schemas/org-storage-quota";

export const ORG_STORAGE_NAMESPACE = "attachment-r2-v1";
export const ORG_STORAGE_AUTHORITY_INVALID_INPUT = "ORG_STORAGE_AUTHORITY_INVALID_INPUT";
export const ORG_STORAGE_AUTHORITY_NOT_FOUND = "ORG_STORAGE_AUTHORITY_NOT_FOUND";
export const ORG_STORAGE_AUTHORITY_STALE_FENCE = "ORG_STORAGE_AUTHORITY_STALE_FENCE";
export const ORG_STORAGE_AUTHORITY_CONFLICT = "ORG_STORAGE_AUTHORITY_CONFLICT";
export const ORG_STORAGE_AUTHORITY_INVARIANT = "ORG_STORAGE_AUTHORITY_INVARIANT";

const MAX_BIGINT = 9_223_372_036_854_775_807n;
const MAX_CLAIM_BATCH = 100;
const MIN_LEASE_MS = 30_000;
const MAX_LEASE_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 2_147_483_647;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PREFIXED_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CLAIM_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,95}$/;

export type ObservedObjectAuthority =
  | { presence: "absent" }
  | {
      presence: "present";
      sizeBytes: bigint;
      providerVersion: string;
      providerEtag: string;
      contentType: string;
      checksumSha256: string | null;
      providerUploadedAt: Date;
    };

export interface OrgStorageObjectReadSnapshot {
  readonly organizationId: string;
  readonly objectId: string;
  readonly objectKey: string;
  readonly committedGeneration: bigint;
  readonly sizeBytes: bigint;
  readonly providerKey: string;
  readonly providerVersion: string;
  readonly providerEtag: string;
  readonly contentType: string;
  readonly checksumSha256: string | null;
  readonly providerUploadedAt: Date;
}

export type ResolveObjectReadByKeyResult =
  | { outcome: "absent" }
  | {
      outcome: "in_progress";
      objectId: string;
      committedGeneration: bigint;
      targetGeneration: bigint;
      activeState: "provider_started" | "quarantined";
    }
  | { outcome: "present"; snapshot: OrgStorageObjectReadSnapshot };

export interface RegisterObservedAuthorityInput {
  organizationId: string;
  objectKey: string;
  observation: ObservedObjectAuthority;
}

export type RegisterObservedAuthorityResult =
  | { outcome: "registered" | "replayed"; authority: OrgStorageObject }
  | { outcome: "conflict"; authority: OrgStorageObject };

export interface ExpectedObjectAuthority {
  presence: OrgStorageObjectPresence;
  committedGeneration: bigint;
  sizeBytes: bigint;
  providerVersion: string | null;
  providerEtag: string | null;
}

interface PrepareOperationBase {
  organizationId: string;
  objectId: string;
  operationId: string;
  idempotencyKey: string;
  requestDigest: string;
  expected: ExpectedObjectAuthority;
}

export type PrepareOperationInput =
  | (PrepareOperationBase & {
      operation: "put";
      targetSizeBytes: bigint;
      targetContentType: string;
      targetContentSha256: string;
    })
  | (PrepareOperationBase & { operation: "delete" });

export type PrepareConflictReason =
  | "idempotency_mismatch"
  | "operation_id_conflict"
  | "source_mismatch"
  | "generation_exhausted";

export type PrepareOperationResult =
  | { outcome: "prepared" | "replayed"; operation: OrgStorageOperation }
  | { outcome: "busy"; operation: OrgStorageOperation }
  | { outcome: "conflict"; reason: PrepareConflictReason }
  | { outcome: "quota_unreconciled"; reason: "missing" | "below_source" }
  | {
      outcome: "quota_exceeded";
      bytesUsed: bigint;
      bytesLimit: bigint;
      requiredBytes: bigint;
    };

export interface ClaimOperationInput {
  organizationId: string;
  operationId: string;
  claimOwner: string;
  claimGeneration: string;
  leaseMs: number;
}

export interface ClaimDueOperationsInput {
  organizationId: string;
  claimOwner: string;
  claimGeneration: string;
  leaseMs: number;
  limit: number;
}

export interface ClaimDueOperationsGloballyInput {
  claimOwner: string;
  claimGeneration: string;
  leaseMs: number;
  limit: number;
}

export interface OrgStorageOperationClaim {
  operation: OrgStorageOperation;
  claimOwner: string;
  claimGeneration: string;
  leaseExpiresAt: Date;
}

export type ClaimOperationResult =
  | { outcome: "claimed"; claim: OrgStorageOperationClaim }
  | {
      outcome: "not_claimed";
      reason: "not_found" | "not_due" | "busy" | "terminal" | "exhausted";
    };

export interface OperationFenceInput {
  organizationId: string;
  operationId: string;
  claimOwner: string;
  claimGeneration: string;
}

export interface MarkProviderStartedInput extends OperationFenceInput {
  nextAttemptAt: Date;
}

export interface CommitPutInput extends OperationFenceInput {
  targetEvidence: PutTargetEvidence;
  receiptDigest: string;
  sourceAbsenceProof: SourceAbsenceProof;
}

export interface PutTargetEvidence {
  kind: "target_provider_object_observed";
  providerKey: string;
  providerVersion: string;
  providerEtag: string;
  sizeBytes: bigint;
  checksumSha256: string;
  providerUploadedAt: Date;
  contentType: string;
  customMetadata: {
    operationId: string;
    targetGeneration: string;
    requestDigest: string;
  };
}

export interface CommitDeleteInput extends OperationFenceInput {
  receiptDigest: string;
  sourceAbsenceProof: SourceAbsenceProof;
}

export type SourceAbsenceProof =
  | { kind: "no_source"; sourceProviderKey: null }
  | {
      kind: "source_provider_key_confirmed_absent";
      sourceProviderKey: string;
    };

export interface AbortOperationInput extends OperationFenceInput {
  responseStatus: number;
  receiptDigest: string;
  errorCode: string;
  errorDigest: string;
}

export interface AmbiguousObservationInput extends OperationFenceInput {
  errorCode: string;
  errorDigest: string;
  nextAttemptAt: Date;
}

export interface QuarantineOperationInput extends OperationFenceInput {
  errorCode: string;
  errorDigest: string;
}

export interface RearmQuarantinedOperationInput {
  organizationId: string;
  operationId: string;
  expectedErrorDigest: string;
  claimOwner: string;
  claimGeneration: string;
  leaseMs: number;
}

export type StateTransitionResult = {
  outcome: "applied" | "replayed";
  operation: OrgStorageOperation;
};

interface NormalizedTarget {
  operation: OrgStorageOperationKind;
  sizeBytes: bigint;
  contentType: string | null;
  checksumSha256: string | null;
}

class PrepareRollback extends Error {
  constructor(
    readonly reason: "quota_exceeded" | "insert_conflict",
    readonly quota?: { bytesUsed: bigint; bytesLimit: bigint; requiredBytes: bigint },
  ) {
    super(reason);
  }
}

function invalidInput(message: string, field: string): never {
  throw new ElizaError(message, {
    code: ORG_STORAGE_AUTHORITY_INVALID_INPUT,
    context: { field },
    severity: "fatal",
  });
}

function notFound(entity: "object" | "operation"): never {
  throw new ElizaError("Storage authority record was not found", {
    code: ORG_STORAGE_AUTHORITY_NOT_FOUND,
    context: { entity },
    severity: "fatal",
  });
}

function staleFence(reason: string): never {
  throw new ElizaError("Storage operation claim is stale or invalid", {
    code: ORG_STORAGE_AUTHORITY_STALE_FENCE,
    context: { reason },
    severity: "ephemeral",
  });
}

function conflict(reason: string): never {
  throw new ElizaError("Storage operation transition conflicts with durable state", {
    code: ORG_STORAGE_AUTHORITY_CONFLICT,
    context: { reason },
    severity: "fatal",
  });
}

function invariant(reason: string): never {
  throw new ElizaError("Storage authority invariant was violated", {
    code: ORG_STORAGE_AUTHORITY_INVARIANT,
    context: { reason },
    severity: "fatal",
  });
}

function requireUuid(value: string, field: string): void {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalidInput(`${field} must be a UUID`, field);
  }
}

function requireDate(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    invalidInput(`${field} must be a valid Date`, field);
  }
}

function requireBigint(value: bigint, field: string): void {
  if (typeof value !== "bigint" || value < 0n || value > MAX_BIGINT) {
    invalidInput(`${field} must be a non-negative signed bigint`, field);
  }
}

function requirePrefixedDigest(value: string, field: string): void {
  if (typeof value !== "string" || !PREFIXED_SHA256_PATTERN.test(value)) {
    invalidInput(`${field} must be a canonical prefixed SHA-256 digest`, field);
  }
}

function requireDigest(value: string, field: string): void {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalidInput(`${field} must be a canonical SHA-256 digest`, field);
  }
}

function requireProviderVersion(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1024 ||
    /[\r\n]/.test(value)
  ) {
    invalidInput(`${field} is not a valid provider version`, field);
  }
}

function requireProviderEtag(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    /["\r\n]/.test(value)
  ) {
    invalidInput(`${field} is not a valid provider ETag`, field);
  }
}

function requireContentType(value: string, field: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 || /[\r\n]/.test(value)) {
    invalidInput(`${field} is not a valid content type`, field);
  }
}

function requirePutTargetCustomMetadata(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    conflict("target_custom_metadata_shape");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 3 ||
    !keys.includes("operationId") ||
    !keys.includes("targetGeneration") ||
    !keys.includes("requestDigest")
  ) {
    conflict("target_custom_metadata_shape");
  }
  const operationId = Reflect.get(value, "operationId");
  const targetGeneration = Reflect.get(value, "targetGeneration");
  const requestDigest = Reflect.get(value, "requestDigest");
  if (
    typeof operationId !== "string" ||
    typeof targetGeneration !== "string" ||
    typeof requestDigest !== "string" ||
    !UUID_PATTERN.test(operationId) ||
    !/^[1-9][0-9]{0,18}$/.test(targetGeneration) ||
    BigInt(targetGeneration) > MAX_BIGINT ||
    !PREFIXED_SHA256_PATTERN.test(requestDigest)
  ) {
    conflict("target_custom_metadata_shape");
  }
}

function requireError(errorCode: string, errorDigest: string): void {
  if (typeof errorCode !== "string" || !ERROR_CODE_PATTERN.test(errorCode)) {
    invalidInput("errorCode must be a canonical error code", "errorCode");
  }
  requireDigest(errorDigest, "errorDigest");
}

function requireClaimOwner(value: string): void {
  if (typeof value !== "string" || !CLAIM_OWNER_PATTERN.test(value)) {
    invalidInput("claimOwner is invalid", "claimOwner");
  }
}

function requireLeaseMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < MIN_LEASE_MS || value > MAX_LEASE_MS) {
    invalidInput(`leaseMs must be between ${MIN_LEASE_MS} and ${MAX_LEASE_MS}`, "leaseMs");
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function requireObjectKey(organizationId: string, objectKey: string): void {
  const prefix = `org/${organizationId}/`;
  if (
    typeof objectKey !== "string" ||
    !objectKey.startsWith(prefix) ||
    objectKey.length <= prefix.length ||
    !isWellFormedUnicode(objectKey) ||
    objectKey !== objectKey.normalize("NFC") ||
    new TextEncoder().encode(objectKey).byteLength > 1024 ||
    objectKey.split("/").includes("..") ||
    /\p{Cc}/u.test(objectKey)
  ) {
    invalidInput("objectKey is outside the organization storage namespace", "objectKey");
  }
}

function requireIdempotencyKey(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    !/^[\x20-\x7e]+$/.test(value)
  ) {
    invalidInput("idempotencyKey is invalid", "idempotencyKey");
  }
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function orgStorageProviderKey(
  organizationId: string,
  objectId: string,
  generation: bigint,
): string {
  requireUuid(organizationId, "organizationId");
  requireUuid(objectId, "objectId");
  requireBigint(generation, "generation");
  if (generation === 0n) invalidInput("generation must be at least one", "generation");
  return `__eliza_storage_authority/v1/org/${organizationId}/${objectId}/${generation.toString(10)}`;
}

function hashIdempotencyKey(organizationId: string, idempotencyKey: string): string {
  return sha256(`org-storage-mutation:v1:${organizationId}:${idempotencyKey}`);
}

function normalizeObservation(observation: ObservedObjectAuthority): ObservedObjectAuthority {
  if (observation.presence === "absent") return observation;
  requireBigint(observation.sizeBytes, "observation.sizeBytes");
  requireProviderVersion(observation.providerVersion, "observation.providerVersion");
  requireProviderEtag(observation.providerEtag, "observation.providerEtag");
  requireContentType(observation.contentType, "observation.contentType");
  if (observation.checksumSha256 !== null) {
    requireDigest(observation.checksumSha256, "observation.checksumSha256");
  }
  requireDate(observation.providerUploadedAt, "observation.providerUploadedAt");
  return observation;
}

function observationMatches(row: OrgStorageObject, observation: ObservedObjectAuthority): boolean {
  if (
    row.storage_namespace !== ORG_STORAGE_NAMESPACE ||
    row.key_fingerprint !== sha256(row.object_key) ||
    row.current_provider_key !== (observation.presence === "present" ? row.object_key : null)
  ) {
    return false;
  }
  if (row.presence !== observation.presence) return false;
  if (observation.presence === "absent") {
    return (
      row.committed_generation === 0n &&
      row.last_allocated_generation === 0n &&
      row.size_bytes === 0n &&
      row.provider_version === null &&
      row.provider_etag === null &&
      row.content_type === null &&
      row.checksum_sha256 === null &&
      row.provider_uploaded_at === null
    );
  }
  return (
    row.committed_generation === 1n &&
    row.last_allocated_generation === 1n &&
    row.size_bytes === observation.sizeBytes &&
    row.provider_version === observation.providerVersion &&
    row.provider_etag === observation.providerEtag &&
    row.content_type === observation.contentType &&
    row.checksum_sha256 === observation.checksumSha256 &&
    row.provider_uploaded_at?.getTime() === observation.providerUploadedAt.getTime()
  );
}

function requireExpectedAuthority(expected: ExpectedObjectAuthority): void {
  requireBigint(expected.committedGeneration, "expected.committedGeneration");
  requireBigint(expected.sizeBytes, "expected.sizeBytes");
  if (expected.presence === "absent") {
    if (
      expected.sizeBytes !== 0n ||
      expected.providerVersion !== null ||
      expected.providerEtag !== null
    ) {
      invalidInput("An absent expected authority must have the absent shape", "expected");
    }
    return;
  }
  if (expected.presence !== "present" || expected.committedGeneration < 1n) {
    invalidInput("expected.presence is invalid", "expected.presence");
  }
  if (expected.providerVersion === null || expected.providerEtag === null) {
    invalidInput("A present expected authority requires provider evidence", "expected");
  }
  requireProviderVersion(expected.providerVersion, "expected.providerVersion");
  requireProviderEtag(expected.providerEtag, "expected.providerEtag");
}

function normalizeTarget(input: PrepareOperationInput): NormalizedTarget {
  if (input.operation === "delete") {
    return { operation: "delete", sizeBytes: 0n, contentType: null, checksumSha256: null };
  }
  requireBigint(input.targetSizeBytes, "targetSizeBytes");
  requireContentType(input.targetContentType, "targetContentType");
  requireDigest(input.targetContentSha256, "targetContentSha256");
  return {
    operation: "put",
    sizeBytes: input.targetSizeBytes,
    contentType: input.targetContentType,
    checksumSha256: input.targetContentSha256,
  };
}

function validatePrepareInput(input: PrepareOperationInput): NormalizedTarget {
  requireUuid(input.organizationId, "organizationId");
  requireUuid(input.objectId, "objectId");
  requireUuid(input.operationId, "operationId");
  requireIdempotencyKey(input.idempotencyKey);
  requirePrefixedDigest(input.requestDigest, "requestDigest");
  requireExpectedAuthority(input.expected);
  return normalizeTarget(input);
}

function sourceMatchesObject(object: OrgStorageObject, expected: ExpectedObjectAuthority): boolean {
  return (
    object.presence === expected.presence &&
    object.committed_generation === expected.committedGeneration &&
    object.size_bytes === expected.sizeBytes &&
    object.provider_version === expected.providerVersion &&
    object.provider_etag === expected.providerEtag
  );
}

function operationMatchesRequest(
  operation: OrgStorageOperation,
  input: PrepareOperationInput,
  idempotencyHash: string,
  target: NormalizedTarget,
): boolean {
  return (
    operation.organization_id === input.organizationId &&
    operation.object_id === input.objectId &&
    operation.operation === target.operation &&
    operation.idempotency_key_hash === idempotencyHash &&
    operation.request_digest === input.requestDigest &&
    operation.target_size_bytes === target.sizeBytes &&
    operation.target_content_type === target.contentType &&
    operation.target_content_sha256 === target.checksumSha256
  );
}

function terminalPutMatches(operation: OrgStorageOperation, input: CommitPutInput): boolean {
  return (
    operation.state === "committed" &&
    operation.operation === "put" &&
    operation.response_status === 201 &&
    operation.receipt_digest === input.receiptDigest &&
    operation.target_provider_key === input.targetEvidence.providerKey &&
    operation.target_content_type === input.targetEvidence.contentType &&
    operation.result_provider_version === input.targetEvidence.providerVersion &&
    operation.result_provider_etag === input.targetEvidence.providerEtag &&
    operation.result_size_bytes === input.targetEvidence.sizeBytes &&
    operation.result_checksum_sha256 === input.targetEvidence.checksumSha256 &&
    operation.result_uploaded_at?.getTime() === input.targetEvidence.providerUploadedAt.getTime() &&
    input.targetEvidence.customMetadata.operationId === operation.id &&
    input.targetEvidence.customMetadata.targetGeneration ===
      operation.target_generation.toString(10) &&
    input.targetEvidence.customMetadata.requestDigest === operation.request_digest
  );
}

function terminalDeleteMatches(operation: OrgStorageOperation, input: CommitDeleteInput): boolean {
  return (
    operation.state === "committed" &&
    operation.operation === "delete" &&
    operation.response_status === 204 &&
    operation.receipt_digest === input.receiptDigest
  );
}

function terminalAbortMatches(operation: OrgStorageOperation, input: AbortOperationInput): boolean {
  return (
    operation.state === "aborted" &&
    !operation.provider_write_started &&
    operation.response_status === input.responseStatus &&
    operation.receipt_digest === input.receiptDigest &&
    operation.last_error_code === input.errorCode &&
    operation.last_error_digest === input.errorDigest
  );
}

function operationSourceMatchesObject(
  operation: OrgStorageOperation,
  object: OrgStorageObject,
): boolean {
  return (
    object.presence === operation.source_presence &&
    object.committed_generation === operation.source_generation &&
    object.size_bytes === operation.source_size_bytes &&
    object.provider_version === operation.source_provider_version &&
    object.provider_etag === operation.source_provider_etag &&
    object.current_provider_key === operation.source_provider_key
  );
}

function requireQuotaRepresentsOperation(
  quota: OrgStorageQuota,
  operation: OrgStorageOperation,
): void {
  if (
    quota.organization_id !== operation.organization_id ||
    quota.bytes_used < 0n ||
    operation.quota_release_bytes < 0n ||
    operation.quota_reserved_bytes < 0n ||
    quota.bytes_used < operation.quota_release_bytes + operation.quota_reserved_bytes
  ) {
    invariant("quota_operation_bytes_unrepresented");
  }
}

function validateSourceAbsenceProof(
  operation: OrgStorageOperation,
  proof: SourceAbsenceProof,
): boolean {
  if (typeof proof !== "object" || proof === null || Array.isArray(proof)) {
    conflict("source_absence_proof_shape");
  }
  const keys = Reflect.ownKeys(proof);
  if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("sourceProviderKey")) {
    conflict("source_absence_proof_shape");
  }
  const kind = Reflect.get(proof, "kind");
  const sourceProviderKey = Reflect.get(proof, "sourceProviderKey");
  if (operation.source_provider_key === null) {
    if (
      operation.source_presence !== "absent" ||
      kind !== "no_source" ||
      sourceProviderKey !== null
    ) {
      conflict("source_absence_proof_mismatch");
    }
    return false;
  }
  if (
    operation.source_presence !== "present" ||
    kind !== "source_provider_key_confirmed_absent" ||
    typeof sourceProviderKey !== "string" ||
    sourceProviderKey !== operation.source_provider_key
  ) {
    conflict("source_absence_proof_mismatch");
  }
  return true;
}

function requireFenceIdentity(operation: OrgStorageOperation, input: OperationFenceInput): void {
  requireFenceInput(input);
  if (
    operation.organization_id !== input.organizationId ||
    operation.id !== input.operationId ||
    operation.claim_owner !== input.claimOwner ||
    operation.claim_generation !== input.claimGeneration
  ) {
    staleFence("claim_identity_mismatch");
  }
}

function requireFenceInput(input: OperationFenceInput): void {
  requireUuid(input.organizationId, "organizationId");
  requireUuid(input.operationId, "operationId");
  requireClaimOwner(input.claimOwner);
  requireUuid(input.claimGeneration, "claimGeneration");
}

function requireFence(
  operation: OrgStorageOperation,
  input: OperationFenceInput,
  databaseNow: Date,
): void {
  requireFenceIdentity(operation, input);
  if (
    operation.lease_expires_at === null ||
    operation.lease_expires_at.getTime() <= databaseNow.getTime()
  ) {
    staleFence("claim_mismatch_or_expired");
  }
}

function requireAttemptCapacity(operation: OrgStorageOperation): void {
  if (operation.attempts >= MAX_ATTEMPTS) invariant("attempt_counter_exhausted");
}

function toClaim(operation: OrgStorageOperation): OrgStorageOperationClaim {
  if (
    operation.claim_owner === null ||
    operation.claim_generation === null ||
    operation.lease_expires_at === null
  ) {
    invariant("claimed_operation_missing_fence");
  }
  return {
    operation,
    claimOwner: operation.claim_owner,
    claimGeneration: operation.claim_generation,
    leaseExpiresAt: operation.lease_expires_at,
  };
}

function claimMatchesRequest(
  operation: OrgStorageOperation,
  claimOwner: string,
  claimGeneration: string,
): boolean {
  return (
    (operation.state === "prepared" || operation.state === "provider_started") &&
    operation.claim_owner === claimOwner &&
    operation.claim_generation === claimGeneration &&
    operation.lease_expires_at !== null
  );
}

async function getDatabaseNow(tx: DbTransaction): Promise<Date> {
  const [row] = await sqlRows<{ database_now: Date | string }>(
    tx,
    sql`SELECT clock_timestamp() AS database_now`,
  );
  if (!row) invariant("database_clock_missing");
  const value = row.database_now instanceof Date ? row.database_now : new Date(row.database_now);
  if (!Number.isFinite(value.getTime())) invariant("database_clock_invalid");
  return value;
}

async function lockObject(
  tx: DbTransaction,
  organizationId: string,
  objectId: string,
): Promise<OrgStorageObject> {
  const [object] = await tx
    .select()
    .from(orgStorageObjects)
    .where(
      and(
        eq(orgStorageObjects.organization_id, organizationId),
        eq(orgStorageObjects.id, objectId),
      ),
    )
    .limit(1)
    .for("update");
  if (!object) notFound("object");
  return object;
}

async function lockOperation(
  tx: DbTransaction,
  organizationId: string,
  operationId: string,
): Promise<OrgStorageOperation> {
  const [operation] = await tx
    .select()
    .from(orgStorageOperations)
    .where(
      and(
        eq(orgStorageOperations.organization_id, organizationId),
        eq(orgStorageOperations.id, operationId),
      ),
    )
    .limit(1)
    .for("update");
  if (!operation) notFound("operation");
  return operation;
}

async function lockQuota(tx: DbTransaction, organizationId: string): Promise<OrgStorageQuota> {
  const [quota] = await tx
    .select()
    .from(orgStorageQuota)
    .where(eq(orgStorageQuota.organization_id, organizationId))
    .limit(1)
    .for("update");
  if (!quota) invariant("quota_row_missing");
  return quota;
}

async function releaseQuotaExact(
  tx: DbTransaction,
  organizationId: string,
  amount: bigint,
  minimumRepresentedBytes: bigint,
  now: Date,
): Promise<void> {
  if (minimumRepresentedBytes < amount) invariant("quota_settlement_shape");
  const updated = await tx
    .update(orgStorageQuota)
    .set({
      bytes_used: sql`${orgStorageQuota.bytes_used} - ${amount}`,
      updated_at: now,
    })
    .where(
      and(
        eq(orgStorageQuota.organization_id, organizationId),
        sql`${orgStorageQuota.bytes_used} >= ${minimumRepresentedBytes}`,
      ),
    )
    .returning({ organizationId: orgStorageQuota.organization_id });
  if (updated.length !== 1) invariant("quota_operation_bytes_unrepresented");
}

async function updateOperationOrFail(
  tx: DbTransaction,
  operationId: string,
  values: Parameters<ReturnType<DbTransaction["update"]>["set"]>[0],
): Promise<OrgStorageOperation> {
  const [updated] = await tx
    .update(orgStorageOperations)
    .set(values)
    .where(eq(orgStorageOperations.id, operationId))
    .returning();
  if (!updated) invariant("operation_update_lost");
  return updated;
}

/** Primary-only correctness reader for object authority and operation receipts. */
export class OrgStorageObjectAuthorityReader {
  async resolveObjectReadByKey(
    organizationId: string,
    objectKey: string,
  ): Promise<ResolveObjectReadByKeyResult> {
    requireUuid(organizationId, "organizationId");
    requireObjectKey(organizationId, objectKey);

    const rows = await dbWrite
      .select({
        organizationId: orgStorageObjects.organization_id,
        objectId: orgStorageObjects.id,
        objectKey: orgStorageObjects.object_key,
        keyFingerprint: orgStorageObjects.key_fingerprint,
        presence: orgStorageObjects.presence,
        committedGeneration: orgStorageObjects.committed_generation,
        sizeBytes: orgStorageObjects.size_bytes,
        providerKey: orgStorageObjects.current_provider_key,
        providerVersion: orgStorageObjects.provider_version,
        providerEtag: orgStorageObjects.provider_etag,
        contentType: orgStorageObjects.content_type,
        checksumSha256: orgStorageObjects.checksum_sha256,
        providerUploadedAt: orgStorageObjects.provider_uploaded_at,
        activeOrganizationId: orgStorageOperations.organization_id,
        activeObjectId: orgStorageOperations.object_id,
        activeState: orgStorageOperations.state,
        activeTargetGeneration: orgStorageOperations.target_generation,
      })
      .from(orgStorageObjects)
      .leftJoin(
        orgStorageOperations,
        and(
          eq(orgStorageOperations.organization_id, orgStorageObjects.organization_id),
          eq(orgStorageOperations.object_id, orgStorageObjects.id),
          inArray(orgStorageOperations.state, ["prepared", "provider_started", "quarantined"]),
        ),
      )
      .where(
        and(
          eq(orgStorageObjects.organization_id, organizationId),
          eq(orgStorageObjects.storage_namespace, ORG_STORAGE_NAMESPACE),
          eq(orgStorageObjects.object_key, objectKey),
        ),
      )
      .limit(2);

    if (rows.length === 0) return { outcome: "absent" };
    if (rows.length !== 1) invariant("object_read_active_operation_not_unique");
    const row = rows[0];
    if (!row) invariant("object_read_projection_missing");
    if (
      row.organizationId !== organizationId ||
      row.objectKey !== objectKey ||
      row.keyFingerprint !== sha256(objectKey)
    ) {
      invariant("object_read_identity");
    }

    const activeState = row.activeState;
    if (activeState === null) {
      if (
        row.activeOrganizationId !== null ||
        row.activeObjectId !== null ||
        row.activeTargetGeneration !== null
      ) {
        invariant("object_read_active_operation_shape");
      }
    } else if (
      row.activeOrganizationId !== organizationId ||
      row.activeObjectId !== row.objectId ||
      row.activeTargetGeneration === null ||
      row.activeTargetGeneration <= row.committedGeneration ||
      (activeState !== "prepared" &&
        activeState !== "provider_started" &&
        activeState !== "quarantined")
    ) {
      invariant("object_read_active_operation_shape");
    }

    if (row.presence === "absent") {
      if (
        row.committedGeneration < 0n ||
        row.sizeBytes !== 0n ||
        row.providerKey !== null ||
        row.providerVersion !== null ||
        row.providerEtag !== null ||
        row.contentType !== null ||
        row.checksumSha256 !== null ||
        row.providerUploadedAt !== null
      ) {
        invariant("object_read_absent_shape");
      }
    } else if (row.presence === "present") {
      const providerKey = row.providerKey;
      const providerVersion = row.providerVersion;
      const providerEtag = row.providerEtag;
      const contentType = row.contentType;
      const providerUploadedAt = row.providerUploadedAt;
      const immutableProviderKey =
        row.committedGeneration > 0n
          ? orgStorageProviderKey(organizationId, row.objectId, row.committedGeneration)
          : null;
      if (
        row.organizationId !== organizationId ||
        row.objectKey !== objectKey ||
        row.committedGeneration < 1n ||
        row.sizeBytes < 0n ||
        providerKey === null ||
        (providerKey !== immutableProviderKey &&
          (row.committedGeneration !== 1n || providerKey !== objectKey)) ||
        providerVersion === null ||
        providerVersion.length < 1 ||
        providerVersion.length > 1024 ||
        /[\r\n]/.test(providerVersion) ||
        providerEtag === null ||
        providerEtag.length < 1 ||
        providerEtag.length > 512 ||
        /["\r\n]/.test(providerEtag) ||
        contentType === null ||
        contentType.length < 1 ||
        contentType.length > 255 ||
        /[\r\n]/.test(contentType) ||
        (row.checksumSha256 !== null && !SHA256_PATTERN.test(row.checksumSha256)) ||
        providerUploadedAt === null ||
        !Number.isFinite(providerUploadedAt.getTime())
      ) {
        invariant("object_read_present_shape");
      }
    } else {
      invariant("object_read_presence");
    }

    if (activeState === "provider_started" || activeState === "quarantined") {
      if (row.activeTargetGeneration === null) invariant("object_read_active_operation_shape");
      return {
        outcome: "in_progress",
        objectId: row.objectId,
        committedGeneration: row.committedGeneration,
        targetGeneration: row.activeTargetGeneration,
        activeState,
      };
    }
    if (row.presence === "absent") return { outcome: "absent" };

    const providerKey = row.providerKey;
    const providerVersion = row.providerVersion;
    const providerEtag = row.providerEtag;
    const contentType = row.contentType;
    const providerUploadedAt = row.providerUploadedAt;
    if (
      providerKey === null ||
      providerVersion === null ||
      providerEtag === null ||
      contentType === null ||
      providerUploadedAt === null
    ) {
      invariant("object_read_present_shape");
    }
    return {
      outcome: "present",
      snapshot: {
        organizationId: row.organizationId,
        objectId: row.objectId,
        objectKey: row.objectKey,
        committedGeneration: row.committedGeneration,
        sizeBytes: row.sizeBytes,
        providerKey,
        providerVersion,
        providerEtag,
        contentType,
        checksumSha256: row.checksumSha256,
        providerUploadedAt: new Date(providerUploadedAt.getTime()),
      },
    };
  }

  async findObjectById(
    organizationId: string,
    objectId: string,
  ): Promise<OrgStorageObject | undefined> {
    requireUuid(organizationId, "organizationId");
    requireUuid(objectId, "objectId");
    const [row] = await dbWrite
      .select()
      .from(orgStorageObjects)
      .where(
        and(
          eq(orgStorageObjects.organization_id, organizationId),
          eq(orgStorageObjects.id, objectId),
        ),
      )
      .limit(1);
    return row;
  }

  async findObjectByKey(
    organizationId: string,
    objectKey: string,
  ): Promise<OrgStorageObject | undefined> {
    requireUuid(organizationId, "organizationId");
    requireObjectKey(organizationId, objectKey);
    const [row] = await dbWrite
      .select()
      .from(orgStorageObjects)
      .where(
        and(
          eq(orgStorageObjects.organization_id, organizationId),
          eq(orgStorageObjects.storage_namespace, ORG_STORAGE_NAMESPACE),
          eq(orgStorageObjects.object_key, objectKey),
        ),
      )
      .limit(1);
    return row;
  }

  async findOperationById(
    organizationId: string,
    operationId: string,
  ): Promise<OrgStorageOperation | undefined> {
    requireUuid(organizationId, "organizationId");
    requireUuid(operationId, "operationId");
    const [row] = await dbWrite
      .select()
      .from(orgStorageOperations)
      .where(
        and(
          eq(orgStorageOperations.organization_id, organizationId),
          eq(orgStorageOperations.id, operationId),
        ),
      )
      .limit(1);
    return row;
  }

  async findOperationByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<OrgStorageOperation | undefined> {
    requireUuid(organizationId, "organizationId");
    requireIdempotencyKey(idempotencyKey);
    const idempotencyHash = hashIdempotencyKey(organizationId, idempotencyKey);
    const [row] = await dbWrite
      .select()
      .from(orgStorageOperations)
      .where(
        and(
          eq(orgStorageOperations.organization_id, organizationId),
          eq(orgStorageOperations.idempotency_key_hash, idempotencyHash),
        ),
      )
      .limit(1);
    return row;
  }
}

export const orgStorageObjectAuthorityReader = new OrgStorageObjectAuthorityReader();

/** Writer for object admission and fenced state-machine transitions. */
export class OrgStorageObjectAuthorityWriter {
  constructor(
    private readonly reader: OrgStorageObjectAuthorityReader = orgStorageObjectAuthorityReader,
  ) {}

  async registerObservedAuthority(
    input: RegisterObservedAuthorityInput,
  ): Promise<RegisterObservedAuthorityResult> {
    requireUuid(input.organizationId, "organizationId");
    requireObjectKey(input.organizationId, input.objectKey);
    const observation = normalizeObservation(input.observation);
    const generation = observation.presence === "present" ? 1n : 0n;
    return await dbWrite.transaction(async (tx) => {
      const databaseNow = await getDatabaseNow(tx);
      const inserted = await tx
        .insert(orgStorageObjects)
        .values({
          organization_id: input.organizationId,
          storage_namespace: ORG_STORAGE_NAMESPACE,
          object_key: input.objectKey,
          key_fingerprint: sha256(input.objectKey),
          presence: observation.presence,
          last_allocated_generation: generation,
          committed_generation: generation,
          size_bytes: observation.presence === "present" ? observation.sizeBytes : 0n,
          provider_version: observation.presence === "present" ? observation.providerVersion : null,
          provider_etag: observation.presence === "present" ? observation.providerEtag : null,
          current_provider_key: observation.presence === "present" ? input.objectKey : null,
          content_type: observation.presence === "present" ? observation.contentType : null,
          checksum_sha256: observation.presence === "present" ? observation.checksumSha256 : null,
          provider_uploaded_at:
            observation.presence === "present" ? observation.providerUploadedAt : null,
          verified_at: databaseNow,
          created_at: databaseNow,
          updated_at: databaseNow,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) return { outcome: "registered", authority: inserted[0] };

      const [existing] = await tx
        .select()
        .from(orgStorageObjects)
        .where(
          and(
            eq(orgStorageObjects.organization_id, input.organizationId),
            eq(orgStorageObjects.storage_namespace, ORG_STORAGE_NAMESPACE),
            eq(orgStorageObjects.object_key, input.objectKey),
          ),
        )
        .limit(1);
      if (!existing) invariant("authority_insert_conflict_without_identity_row");
      return observationMatches(existing, observation)
        ? { outcome: "replayed", authority: existing }
        : { outcome: "conflict", authority: existing };
    });
  }

  async prepareOperation(input: PrepareOperationInput): Promise<PrepareOperationResult> {
    const target = validatePrepareInput(input);
    const idempotencyHash = hashIdempotencyKey(input.organizationId, input.idempotencyKey);
    const durableSameKey = await this.reader.findOperationByIdempotencyKey(
      input.organizationId,
      input.idempotencyKey,
    );
    if (durableSameKey) {
      return operationMatchesRequest(durableSameKey, input, idempotencyHash, target)
        ? { outcome: "replayed", operation: durableSameKey }
        : { outcome: "conflict", reason: "idempotency_mismatch" };
    }

    try {
      return await dbWrite.transaction(async (tx) => {
        // Global lock order for quota-settling paths: quota -> object -> operation.
        const [quota] = await tx
          .select()
          .from(orgStorageQuota)
          .where(eq(orgStorageQuota.organization_id, input.organizationId))
          .limit(1)
          .for("update");
        if (!quota) return { outcome: "quota_unreconciled" as const, reason: "missing" as const };
        const object = await lockObject(tx, input.organizationId, input.objectId);
        const databaseNow = await getDatabaseNow(tx);
        if (quota.bytes_used < 0n || quota.bytes_limit < 0n) invariant("negative_quota_state");
        if (quota.bytes_used < object.size_bytes) {
          return { outcome: "quota_unreconciled" as const, reason: "below_source" as const };
        }

        const [sameKey] = await tx
          .select()
          .from(orgStorageOperations)
          .where(
            and(
              eq(orgStorageOperations.organization_id, input.organizationId),
              eq(orgStorageOperations.idempotency_key_hash, idempotencyHash),
            ),
          )
          .limit(1)
          .for("update");
        if (sameKey) {
          return operationMatchesRequest(sameKey, input, idempotencyHash, target)
            ? { outcome: "replayed" as const, operation: sameKey }
            : { outcome: "conflict" as const, reason: "idempotency_mismatch" as const };
        }

        const [blocking] = await tx
          .select()
          .from(orgStorageOperations)
          .where(
            and(
              eq(orgStorageOperations.organization_id, input.organizationId),
              eq(orgStorageOperations.object_id, input.objectId),
              inArray(orgStorageOperations.state, ["prepared", "provider_started", "quarantined"]),
            ),
          )
          .limit(1)
          .for("update");
        if (blocking) return { outcome: "busy" as const, operation: blocking };
        if (!sourceMatchesObject(object, input.expected)) {
          return { outcome: "conflict" as const, reason: "source_mismatch" as const };
        }
        if (object.last_allocated_generation === MAX_BIGINT) {
          return { outcome: "conflict" as const, reason: "generation_exhausted" as const };
        }

        const targetGeneration = object.last_allocated_generation + 1n;
        const quotaDelta = target.sizeBytes - object.size_bytes;
        const quotaReserved = target.operation === "put" ? target.sizeBytes : 0n;
        const quotaRelease = object.size_bytes;
        const targetProviderKey =
          target.operation === "put"
            ? orgStorageProviderKey(input.organizationId, object.id, targetGeneration)
            : null;

        if (quotaReserved > 0n && quotaReserved > quota.bytes_limit - quota.bytes_used) {
          throw new PrepareRollback("quota_exceeded", {
            bytesUsed: quota.bytes_used,
            bytesLimit: quota.bytes_limit,
            requiredBytes: quotaReserved,
          });
        }
        if (quotaReserved > 0n) {
          const reserved = await tx
            .update(orgStorageQuota)
            .set({
              bytes_used: sql`${orgStorageQuota.bytes_used} + ${quotaReserved}`,
              updated_at: databaseNow,
            })
            .where(
              and(
                eq(orgStorageQuota.organization_id, input.organizationId),
                sql`${orgStorageQuota.bytes_used} + ${quotaReserved} <= ${orgStorageQuota.bytes_limit}`,
              ),
            )
            .returning({ organizationId: orgStorageQuota.organization_id });
          if (reserved.length !== 1) {
            throw new PrepareRollback("quota_exceeded", {
              bytesUsed: quota.bytes_used,
              bytesLimit: quota.bytes_limit,
              requiredBytes: quotaReserved,
            });
          }
        }

        const inserted = await tx
          .insert(orgStorageOperations)
          .values({
            id: input.operationId,
            organization_id: input.organizationId,
            object_id: input.objectId,
            operation: target.operation,
            state: "prepared",
            idempotency_key_hash: idempotencyHash,
            request_digest: input.requestDigest,
            source_presence: object.presence,
            source_generation: object.committed_generation,
            target_generation: targetGeneration,
            source_size_bytes: object.size_bytes,
            target_size_bytes: target.sizeBytes,
            quota_delta_bytes: quotaDelta,
            quota_reserved_bytes: quotaReserved,
            quota_release_bytes: quotaRelease,
            source_provider_version: object.provider_version,
            source_provider_etag: object.provider_etag,
            source_provider_key: object.current_provider_key,
            target_content_type: target.contentType,
            target_content_sha256: target.checksumSha256,
            target_provider_key: targetProviderKey,
            provider_write_started: false,
            provider_started_at: null,
            next_attempt_at: databaseNow,
            created_at: databaseNow,
            updated_at: databaseNow,
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted[0]) throw new PrepareRollback("insert_conflict");

        const advanced = await tx
          .update(orgStorageObjects)
          .set({ last_allocated_generation: targetGeneration, updated_at: databaseNow })
          .where(
            and(
              eq(orgStorageObjects.id, object.id),
              eq(orgStorageObjects.organization_id, input.organizationId),
              eq(orgStorageObjects.last_allocated_generation, object.last_allocated_generation),
            ),
          )
          .returning({ id: orgStorageObjects.id });
        if (advanced.length !== 1) invariant("generation_advance_lost");
        return { outcome: "prepared" as const, operation: inserted[0] };
      });
    } catch (error) {
      // error-policy:J1 Translate a rolled-back admission or commit-ack race into a bounded outcome.
      const sameKey = await this.reader.findOperationByIdempotencyKey(
        input.organizationId,
        input.idempotencyKey,
      );
      if (sameKey) {
        return operationMatchesRequest(sameKey, input, idempotencyHash, target)
          ? { outcome: "replayed", operation: sameKey }
          : { outcome: "conflict", reason: "idempotency_mismatch" };
      }
      if (error instanceof PrepareRollback) {
        if (error.reason === "quota_exceeded" && error.quota) {
          return { outcome: "quota_exceeded", ...error.quota };
        }
        return { outcome: "conflict", reason: "operation_id_conflict" };
      }
      throw error;
    }
  }

  async claimOperationById(input: ClaimOperationInput): Promise<ClaimOperationResult> {
    requireUuid(input.organizationId, "organizationId");
    requireUuid(input.operationId, "operationId");
    requireClaimOwner(input.claimOwner);
    requireUuid(input.claimGeneration, "claimGeneration");
    requireLeaseMs(input.leaseMs);

    try {
      return await dbWrite.transaction(async (tx) => {
        const [operation] = await tx
          .select()
          .from(orgStorageOperations)
          .where(
            and(
              eq(orgStorageOperations.organization_id, input.organizationId),
              eq(orgStorageOperations.id, input.operationId),
            ),
          )
          .limit(1)
          .for("update");
        if (!operation) return { outcome: "not_claimed", reason: "not_found" };
        const databaseNow = await getDatabaseNow(tx);
        if (claimMatchesRequest(operation, input.claimOwner, input.claimGeneration)) {
          return operation.lease_expires_at !== null &&
            operation.lease_expires_at.getTime() > databaseNow.getTime()
            ? { outcome: "claimed", claim: toClaim(operation) }
            : { outcome: "not_claimed", reason: "busy" };
        }
        if (operation.state !== "prepared" && operation.state !== "provider_started") {
          return { outcome: "not_claimed", reason: "terminal" };
        }
        if (operation.next_attempt_at.getTime() > databaseNow.getTime()) {
          return { outcome: "not_claimed", reason: "not_due" };
        }
        if (
          operation.lease_expires_at !== null &&
          operation.lease_expires_at.getTime() > databaseNow.getTime()
        ) {
          return { outcome: "not_claimed", reason: "busy" };
        }
        if (operation.attempts >= MAX_ATTEMPTS) {
          return { outcome: "not_claimed", reason: "exhausted" };
        }
        const updated = await updateOperationOrFail(tx, operation.id, {
          claim_owner: input.claimOwner,
          claim_generation: input.claimGeneration,
          lease_expires_at: sql`clock_timestamp() + (${input.leaseMs} * INTERVAL '1 millisecond')`,
          attempts: operation.attempts + 1,
          updated_at: sql`clock_timestamp()`,
        });
        return { outcome: "claimed", claim: toClaim(updated) };
      });
    } catch (error) {
      // error-policy:J1 Recover an exact claim after an ambiguous primary commit acknowledgement.
      const recovered = await this.findActiveClaimById(input);
      if (recovered) {
        return { outcome: "claimed", claim: toClaim(recovered) };
      }
      throw error;
    }
  }

  async claimDueOperations(input: ClaimDueOperationsInput): Promise<OrgStorageOperationClaim[]> {
    requireUuid(input.organizationId, "organizationId");
    requireClaimOwner(input.claimOwner);
    requireUuid(input.claimGeneration, "claimGeneration");
    requireLeaseMs(input.leaseMs);
    this.requireClaimLimit(input.limit);
    return await this.claimDueOperationsInternal(input, input.organizationId);
  }

  /** System-worker discovery across tenants. Route handlers must use the tenant-scoped variant. */
  async claimDueOperationsGlobally(
    input: ClaimDueOperationsGloballyInput,
  ): Promise<OrgStorageOperationClaim[]> {
    requireClaimOwner(input.claimOwner);
    requireUuid(input.claimGeneration, "claimGeneration");
    requireLeaseMs(input.leaseMs);
    this.requireClaimLimit(input.limit);
    return await this.claimDueOperationsInternal(input, null);
  }

  async markProviderStarted(input: MarkProviderStartedInput): Promise<StateTransitionResult> {
    requireFenceInput(input);
    requireDate(input.nextAttemptAt, "nextAttemptAt");
    const durable = await this.reader.findOperationById(input.organizationId, input.operationId);
    if (durable?.state === "provider_started" && durable.provider_write_started) {
      requireFenceIdentity(durable, input);
      return { outcome: "replayed", operation: durable };
    }
    try {
      return await this.withLockedObjectOperation(input, async (tx, quota, object, operation) => {
        if (operation.state === "provider_started" && operation.provider_write_started) {
          requireFenceIdentity(operation, input);
          return { outcome: "replayed", operation };
        }
        const databaseNow = await getDatabaseNow(tx);
        requireFence(operation, input, databaseNow);
        if (operation.state !== "prepared" || operation.provider_write_started) {
          conflict("provider_start_state");
        }
        if (!operationSourceMatchesObject(operation, object)) invariant("object_source_drift");
        requireQuotaRepresentsOperation(quota, operation);
        const updated = await updateOperationOrFail(tx, operation.id, {
          state: "provider_started",
          provider_write_started: true,
          provider_started_at: sql`clock_timestamp()`,
          next_attempt_at: input.nextAttemptAt,
          updated_at: sql`clock_timestamp()`,
        });
        return { outcome: "applied", operation: updated };
      });
    } catch (error) {
      // error-policy:J1 Recover an exact provider-start marker after an ambiguous commit acknowledgement.
      const recovered = await this.reader.findOperationById(
        input.organizationId,
        input.operationId,
      );
      if (recovered?.state === "provider_started" && recovered.provider_write_started) {
        requireFenceIdentity(recovered, input);
        return { outcome: "replayed", operation: recovered };
      }
      throw error;
    }
  }

  async commitPut(input: CommitPutInput): Promise<StateTransitionResult> {
    requireFenceInput(input);
    if (
      typeof input.targetEvidence !== "object" ||
      input.targetEvidence === null ||
      input.targetEvidence.kind !== "target_provider_object_observed"
    ) {
      invalidInput("targetEvidence kind is invalid", "targetEvidence.kind");
    }
    requireProviderVersion(input.targetEvidence.providerVersion, "targetEvidence.providerVersion");
    requireProviderEtag(input.targetEvidence.providerEtag, "targetEvidence.providerEtag");
    requireBigint(input.targetEvidence.sizeBytes, "targetEvidence.sizeBytes");
    requireDigest(input.targetEvidence.checksumSha256, "targetEvidence.checksumSha256");
    requireDate(input.targetEvidence.providerUploadedAt, "targetEvidence.providerUploadedAt");
    requireContentType(input.targetEvidence.contentType, "targetEvidence.contentType");
    requirePutTargetCustomMetadata(input.targetEvidence.customMetadata);
    requireDigest(input.receiptDigest, "receiptDigest");
    const durable = await this.reader.findOperationById(input.organizationId, input.operationId);
    if (durable?.state === "committed" || durable?.state === "aborted") {
      if (terminalPutMatches(durable, input)) {
        validateSourceAbsenceProof(durable, input.sourceAbsenceProof);
        return { outcome: "replayed", operation: durable };
      }
      conflict("terminal_put_receipt_mismatch");
    }
    return await this.withLockedObjectOperation(input, async (tx, quota, object, operation) => {
      if (operation.state === "committed" || operation.state === "aborted") {
        if (terminalPutMatches(operation, input)) {
          validateSourceAbsenceProof(operation, input.sourceAbsenceProof);
          return { outcome: "replayed", operation };
        }
        conflict("terminal_put_receipt_mismatch");
      }
      const databaseNow = await getDatabaseNow(tx);
      requireFence(operation, input, databaseNow);
      if (
        operation.state !== "provider_started" ||
        !operation.provider_write_started ||
        operation.operation !== "put"
      ) {
        conflict("commit_put_state");
      }
      if (
        input.targetEvidence.sizeBytes !== operation.target_size_bytes ||
        input.targetEvidence.checksumSha256 !== operation.target_content_sha256 ||
        input.targetEvidence.providerKey !== operation.target_provider_key ||
        input.targetEvidence.contentType !== operation.target_content_type ||
        input.targetEvidence.customMetadata.operationId !== operation.id ||
        input.targetEvidence.customMetadata.targetGeneration !==
          operation.target_generation.toString(10) ||
        input.targetEvidence.customMetadata.requestDigest !== operation.request_digest
      ) {
        conflict("commit_put_result_mismatch");
      }
      if (
        operation.source_presence === "present" &&
        input.targetEvidence.providerVersion === operation.source_provider_version
      ) {
        conflict("provider_version_not_advanced");
      }
      if (!operationSourceMatchesObject(operation, object)) invariant("object_source_drift");
      const hadSource = validateSourceAbsenceProof(operation, input.sourceAbsenceProof);
      requireQuotaRepresentsOperation(quota, operation);
      await releaseQuotaExact(
        tx,
        input.organizationId,
        operation.quota_release_bytes,
        operation.quota_release_bytes + operation.quota_reserved_bytes,
        databaseNow,
      );
      const objectUpdates = await tx
        .update(orgStorageObjects)
        .set({
          presence: "present",
          committed_generation: operation.target_generation,
          size_bytes: input.targetEvidence.sizeBytes,
          provider_version: input.targetEvidence.providerVersion,
          provider_etag: input.targetEvidence.providerEtag,
          current_provider_key: operation.target_provider_key,
          content_type: operation.target_content_type,
          checksum_sha256: input.targetEvidence.checksumSha256,
          provider_uploaded_at: input.targetEvidence.providerUploadedAt,
          verified_at: databaseNow,
          updated_at: databaseNow,
        })
        .where(
          and(
            eq(orgStorageObjects.id, object.id),
            eq(orgStorageObjects.organization_id, input.organizationId),
            eq(orgStorageObjects.committed_generation, operation.source_generation),
          ),
        )
        .returning({ id: orgStorageObjects.id });
      if (objectUpdates.length !== 1) invariant("object_commit_lost");
      const updated = await updateOperationOrFail(tx, operation.id, {
        state: "committed",
        result_provider_version: input.targetEvidence.providerVersion,
        result_provider_etag: input.targetEvidence.providerEtag,
        result_size_bytes: input.targetEvidence.sizeBytes,
        result_checksum_sha256: input.targetEvidence.checksumSha256,
        result_uploaded_at: input.targetEvidence.providerUploadedAt,
        response_status: 201,
        receipt_digest: input.receiptDigest,
        last_observed_at: hadSource ? databaseNow : null,
        claim_owner: null,
        claim_generation: null,
        lease_expires_at: null,
        completed_at: databaseNow,
        updated_at: databaseNow,
      });
      return { outcome: "applied", operation: updated };
    });
  }

  async commitDelete(input: CommitDeleteInput): Promise<StateTransitionResult> {
    requireFenceInput(input);
    requireDigest(input.receiptDigest, "receiptDigest");
    const durable = await this.reader.findOperationById(input.organizationId, input.operationId);
    if (durable?.state === "committed" || durable?.state === "aborted") {
      if (terminalDeleteMatches(durable, input)) {
        validateSourceAbsenceProof(durable, input.sourceAbsenceProof);
        return { outcome: "replayed", operation: durable };
      }
      conflict("terminal_delete_receipt_mismatch");
    }
    return await this.withLockedObjectOperation(input, async (tx, quota, object, operation) => {
      if (operation.state === "committed" || operation.state === "aborted") {
        if (terminalDeleteMatches(operation, input)) {
          validateSourceAbsenceProof(operation, input.sourceAbsenceProof);
          return { outcome: "replayed", operation };
        }
        conflict("terminal_delete_receipt_mismatch");
      }
      const databaseNow = await getDatabaseNow(tx);
      requireFence(operation, input, databaseNow);
      if (
        operation.state !== "provider_started" ||
        !operation.provider_write_started ||
        operation.operation !== "delete"
      ) {
        conflict("commit_delete_state");
      }
      if (!operationSourceMatchesObject(operation, object)) invariant("object_source_drift");
      const hadSource = validateSourceAbsenceProof(operation, input.sourceAbsenceProof);
      requireQuotaRepresentsOperation(quota, operation);
      await releaseQuotaExact(
        tx,
        input.organizationId,
        operation.quota_release_bytes,
        operation.quota_release_bytes + operation.quota_reserved_bytes,
        databaseNow,
      );
      const objectUpdates = await tx
        .update(orgStorageObjects)
        .set({
          presence: "absent",
          committed_generation: operation.target_generation,
          size_bytes: 0n,
          provider_version: null,
          provider_etag: null,
          current_provider_key: null,
          content_type: null,
          checksum_sha256: null,
          provider_uploaded_at: null,
          verified_at: databaseNow,
          updated_at: databaseNow,
        })
        .where(
          and(
            eq(orgStorageObjects.id, object.id),
            eq(orgStorageObjects.organization_id, input.organizationId),
            eq(orgStorageObjects.committed_generation, operation.source_generation),
          ),
        )
        .returning({ id: orgStorageObjects.id });
      if (objectUpdates.length !== 1) invariant("object_commit_lost");
      const updated = await updateOperationOrFail(tx, operation.id, {
        state: "committed",
        response_status: 204,
        receipt_digest: input.receiptDigest,
        last_observed_at: hadSource ? databaseNow : null,
        claim_owner: null,
        claim_generation: null,
        lease_expires_at: null,
        completed_at: databaseNow,
        updated_at: databaseNow,
      });
      return { outcome: "applied", operation: updated };
    });
  }

  async abortUnstarted(input: AbortOperationInput): Promise<StateTransitionResult> {
    return await this.abortOperation(input);
  }

  async recordAmbiguousObservation(
    input: AmbiguousObservationInput,
  ): Promise<StateTransitionResult> {
    requireFenceInput(input);
    requireError(input.errorCode, input.errorDigest);
    requireDate(input.nextAttemptAt, "nextAttemptAt");
    return await dbWrite.transaction(async (tx) => {
      const operation = await lockOperation(tx, input.organizationId, input.operationId);
      if (
        operation.state === "provider_started" &&
        operation.claim_owner === null &&
        operation.last_error_code === input.errorCode &&
        operation.last_error_digest === input.errorDigest &&
        operation.next_attempt_at.getTime() === input.nextAttemptAt.getTime()
      ) {
        return { outcome: "replayed", operation };
      }
      const databaseNow = await getDatabaseNow(tx);
      requireFence(operation, input, databaseNow);
      if (operation.state !== "provider_started" || !operation.provider_write_started) {
        conflict("ambiguous_observation_state");
      }
      const updated = await updateOperationOrFail(tx, operation.id, {
        last_error_code: input.errorCode,
        last_error_digest: input.errorDigest,
        last_observed_at: databaseNow,
        next_attempt_at: input.nextAttemptAt,
        claim_owner: null,
        claim_generation: null,
        lease_expires_at: null,
        updated_at: databaseNow,
      });
      return { outcome: "applied", operation: updated };
    });
  }

  async quarantineOperation(input: QuarantineOperationInput): Promise<StateTransitionResult> {
    requireFenceInput(input);
    requireError(input.errorCode, input.errorDigest);
    return await dbWrite.transaction(async (tx) => {
      const operation = await lockOperation(tx, input.organizationId, input.operationId);
      if (
        operation.state === "quarantined" &&
        operation.last_error_code === input.errorCode &&
        operation.last_error_digest === input.errorDigest
      ) {
        return { outcome: "replayed", operation };
      }
      const databaseNow = await getDatabaseNow(tx);
      requireFence(operation, input, databaseNow);
      if (operation.state !== "provider_started" || !operation.provider_write_started) {
        conflict("quarantine_state");
      }
      const updated = await updateOperationOrFail(tx, operation.id, {
        state: "quarantined",
        last_error_code: input.errorCode,
        last_error_digest: input.errorDigest,
        last_observed_at: databaseNow,
        claim_owner: null,
        claim_generation: null,
        lease_expires_at: null,
        updated_at: databaseNow,
      });
      return { outcome: "applied", operation: updated };
    });
  }

  async rearmQuarantinedOperation(
    input: RearmQuarantinedOperationInput,
  ): Promise<OrgStorageOperationClaim> {
    requireUuid(input.organizationId, "organizationId");
    requireUuid(input.operationId, "operationId");
    requireDigest(input.expectedErrorDigest, "expectedErrorDigest");
    requireClaimOwner(input.claimOwner);
    requireUuid(input.claimGeneration, "claimGeneration");
    requireLeaseMs(input.leaseMs);
    return await dbWrite.transaction(async (tx) => {
      const operation = await lockOperation(tx, input.organizationId, input.operationId);
      const databaseNow = await getDatabaseNow(tx);
      if (
        operation.state === "provider_started" &&
        operation.provider_write_started &&
        operation.last_error_digest === input.expectedErrorDigest &&
        claimMatchesRequest(operation, input.claimOwner, input.claimGeneration) &&
        operation.lease_expires_at !== null &&
        operation.lease_expires_at.getTime() > databaseNow.getTime()
      ) {
        return toClaim(operation);
      }
      if (
        operation.state !== "quarantined" ||
        !operation.provider_write_started ||
        operation.last_error_digest !== input.expectedErrorDigest
      ) {
        staleFence("quarantine_evidence_mismatch");
      }
      requireAttemptCapacity(operation);
      const updated = await updateOperationOrFail(tx, operation.id, {
        state: "provider_started",
        claim_owner: input.claimOwner,
        claim_generation: input.claimGeneration,
        lease_expires_at: sql`clock_timestamp() + (${input.leaseMs} * INTERVAL '1 millisecond')`,
        attempts: operation.attempts + 1,
        next_attempt_at: sql`clock_timestamp()`,
        updated_at: sql`clock_timestamp()`,
      });
      return toClaim(updated);
    });
  }

  private requireClaimLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CLAIM_BATCH) {
      invalidInput(`limit must be between 1 and ${MAX_CLAIM_BATCH}`, "limit");
    }
  }

  private async findActiveClaimById(
    input: ClaimOperationInput,
  ): Promise<OrgStorageOperation | undefined> {
    const [row] = await dbWrite
      .select()
      .from(orgStorageOperations)
      .where(
        and(
          eq(orgStorageOperations.organization_id, input.organizationId),
          eq(orgStorageOperations.id, input.operationId),
          eq(orgStorageOperations.claim_owner, input.claimOwner),
          eq(orgStorageOperations.claim_generation, input.claimGeneration),
          inArray(orgStorageOperations.state, ["prepared", "provider_started"]),
          sql`${orgStorageOperations.lease_expires_at} > clock_timestamp()`,
        ),
      )
      .limit(1);
    return row;
  }

  private async claimDueOperationsInternal(
    input: ClaimDueOperationsGloballyInput,
    organizationId: string | null,
  ): Promise<OrgStorageOperationClaim[]> {
    const replayed = await this.findExactClaimBatch(input, organizationId);
    if (replayed.length > 0) return replayed;
    try {
      return await dbWrite.transaction(async (tx) => {
        const tenantPredicate =
          organizationId === null ? sql`TRUE` : sql`operation.organization_id = ${organizationId}`;
        const candidates = await sqlRows<{ id: string; organization_id: string }>(
          tx,
          sql`
            SELECT operation.id, operation.organization_id
            FROM ${orgStorageOperations} AS operation
            WHERE ${tenantPredicate}
              AND operation.state IN ('prepared', 'provider_started')
              AND operation.attempts < ${MAX_ATTEMPTS}
              AND operation.next_attempt_at <= clock_timestamp()
              AND (operation.lease_expires_at IS NULL
                OR operation.lease_expires_at <= clock_timestamp())
              AND (operation.claim_generation IS NULL
                OR operation.claim_generation <> ${input.claimGeneration})
            ORDER BY operation.next_attempt_at, operation.created_at, operation.id
            LIMIT ${input.limit}
            FOR UPDATE OF operation SKIP LOCKED
          `,
        );
        const claims: OrgStorageOperationClaim[] = [];
        for (const candidate of candidates) {
          const [operation] = await tx
            .select()
            .from(orgStorageOperations)
            .where(
              and(
                eq(orgStorageOperations.organization_id, candidate.organization_id),
                eq(orgStorageOperations.id, candidate.id),
              ),
            )
            .limit(1);
          if (
            !operation ||
            (operation.state !== "prepared" && operation.state !== "provider_started") ||
            operation.attempts >= MAX_ATTEMPTS
          ) {
            continue;
          }
          const updated = await updateOperationOrFail(tx, operation.id, {
            claim_owner: input.claimOwner,
            claim_generation: input.claimGeneration,
            lease_expires_at: sql`clock_timestamp() + (${input.leaseMs} * INTERVAL '1 millisecond')`,
            attempts: operation.attempts + 1,
            updated_at: sql`clock_timestamp()`,
          });
          claims.push(toClaim(updated));
        }
        return claims;
      });
    } catch (error) {
      // error-policy:J1 Recover an exact batch after an ambiguous primary commit acknowledgement.
      const recovered = await this.findExactClaimBatch(input, organizationId);
      if (recovered.length > 0) return recovered;
      throw error;
    }
  }

  private async findExactClaimBatch(
    input: ClaimDueOperationsGloballyInput,
    organizationId: string | null,
  ): Promise<OrgStorageOperationClaim[]> {
    const tenantPredicate =
      organizationId === null
        ? sql`TRUE`
        : eq(orgStorageOperations.organization_id, organizationId);
    const rows = await dbWrite
      .select()
      .from(orgStorageOperations)
      .where(
        and(
          tenantPredicate,
          eq(orgStorageOperations.claim_owner, input.claimOwner),
          eq(orgStorageOperations.claim_generation, input.claimGeneration),
          inArray(orgStorageOperations.state, ["prepared", "provider_started"]),
          sql`${orgStorageOperations.lease_expires_at} > clock_timestamp()`,
        ),
      )
      .limit(MAX_CLAIM_BATCH);
    return rows.map(toClaim);
  }

  private async withLockedObjectOperation<T>(
    input: OperationFenceInput,
    transition: (
      tx: DbTransaction,
      quota: OrgStorageQuota,
      object: OrgStorageObject,
      operation: OrgStorageOperation,
    ) => Promise<T>,
  ): Promise<T> {
    requireUuid(input.organizationId, "organizationId");
    requireUuid(input.operationId, "operationId");
    const discovered = await this.reader.findOperationById(input.organizationId, input.operationId);
    if (!discovered) notFound("operation");
    return await dbWrite.transaction(async (tx) => {
      const quota = await lockQuota(tx, input.organizationId);
      const object = await lockObject(tx, input.organizationId, discovered.object_id);
      const operation = await lockOperation(tx, input.organizationId, input.operationId);
      if (operation.object_id !== object.id) invariant("operation_object_identity_changed");
      return await transition(tx, quota, object, operation);
    });
  }

  private async abortOperation(input: AbortOperationInput): Promise<StateTransitionResult> {
    requireFenceInput(input);
    if (
      !Number.isSafeInteger(input.responseStatus) ||
      input.responseStatus < 400 ||
      input.responseStatus > 599
    ) {
      invalidInput("responseStatus must be between 400 and 599", "responseStatus");
    }
    requireDigest(input.receiptDigest, "receiptDigest");
    requireError(input.errorCode, input.errorDigest);
    const durable = await this.reader.findOperationById(input.organizationId, input.operationId);
    if (durable?.state === "committed" || durable?.state === "aborted") {
      if (terminalAbortMatches(durable, input)) {
        return { outcome: "replayed", operation: durable };
      }
      conflict("terminal_abort_receipt_mismatch");
    }
    return await this.withLockedObjectOperation(input, async (tx, quota, object, operation) => {
      if (operation.state === "committed" || operation.state === "aborted") {
        if (terminalAbortMatches(operation, input)) {
          return { outcome: "replayed", operation };
        }
        conflict("terminal_abort_receipt_mismatch");
      }
      const databaseNow = await getDatabaseNow(tx);
      requireFence(operation, input, databaseNow);
      if (operation.state !== "prepared" || operation.provider_write_started) {
        conflict("unstarted_abort_state");
      }
      if (!operationSourceMatchesObject(operation, object)) invariant("object_source_drift");
      requireQuotaRepresentsOperation(quota, operation);
      await releaseQuotaExact(
        tx,
        input.organizationId,
        operation.quota_reserved_bytes,
        operation.quota_release_bytes + operation.quota_reserved_bytes,
        databaseNow,
      );
      const updated = await updateOperationOrFail(tx, operation.id, {
        state: "aborted",
        response_status: input.responseStatus,
        receipt_digest: input.receiptDigest,
        last_error_code: input.errorCode,
        last_error_digest: input.errorDigest,
        last_observed_at: null,
        claim_owner: null,
        claim_generation: null,
        lease_expires_at: null,
        completed_at: databaseNow,
        updated_at: databaseNow,
      });
      return { outcome: "applied", operation: updated };
    });
  }
}

export const orgStorageObjectAuthorityWriter = new OrgStorageObjectAuthorityWriter();
