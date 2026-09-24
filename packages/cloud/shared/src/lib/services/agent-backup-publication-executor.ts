/**
 * Advances captured backups through immutable R2 publication and independent
 * Hetzner replication under the catalogue execution lease. The executor is
 * manifest-version agnostic: its only byte authority is the authenticated
 * chunk inventory already persisted by recordCaptured.
 */

import { ElizaError } from "@elizaos/core";
import {
  type AgentBackupOperationClaim,
  type AgentBackupOperationExecution,
  agentBackupObjectInventoryDigest,
  heartbeatAgentBackupOperation,
  transitionAgentBackupOperation,
} from "../../db/repositories/agent-backup-catalog";
import {
  type ListVerifiedPrimaryAgentBackupObjectsInput,
  listVerifiedPrimaryAgentBackupObjectsForReplication,
} from "../../db/repositories/agent-backup-publication";
import type { AgentBackupObject } from "../../db/schemas/agent-backup-catalog";
import type {
  AgentBackupCatalogState,
  StoredAgentSandboxBackup,
} from "../../db/schemas/agent-sandboxes";
import type { AgentBackupObjectStoreRegistry } from "../storage/agent-backup-object-store";
import { MAX_IMMUTABLE_SINGLE_PUT_BYTES } from "../storage/object-store";
import type { AgentBackupCatalogRuntimePublicationExecutor } from "./agent-backup-catalog-runtime";
import {
  type ExecuteAgentBackupObjectUploadInput,
  type ExecuteAgentBackupSecondaryObjectReplicationInput,
  executeAgentBackupObjectUpload,
  executeAgentBackupSecondaryObjectReplication,
} from "./agent-backup-catalog-worker";

const MAX_LEASE_MS = 5 * 60_000;
const MAX_TRANSFER_DEADLINE_MS = 5 * 60_000;
const DEFAULT_TRANSFER_DEADLINE_MS = 2 * 60_000;
const PUBLICATION_RESUME_STATES = [
  "captured",
  "uploading",
  "primary_uploaded",
  "primary_verified",
  "secondary_pending",
] as const satisfies readonly AgentBackupCatalogState[];

export interface AgentBackupCapturedPublicationChunk {
  component: string;
  chunkIndex: number;
  contentHmacSha256: string;
  ciphertextSha256: string;
  sizeBytes: number;
}

/** Durable capture-spool view used only for primary publication. */
export interface AgentBackupCapturedPublicationSource {
  readonly organizationId: string;
  readonly agentId: string;
  readonly backupId: string;
  readonly operationId: string;
  readonly manifestDigest: string;
  readonly objectInventoryDigest: string;
  readonly chunks: readonly AgentBackupCapturedPublicationChunk[];
  beginPrimaryPublication(): Promise<void>;
  /** Returns a fresh, exact, digest-verified buffer no larger than 32 MiB. */
  readCiphertextChunk(
    chunk: Readonly<AgentBackupCapturedPublicationChunk>,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  markPrimaryChunkUploaded(chunk: Readonly<AgentBackupCapturedPublicationChunk>): Promise<void>;
  markPrimaryPublished(): Promise<void>;
  /** Releases the spool lock; it must not remove durable replay data. */
  close(): Promise<void>;
}

export type ResolveAgentBackupCapturedPublicationSource = (input: {
  claim: Readonly<AgentBackupOperationClaim>;
  execution: Readonly<AgentBackupOperationExecution>;
  signal?: AbortSignal;
}) => Promise<AgentBackupCapturedPublicationSource>;

export interface AgentBackupPublicationExecutorConfig {
  scope: string;
  primaryEndpointAlias: string;
  secondaryEndpointAlias: string;
  /** Total wall-clock budget shared by primary writes and secondary replication. */
  objectTransferDeadlineMs?: number;
}

export interface AgentBackupPublicationExecutorDependencies {
  heartbeatOperation: typeof heartbeatAgentBackupOperation;
  transitionOperation: typeof transitionAgentBackupOperation;
  listVerifiedPrimaryObjects(
    input: Readonly<ListVerifiedPrimaryAgentBackupObjectsInput>,
  ): Promise<AgentBackupObject[]>;
  uploadObject(input: ExecuteAgentBackupObjectUploadInput): Promise<AgentBackupObject>;
  replicateObject(
    input: ExecuteAgentBackupSecondaryObjectReplicationInput,
  ): Promise<AgentBackupObject>;
  now(): number;
}

const DEFAULT_DEPENDENCIES: AgentBackupPublicationExecutorDependencies = {
  heartbeatOperation: heartbeatAgentBackupOperation,
  transitionOperation: transitionAgentBackupOperation,
  listVerifiedPrimaryObjects: listVerifiedPrimaryAgentBackupObjectsForReplication,
  uploadObject: executeAgentBackupObjectUpload,
  replicateObject: executeAgentBackupSecondaryObjectReplication,
  now: Date.now,
};

export class AgentBackupPublicationStageError extends ElizaError {
  override readonly name = "AgentBackupPublicationStageError";

  constructor(
    readonly operationState: (typeof PUBLICATION_RESUME_STATES)[number],
    readonly retryCode: "BACKUP_PRIMARY_PUBLICATION_RETRY" | "BACKUP_SECONDARY_REPLICATION_RETRY",
    message: string,
    cause: unknown,
  ) {
    super(message, {
      code: retryCode,
      cause,
      context: { operationState },
      severity: "ephemeral",
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function stageFailure(params: {
  state: AgentBackupPublicationStageError["operationState"];
  phase: "primary" | "secondary";
  cause: unknown;
}): AgentBackupPublicationStageError {
  if (params.cause instanceof AgentBackupPublicationStageError) return params.cause;
  return new AgentBackupPublicationStageError(
    params.state,
    params.phase === "primary"
      ? "BACKUP_PRIMARY_PUBLICATION_RETRY"
      : "BACKUP_SECONDARY_REPLICATION_RETRY",
    params.phase === "primary"
      ? "Primary backup publication did not reach its durable verification boundary"
      : "Secondary backup replication did not reach its durable verification boundary",
    params.cause,
  );
}

function operationIdentity(claim: Readonly<AgentBackupOperationClaim>): {
  organizationId: string;
  agentId: string;
  backupId: string;
  operationId: string;
  activationGeneration: string;
  lifecycleGeneration: string;
  lifecycleRevision: string;
} {
  const backup = claim.backup;
  if (
    !backup.catalog_organization_id ||
    !backup.catalog_agent_id ||
    !backup.backup_operation_id ||
    !backup.lifecycle_generation ||
    backup.lifecycle_revision === null
  ) {
    throw new ElizaError("Backup publication claim identity is incomplete", {
      code: "BACKUP_PUBLICATION_AUTHORITY_INCOMPLETE",
      severity: "fatal",
    });
  }
  return {
    organizationId: backup.catalog_organization_id,
    agentId: backup.catalog_agent_id,
    backupId: backup.id,
    operationId: backup.backup_operation_id,
    activationGeneration: backup.lifecycle_generation,
    lifecycleGeneration: backup.lifecycle_generation,
    lifecycleRevision: backup.lifecycle_revision.toString(),
  };
}

function execution(claim: Readonly<AgentBackupOperationClaim>): AgentBackupOperationExecution {
  return { ownerId: claim.ownerId, generation: claim.generation };
}

function transferDeadlineMs(value: number | undefined): number {
  const resolved = value ?? DEFAULT_TRANSFER_DEADLINE_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_TRANSFER_DEADLINE_MS) {
    throw new ElizaError("Backup publication transfer deadline is invalid", {
      code: "BACKUP_PUBLICATION_CONFIG_INVALID",
      severity: "fatal",
    });
  }
  return resolved;
}

function resolveTransferDeadline(params: {
  deadline?: Date;
  deadlineMs?: number;
  dependencies: AgentBackupPublicationExecutorDependencies;
}): Date {
  const now = params.dependencies.now();
  if (!Number.isSafeInteger(now) || now < 1) {
    throw new ElizaError("Backup publication clock is invalid", {
      code: "BACKUP_PUBLICATION_CLOCK_INVALID",
      severity: "fatal",
    });
  }
  if (params.deadline) {
    const deadline = params.deadline.getTime();
    if (
      !Number.isSafeInteger(deadline) ||
      deadline <= now ||
      deadline - now > MAX_TRANSFER_DEADLINE_MS
    ) {
      throw new ElizaError("Backup publication transfer deadline is invalid", {
        code: "BACKUP_PUBLICATION_CONFIG_INVALID",
        severity: "fatal",
      });
    }
    return new Date(deadline);
  }
  const duration = transferDeadlineMs(params.deadlineMs);
  if (now > Number.MAX_SAFE_INTEGER - duration) {
    throw new ElizaError("Backup publication clock is invalid", {
      code: "BACKUP_PUBLICATION_CLOCK_INVALID",
      severity: "fatal",
    });
  }
  return new Date(now + duration);
}

function requireLeaseMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LEASE_MS) {
    throw new ElizaError("Backup publication lease duration is invalid", {
      code: "BACKUP_PUBLICATION_CONFIG_INVALID",
      severity: "fatal",
    });
  }
}

async function heartbeat(params: {
  claim: Readonly<AgentBackupOperationClaim>;
  leaseMs: number;
  dependencies: AgentBackupPublicationExecutorDependencies;
  signal?: AbortSignal;
}): Promise<void> {
  params.signal?.throwIfAborted();
  const identity = operationIdentity(params.claim);
  await params.dependencies.heartbeatOperation({
    organizationId: identity.organizationId,
    backupId: identity.backupId,
    execution: execution(params.claim),
    leaseMs: params.leaseMs,
  });
  params.signal?.throwIfAborted();
}

async function transition(params: {
  claim: Readonly<AgentBackupOperationClaim>;
  expectedState: AgentBackupCatalogState;
  to: AgentBackupCatalogState;
  resumeState?: AgentBackupCatalogState;
  leaseMs: number;
  dependencies: AgentBackupPublicationExecutorDependencies;
  signal?: AbortSignal;
}): Promise<AgentBackupOperationClaim> {
  params.signal?.throwIfAborted();
  await heartbeat(params);
  params.signal?.throwIfAborted();
  const backup = await params.dependencies.transitionOperation({
    ...operationIdentity(params.claim),
    expectedState: params.expectedState,
    to: params.to,
    resumeState: params.resumeState,
    execution: execution(params.claim),
  });
  params.signal?.throwIfAborted();
  return { ...params.claim, backup };
}

async function resumePublicationClaim(params: {
  claim: Readonly<AgentBackupOperationClaim>;
  leaseMs: number;
  dependencies: AgentBackupPublicationExecutorDependencies;
  signal?: AbortSignal;
}): Promise<AgentBackupOperationClaim> {
  params.signal?.throwIfAborted();
  const state = params.claim.backup.catalog_state;
  if (state !== "failed_retryable") return { ...params.claim };
  const resumeState = params.claim.backup.catalog_resume_state;
  if (
    !resumeState ||
    !PUBLICATION_RESUME_STATES.includes(resumeState as (typeof PUBLICATION_RESUME_STATES)[number])
  ) {
    throw new ElizaError("Backup publication retry has no exact resumable state", {
      code: "BACKUP_PUBLICATION_RESUME_INVALID",
      severity: "fatal",
    });
  }
  return transition({
    ...params,
    expectedState: "failed_retryable",
    to: resumeState,
    resumeState,
  });
}

function canonicalChunks(
  chunks: readonly AgentBackupCapturedPublicationChunk[],
): AgentBackupCapturedPublicationChunk[] {
  const sorted = chunks
    .map((chunk) => ({ ...chunk }))
    .sort(
      (left, right) =>
        left.component.localeCompare(right.component) || left.chunkIndex - right.chunkIndex,
    );
  const seen = new Set<string>();
  for (const chunk of sorted) {
    const identity = `${chunk.component}:${chunk.chunkIndex}`;
    if (seen.has(identity)) {
      throw new ElizaError("Captured publication source contains a duplicate object slot", {
        code: "BACKUP_PUBLICATION_SOURCE_INVALID",
        severity: "fatal",
      });
    }
    seen.add(identity);
    if (
      !Number.isSafeInteger(chunk.sizeBytes) ||
      chunk.sizeBytes < 0 ||
      chunk.sizeBytes > MAX_IMMUTABLE_SINGLE_PUT_BYTES ||
      !/^[0-9a-f]{64}$/.test(chunk.contentHmacSha256) ||
      !/^[0-9a-f]{64}$/.test(chunk.ciphertextSha256)
    ) {
      throw new ElizaError("Captured publication source has invalid bounded chunk metadata", {
        code: "BACKUP_PUBLICATION_SOURCE_INVALID",
        severity: "fatal",
      });
    }
  }
  return sorted;
}

async function validatePublicationSource(params: {
  claim: Readonly<AgentBackupOperationClaim>;
  source: AgentBackupCapturedPublicationSource;
  signal?: AbortSignal;
}): Promise<AgentBackupCapturedPublicationChunk[]> {
  params.signal?.throwIfAborted();
  const identity = operationIdentity(params.claim);
  const backup = params.claim.backup;
  if (
    params.source.organizationId !== identity.organizationId ||
    params.source.agentId !== identity.agentId ||
    params.source.backupId !== identity.backupId ||
    params.source.operationId !== identity.operationId ||
    !backup.manifest_digest ||
    params.source.manifestDigest !== backup.manifest_digest ||
    !backup.object_inventory_digest ||
    params.source.objectInventoryDigest !== backup.object_inventory_digest ||
    !backup.manifest_object_count
  ) {
    throw new ElizaError("Captured publication source does not match catalogue authority", {
      code: "BACKUP_PUBLICATION_SOURCE_MISMATCH",
      severity: "fatal",
    });
  }
  const chunks = canonicalChunks(params.source.chunks);
  const inventoryDigest = await agentBackupObjectInventoryDigest(chunks);
  params.signal?.throwIfAborted();
  if (
    chunks.length !== backup.manifest_object_count ||
    inventoryDigest !== backup.object_inventory_digest
  ) {
    throw new ElizaError("Captured publication inventory does not match the manifest digest", {
      code: "BACKUP_PUBLICATION_SOURCE_MISMATCH",
      severity: "fatal",
    });
  }
  return chunks;
}

async function closeSource(
  source: AgentBackupCapturedPublicationSource,
  failure: unknown,
): Promise<void> {
  try {
    await source.close();
  } catch (closeFailure) {
    // error-policy:J2 spool ownership must not be silently lost. Preserve both
    // failures so the scheduler treats the outcome as indeterminate.
    if (failure !== undefined) {
      throw new AggregateError(
        [failure, closeFailure],
        "Backup publication and capture-source close both failed",
      );
    }
    throw closeFailure;
  }
  if (failure !== undefined) throw failure;
}

export interface ExecuteAgentBackupPrimaryPublicationInput {
  claim: Readonly<AgentBackupOperationClaim>;
  leaseMs: number;
  scope: string;
  primaryEndpointAlias: string;
  registry: AgentBackupObjectStoreRegistry;
  resolveSource: ResolveAgentBackupCapturedPublicationSource;
  dependencies?: AgentBackupPublicationExecutorDependencies;
  signal?: AbortSignal;
  objectTransferDeadlineMs?: number;
  /** Optional parent-owned deadline shared with secondary replication. */
  deadline?: Date;
}

/** Publish every captured chunk to primary R2 and verify the full inventory. */
export async function executeAgentBackupPrimaryPublication(
  input: Readonly<ExecuteAgentBackupPrimaryPublicationInput>,
): Promise<AgentBackupOperationClaim> {
  input.signal?.throwIfAborted();
  requireLeaseMs(input.leaseMs);
  const dependencies = input.dependencies ?? DEFAULT_DEPENDENCIES;
  const deadline = resolveTransferDeadline({
    deadline: input.deadline,
    deadlineMs: input.objectTransferDeadlineMs,
    dependencies,
  });
  input.signal?.throwIfAborted();
  let claim = await resumePublicationClaim({
    claim: input.claim,
    leaseMs: input.leaseMs,
    dependencies,
    signal: input.signal,
  });
  input.signal?.throwIfAborted();
  let state = claim.backup.catalog_state;
  if (state === "primary_verified" || state === "secondary_pending") return claim;
  if (state !== "captured" && state !== "uploading" && state !== "primary_uploaded") {
    throw new ElizaError("Primary publication received an unsupported catalogue state", {
      code: "BACKUP_PUBLICATION_STATE_INVALID",
      context: { state },
      severity: "fatal",
    });
  }
  // Validate all durable tenant/agent/lifecycle identity before opening a
  // filesystem-backed capture source.
  operationIdentity(claim);

  let source: AgentBackupCapturedPublicationSource;
  try {
    input.signal?.throwIfAborted();
    source = await input.resolveSource({
      claim,
      execution: execution(claim),
      signal: input.signal,
    });
  } catch (cause) {
    input.signal?.throwIfAborted();
    // error-policy:J2 source failures retain their durable spool and become an
    // exact-state retry without exposing filesystem or object-key details.
    throw stageFailure({ state, phase: "primary", cause });
  }

  let failure: unknown;
  try {
    input.signal?.throwIfAborted();
    const chunks = await validatePublicationSource({ claim, source, signal: input.signal });
    input.signal?.throwIfAborted();
    if (state === "captured") {
      try {
        input.signal?.throwIfAborted();
        claim = await transition({
          claim,
          expectedState: "captured",
          to: "uploading",
          leaseMs: input.leaseMs,
          dependencies,
          signal: input.signal,
        });
        input.signal?.throwIfAborted();
        state = "uploading";
      } catch (cause) {
        input.signal?.throwIfAborted();
        throw stageFailure({ state: "captured", phase: "primary", cause });
      }
    }
    input.signal?.throwIfAborted();
    await source.beginPrimaryPublication();
    input.signal?.throwIfAborted();
    if (state === "uploading") {
      const identity = operationIdentity(claim);
      for (const chunk of chunks) {
        input.signal?.throwIfAborted();
        await heartbeat({ claim, leaseMs: input.leaseMs, dependencies, signal: input.signal });
        input.signal?.throwIfAborted();
        let body: Uint8Array | undefined;
        try {
          input.signal?.throwIfAborted();
          body = await source.readCiphertextChunk(chunk, input.signal);
          input.signal?.throwIfAborted();
          if (body.byteLength !== chunk.sizeBytes) {
            throw new ElizaError("Capture spool returned a different encrypted byte length", {
              code: "BACKUP_PUBLICATION_SOURCE_MISMATCH",
              severity: "fatal",
            });
          }
          input.signal?.throwIfAborted();
          await dependencies.uploadObject({
            organizationId: identity.organizationId,
            backupId: identity.backupId,
            copyRole: "primary",
            component: chunk.component,
            chunkIndex: chunk.chunkIndex,
            endpointAlias: input.primaryEndpointAlias,
            contentHmacSha256: chunk.contentHmacSha256,
            ciphertextSha256: chunk.ciphertextSha256,
            execution: execution(claim),
            registry: input.registry,
            body,
            contentType: "application/octet-stream",
            signal: input.signal,
            deadline,
            revalidateLease: () =>
              heartbeat({ claim, leaseMs: input.leaseMs, dependencies, signal: input.signal }),
          });
          input.signal?.throwIfAborted();
          await source.markPrimaryChunkUploaded(chunk);
          input.signal?.throwIfAborted();
        } catch (cause) {
          input.signal?.throwIfAborted();
          // error-policy:J2 the static stage error preserves the underlying
          // provider/spool cause without exposing its key in the public message.
          throw stageFailure({ state: "uploading", phase: "primary", cause });
        } finally {
          body?.fill(0);
        }
        input.signal?.throwIfAborted();
        await heartbeat({ claim, leaseMs: input.leaseMs, dependencies, signal: input.signal });
        input.signal?.throwIfAborted();
      }
      input.signal?.throwIfAborted();
      claim = await transition({
        claim,
        expectedState: "uploading",
        to: "primary_uploaded",
        leaseMs: input.leaseMs,
        dependencies,
        signal: input.signal,
      });
      input.signal?.throwIfAborted();
    }
    try {
      input.signal?.throwIfAborted();
      await source.markPrimaryPublished();
      input.signal?.throwIfAborted();
    } catch (cause) {
      input.signal?.throwIfAborted();
      // error-policy:J2 the persisted primary objects remain replayable while
      // the exact primary_uploaded state retains source-journal reconciliation.
      throw stageFailure({ state: "primary_uploaded", phase: "primary", cause });
    }
    claim = await transition({
      claim,
      expectedState: "primary_uploaded",
      to: "primary_verified",
      leaseMs: input.leaseMs,
      dependencies,
      signal: input.signal,
    });
    input.signal?.throwIfAborted();
  } catch (cause) {
    failure = cause;
  }
  await closeSource(source, failure);
  input.signal?.throwIfAborted();
  return claim;
}

async function validatePrimaryInventory(params: {
  backup: StoredAgentSandboxBackup;
  objects: readonly AgentBackupObject[];
  signal?: AbortSignal;
}): Promise<AgentBackupObject[]> {
  params.signal?.throwIfAborted();
  if (!params.backup.manifest_object_count || !params.backup.object_inventory_digest) {
    throw new ElizaError("Secondary replication is missing manifest inventory authority", {
      code: "BACKUP_PUBLICATION_AUTHORITY_INCOMPLETE",
      severity: "fatal",
    });
  }
  const objects = [...params.objects].sort(
    (left, right) =>
      left.component.localeCompare(right.component) || left.chunk_index - right.chunk_index,
  );
  for (const object of objects) {
    if (
      object.organization_id !== params.backup.catalog_organization_id ||
      object.backup_id !== params.backup.id ||
      object.copy_role !== "primary" ||
      object.provider !== "cloudflare-r2" ||
      object.state !== "verified"
    ) {
      throw new ElizaError("Secondary source row does not match verified primary authority", {
        code: "BACKUP_PRIMARY_INVENTORY_MISMATCH",
        severity: "fatal",
      });
    }
  }
  const digest = await agentBackupObjectInventoryDigest(
    objects.map((object) => ({
      component: object.component,
      chunkIndex: object.chunk_index,
      contentHmacSha256: object.content_hmac_sha256,
      ciphertextSha256: object.ciphertext_sha256,
      sizeBytes: object.size_bytes,
    })),
  );
  params.signal?.throwIfAborted();
  if (
    objects.length !== params.backup.manifest_object_count ||
    digest !== params.backup.object_inventory_digest
  ) {
    throw new ElizaError("Verified primary rows do not match the manifest inventory", {
      code: "BACKUP_PRIMARY_INVENTORY_MISMATCH",
      severity: "fatal",
    });
  }
  return objects;
}

export interface ExecuteAgentBackupSecondaryReplicationInput {
  claim: Readonly<AgentBackupOperationClaim>;
  leaseMs: number;
  scope: string;
  secondaryEndpointAlias: string;
  registry: AgentBackupObjectStoreRegistry;
  objectTransferDeadlineMs?: number;
  dependencies?: AgentBackupPublicationExecutorDependencies;
  signal?: AbortSignal;
  /** Optional parent-owned deadline shared with primary publication. */
  deadline?: Date;
}

/** Replicate only from persisted exact R2 locators, then mark dual protection. */
export async function executeAgentBackupSecondaryReplication(
  input: Readonly<ExecuteAgentBackupSecondaryReplicationInput>,
): Promise<AgentBackupOperationClaim> {
  input.signal?.throwIfAborted();
  requireLeaseMs(input.leaseMs);
  const dependencies = input.dependencies ?? DEFAULT_DEPENDENCIES;
  const deadline = resolveTransferDeadline({
    deadline: input.deadline,
    deadlineMs: input.objectTransferDeadlineMs,
    dependencies,
  });
  input.signal?.throwIfAborted();
  let claim = await resumePublicationClaim({
    claim: input.claim,
    leaseMs: input.leaseMs,
    dependencies,
    signal: input.signal,
  });
  input.signal?.throwIfAborted();
  if (claim.backup.catalog_state === "primary_verified") {
    input.signal?.throwIfAborted();
    claim = await transition({
      claim,
      expectedState: "primary_verified",
      to: "secondary_pending",
      leaseMs: input.leaseMs,
      dependencies,
      signal: input.signal,
    });
    input.signal?.throwIfAborted();
  }
  if (claim.backup.catalog_state === "protected") return claim;
  if (claim.backup.catalog_state !== "secondary_pending") {
    throw new ElizaError("Secondary replication received an unsupported catalogue state", {
      code: "BACKUP_PUBLICATION_STATE_INVALID",
      context: { state: claim.backup.catalog_state },
      severity: "fatal",
    });
  }
  const identity = operationIdentity(claim);
  const manifestDigest = claim.backup.manifest_digest;
  if (!manifestDigest) {
    throw new ElizaError("Secondary replication is missing manifest digest authority", {
      code: "BACKUP_PUBLICATION_AUTHORITY_INCOMPLETE",
      severity: "fatal",
    });
  }
  let primaryObjects: AgentBackupObject[];
  try {
    input.signal?.throwIfAborted();
    await heartbeat({ claim, leaseMs: input.leaseMs, dependencies, signal: input.signal });
    input.signal?.throwIfAborted();
    primaryObjects = await dependencies.listVerifiedPrimaryObjects({
      ...identity,
      execution: execution(claim),
    });
    input.signal?.throwIfAborted();
    primaryObjects = await validatePrimaryInventory({
      backup: claim.backup,
      objects: primaryObjects,
      signal: input.signal,
    });
    input.signal?.throwIfAborted();
  } catch (cause) {
    input.signal?.throwIfAborted();
    // error-policy:J2 an unprovable persisted primary inventory remains in the
    // exact secondary_pending state for fenced retry.
    throw stageFailure({ state: "secondary_pending", phase: "secondary", cause });
  }

  for (const primaryObject of primaryObjects) {
    try {
      input.signal?.throwIfAborted();
      await heartbeat({ claim, leaseMs: input.leaseMs, dependencies, signal: input.signal });
      input.signal?.throwIfAborted();
      await dependencies.replicateObject({
        organizationId: identity.organizationId,
        backupId: identity.backupId,
        primaryObject,
        secondaryEndpointAlias: input.secondaryEndpointAlias,
        scope: input.scope,
        operationId: identity.operationId,
        manifestDigest,
        registry: input.registry,
        execution: execution(claim),
        revalidateLease: () =>
          heartbeat({ claim, leaseMs: input.leaseMs, dependencies, signal: input.signal }),
        signal: input.signal,
        deadline,
      });
      input.signal?.throwIfAborted();
      await heartbeat({ claim, leaseMs: input.leaseMs, dependencies, signal: input.signal });
      input.signal?.throwIfAborted();
    } catch (cause) {
      input.signal?.throwIfAborted();
      // error-policy:J2 provider/read failures stay key-free and retry from the
      // persisted exact primary locator; no capture source is available here.
      throw stageFailure({ state: "secondary_pending", phase: "secondary", cause });
    }
  }
  input.signal?.throwIfAborted();
  const protectedClaim = await transition({
    claim,
    expectedState: "secondary_pending",
    to: "protected",
    leaseMs: input.leaseMs,
    dependencies,
    signal: input.signal,
  });
  input.signal?.throwIfAborted();
  return protectedClaim;
}

export interface ExecuteAgentBackupPostCapturePublicationInput {
  claim: Readonly<AgentBackupOperationClaim>;
  leaseMs: number;
  config: Readonly<AgentBackupPublicationExecutorConfig>;
  registry: AgentBackupObjectStoreRegistry;
  resolveSource: ResolveAgentBackupCapturedPublicationSource;
  dependencies?: AgentBackupPublicationExecutorDependencies;
  signal?: AbortSignal;
}

/** Advance one owned post-capture claim as far as dual-provider protection. */
export async function executeAgentBackupPostCapturePublication(
  input: Readonly<ExecuteAgentBackupPostCapturePublicationInput>,
): Promise<AgentBackupOperationClaim> {
  input.signal?.throwIfAborted();
  const dependencies = input.dependencies ?? DEFAULT_DEPENDENCIES;
  const deadline = resolveTransferDeadline({
    deadlineMs: input.config.objectTransferDeadlineMs,
    dependencies,
  });
  input.signal?.throwIfAborted();
  const primary = await executeAgentBackupPrimaryPublication({
    claim: input.claim,
    leaseMs: input.leaseMs,
    scope: input.config.scope,
    primaryEndpointAlias: input.config.primaryEndpointAlias,
    registry: input.registry,
    resolveSource: input.resolveSource,
    dependencies,
    signal: input.signal,
    deadline,
  });
  input.signal?.throwIfAborted();
  const protectedClaim = await executeAgentBackupSecondaryReplication({
    claim: primary,
    leaseMs: input.leaseMs,
    scope: input.config.scope,
    secondaryEndpointAlias: input.config.secondaryEndpointAlias,
    registry: input.registry,
    dependencies,
    signal: input.signal,
    deadline,
  });
  input.signal?.throwIfAborted();
  return protectedClaim;
}

/** Bind post-capture authorities once for the bounded catalogue dispatcher. */
export function createAgentBackupCatalogPublicationExecutor(params: {
  config: Readonly<AgentBackupPublicationExecutorConfig>;
  registry: AgentBackupObjectStoreRegistry;
  resolveSource: ResolveAgentBackupCapturedPublicationSource;
  dependencies?: AgentBackupPublicationExecutorDependencies;
}): AgentBackupCatalogRuntimePublicationExecutor {
  return {
    async execute({ claim, leaseMs, signal }) {
      try {
        signal?.throwIfAborted();
        const completed = await executeAgentBackupPostCapturePublication({
          claim,
          leaseMs,
          config: params.config,
          registry: params.registry,
          resolveSource: params.resolveSource,
          dependencies: params.dependencies,
          signal,
        });
        signal?.throwIfAborted();
        if (completed.backup.catalog_state !== "protected") {
          throw new ElizaError("Backup publication did not reach protected", {
            code: "BACKUP_PUBLICATION_STATE_INVALID",
            severity: "fatal",
          });
        }
        return { state: "protected" };
      } catch (cause) {
        // error-policy:J1 only exact-state provider/source failures become a
        // scheduler retry; transition/response ambiguity remains thrown.
        if (cause instanceof AgentBackupPublicationStageError) {
          return {
            state: "retryable-failure",
            expectedState: cause.operationState,
            error: { code: cause.retryCode, message: cause.message },
          };
        }
        throw cause;
      }
    },
  };
}
