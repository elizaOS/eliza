/** Durable, tenant-scoped operations for the v2 sandbox-backup catalogue. */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  AGENT_BACKUP_MANIFEST_V2_LIMITS,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1,
  type AgentBackupManifestV2,
  type AgentBackupManifestV2Draft,
  type AgentBackupManifestV3,
  type AgentBackupManifestV3Draft,
  canonicalizeAgentBackupManifestV2,
  canonicalizeAgentBackupManifestV3,
  canonicalizeAgentBackupOperationKeyBundleContext,
  parseAgentBackupManifestV2,
  parseAgentBackupManifestV3,
} from "@elizaos/shared";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  assertAgentBackupCatalogTransition,
  boundedBackupCatalogError,
  catalogStateAllowsRestore,
  requireBoundedIdentity,
  requireSha256Hex,
} from "../../lib/services/agent-backup-catalog-state";
import { isValidUUID } from "../../lib/utils/validation";
import type { DbTransaction } from "../client";
import { sqlRows } from "../execute-helpers";
import { dbWrite } from "../helpers";
import {
  type AgentBackupCopyRole,
  type AgentBackupObject,
  type AgentBackupObjectProvider,
  type AgentBackupObjectTransport,
  agentBackupCatalogAuthorities,
  agentBackupObjects,
  agentBackupRestoreLeases,
} from "../schemas/agent-backup-catalog";
import {
  type AgentBackupCatalogState,
  type AgentBackupKind,
  type AgentBackupPlainStateData,
  type AgentBackupRetentionReason,
  type AgentBackupSnapshotType,
  type AgentBackupSourceProvider,
  agentSandboxBackups,
  agentSandboxes,
  type StoredAgentSandboxBackup,
} from "../schemas/agent-sandboxes";
import {
  AgentBackupSourceAuthorityError,
  requireCanonicalNodeIncarnation,
  requireCanonicalProviderServerId,
  resolveAgentBackupManifestSourceAuthorityInTransaction,
} from "./agent-backup-source-authority";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const EMPTY_BACKUP_STATE: AgentBackupPlainStateData = {
  memories: [],
  config: {},
  workspaceFiles: {},
};
const MAX_CATALOG_OBJECT_BYTES = 1024 * 1024 * 1024;
const MAX_CATALOG_BACKUP_BYTES = 1024 * 1024 * 1024;
const MAX_OPERATION_CLAIM_BATCH = 100;
const MAX_OPERATION_LEASE_MS = 5 * 60 * 1_000;
const MAX_INCREMENTAL_CHAIN_DEPTH = 20;

const EXECUTION_OWNED_STATES = [
  "scheduled",
  "capturing",
  "captured",
  "uploading",
  "primary_uploaded",
  "primary_verified",
  "secondary_pending",
  "failed_retryable",
] as const satisfies readonly AgentBackupCatalogState[];

export interface AgentBackupOperationExecution {
  ownerId: string;
  generation: string;
}

export interface AgentBackupOperationClaim extends AgentBackupOperationExecution {
  backup: StoredAgentSandboxBackup;
}

export class AgentBackupCatalogConflictError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "AgentBackupCatalogConflictError";
  }
}

function requireUuid(value: string, field: string): string {
  if (!isValidUUID(value)) throw new Error(`${field} must be a canonical UUID`);
  return value.toLowerCase();
}

function requireSafeBytes(value: number, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${field} must be a safe integer between 0 and ${max}`);
  }
  return value;
}

function requireCanonicalUint64(value: string, field: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be a canonical unsigned decimal integer`);
  }
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) {
    throw new Error(`${field} must fit uint64`);
  }
  return parsed;
}

async function createAndLockCatalogAuthority(
  tx: DbTransaction,
  organizationId: string,
  agentId: string,
): Promise<typeof agentBackupCatalogAuthorities.$inferSelect> {
  await tx
    .insert(agentBackupCatalogAuthorities)
    .values({
      organization_id: organizationId.toLowerCase(),
      agent_id: agentId.toLowerCase(),
    })
    .onConflictDoNothing();
  return lockAgentBackupCatalogAuthority(tx, organizationId, agentId);
}

/** Lock the existing per-agent catalogue authority before any revision CAS. */
export async function lockAgentBackupCatalogAuthority(
  tx: DbTransaction,
  organizationId: string,
  agentId: string,
): Promise<typeof agentBackupCatalogAuthorities.$inferSelect> {
  const [authority] = await tx
    .select()
    .from(agentBackupCatalogAuthorities)
    .where(
      and(
        eq(agentBackupCatalogAuthorities.organization_id, organizationId),
        eq(agentBackupCatalogAuthorities.agent_id, agentId),
      ),
    )
    .for("update")
    .limit(1);
  if (!authority) {
    throw new AgentBackupCatalogConflictError("Backup catalogue authority is missing");
  }
  return authority;
}

export async function advanceAgentBackupCatalogRevision(
  tx: DbTransaction,
  params: { organizationId: string; agentId: string; expectedRevision: bigint },
): Promise<bigint> {
  const [updated] = await tx
    .update(agentBackupCatalogAuthorities)
    .set({
      catalog_revision: sql`${agentBackupCatalogAuthorities.catalog_revision} + 1`,
      updated_at: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(agentBackupCatalogAuthorities.organization_id, params.organizationId),
        eq(agentBackupCatalogAuthorities.agent_id, params.agentId),
        eq(agentBackupCatalogAuthorities.catalog_revision, params.expectedRevision),
      ),
    )
    .returning({ catalogRevision: agentBackupCatalogAuthorities.catalog_revision });
  if (!updated) {
    throw new AgentBackupCatalogConflictError("Backup catalogue revision CAS lost");
  }
  return updated.catalogRevision;
}

export async function stampAgentBackupCatalogRevision(
  tx: DbTransaction,
  params: {
    backupId: string;
    organizationId: string;
    agentId: string;
    expectedRevision: bigint;
  },
): Promise<bigint> {
  const catalogRevision = await advanceAgentBackupCatalogRevision(tx, params);
  const [stamped] = await tx
    .update(agentSandboxBackups)
    .set({ catalog_revision: catalogRevision, catalog_updated_at: sql`NOW()` })
    .where(
      and(
        eq(agentSandboxBackups.id, params.backupId),
        eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
        eq(agentSandboxBackups.catalog_agent_id, params.agentId),
      ),
    )
    .returning({ id: agentSandboxBackups.id });
  if (!stamped) {
    throw new AgentBackupCatalogConflictError("Backup catalogue revision stamp was lost");
  }
  return catalogRevision;
}

function requireOperationExecution(execution: AgentBackupOperationExecution): void {
  requireBoundedIdentity(execution.ownerId, "execution.ownerId");
  requireUuid(execution.generation, "execution.generation");
}

async function assertOwnedOperationExecution(
  tx: DbTransaction,
  row: StoredAgentSandboxBackup,
  execution: AgentBackupOperationExecution,
): Promise<void> {
  requireOperationExecution(execution);
  const [owned] = await tx
    .select({ id: agentSandboxBackups.id })
    .from(agentSandboxBackups)
    .where(
      and(
        eq(agentSandboxBackups.id, row.id),
        eq(agentSandboxBackups.catalog_lease_owner, execution.ownerId),
        eq(agentSandboxBackups.catalog_lease_generation, execution.generation),
        gt(agentSandboxBackups.catalog_lease_expires_at, sql`NOW()`),
        sql`${agentSandboxBackups.sandbox_record_id} IS NOT NULL`,
      ),
    )
    .limit(1);
  if (!owned) {
    throw new AgentBackupCatalogConflictError(
      "Backup operation execution lease is absent, expired, or detached from its sandbox",
    );
  }
}

async function sha256Hex(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const stableBytes = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  stableBytes.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", stableBytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new AgentBackupCatalogConflictError(
        "Canonical backup authority contains a non-canonical number",
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new AgentBackupCatalogConflictError(
      "Canonical backup authority contains a non-JSON value",
    );
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function canonicalProjectionDigest(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

async function operationKeyBundleLocalReceiptDigest(input: {
  keyId: string;
  keyVersion: number;
  canonicalContext: string;
  wrappedKeyBundle: Uint8Array;
}): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      derivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
      format: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
      keyId: input.keyId,
      keyVersion: input.keyVersion,
      contextSha256: await sha256Hex(input.canonicalContext),
      wrappedKeyBundleSha256: await sha256Bytes(input.wrappedKeyBundle),
    }),
  );
}

export interface AgentBackupObjectInventoryEntry {
  component: string;
  chunkIndex: number;
  contentHmacSha256: string;
  ciphertextSha256: string;
  sizeBytes: number;
}

/** Canonical digest shared by the authenticated manifest and catalogue gate. */
export async function agentBackupObjectInventoryDigest(
  objects: readonly AgentBackupObjectInventoryEntry[],
): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      version: 2,
      objects: objects
        .map((object) => ({
          component: object.component,
          index: object.chunkIndex,
          contentHmac: object.contentHmacSha256,
          cipherSha: object.ciphertextSha256,
          encryptedBytes: object.sizeBytes,
        }))
        .sort((left, right) => {
          if (left.component < right.component) return -1;
          if (left.component > right.component) return 1;
          return left.index - right.index;
        }),
    }),
  );
}

function canonicalReservationPayload(input: ReserveAgentBackupOperationInput): string {
  return JSON.stringify({
    organizationId: input.organizationId.toLowerCase(),
    agentId: input.agentId.toLowerCase(),
    sandboxRecordId: input.sandboxRecordId.toLowerCase(),
    operationId: input.operationId.toLowerCase(),
    activationGeneration: input.activationGeneration.toLowerCase(),
    lifecycleRevision: input.lifecycleRevision,
    snapshotType: input.snapshotType,
    backupKind: input.backupKind,
    parentBackupId: input.parentBackupId?.toLowerCase() ?? null,
    baseBackupId: input.baseBackupId?.toLowerCase() ?? null,
    sourceProvider: input.sourceProvider,
    sourceNodeRecordId: input.sourceNodeRecordId.toLowerCase(),
    sourceNodeId: input.sourceNodeId,
    sourceNodeIncarnation: input.sourceNodeIncarnation,
    sourceProviderServerId: input.sourceProviderServerId,
    sourceProviderHandle: input.sourceProviderHandle,
    sourceContainerId: input.sourceContainerId,
    retentionReason: input.retentionReason,
    retentionUntil: input.retentionUntil.toISOString(),
  });
}

export interface ReserveAgentBackupOperationInput {
  organizationId: string;
  agentId: string;
  sandboxRecordId: string;
  operationId: string;
  activationGeneration: string;
  lifecycleRevision: string;
  snapshotType: AgentBackupSnapshotType;
  backupKind: AgentBackupKind;
  parentBackupId?: string;
  baseBackupId?: string;
  sourceProvider: AgentBackupSourceProvider;
  sourceNodeRecordId: string;
  sourceNodeId: string;
  sourceNodeIncarnation: string;
  sourceProviderServerId: string | null;
  sourceProviderHandle: string;
  sourceContainerId: string;
  retentionReason: AgentBackupRetentionReason;
  retentionUntil: Date;
}

function validateReservationInput(input: ReserveAgentBackupOperationInput): void {
  requireUuid(input.organizationId, "organizationId");
  requireUuid(input.agentId, "agentId");
  requireUuid(input.sandboxRecordId, "sandboxRecordId");
  requireUuid(input.operationId, "operationId");
  requireUuid(input.activationGeneration, "activationGeneration");
  requireCanonicalUint64(input.lifecycleRevision, "lifecycleRevision");
  requireUuid(input.sourceNodeRecordId, "sourceNodeRecordId");
  requireBoundedIdentity(input.sourceNodeId, "sourceNodeId");
  requireCanonicalNodeIncarnation(input.sourceNodeIncarnation);
  if (input.sourceProvider === "operator-onboarded") {
    if (input.sourceProviderServerId !== null) {
      throw new Error("Robot backup sourceProviderServerId must be null");
    }
  } else if (input.sourceProviderServerId === null) {
    throw new Error("Cloud backup sourceProviderServerId is required");
  } else {
    requireCanonicalProviderServerId(input.sourceProviderServerId);
  }
  requireBoundedIdentity(input.sourceProviderHandle, "sourceProviderHandle");
  if (!/^[0-9a-f]{64}$/.test(input.sourceContainerId)) {
    throw new Error("sourceContainerId must be a canonical immutable Docker ID");
  }
  if (input.sourceProviderHandle === input.sourceContainerId) {
    throw new Error("sourceProviderHandle and sourceContainerId must be distinct authorities");
  }
  if (!Number.isFinite(input.retentionUntil.getTime())) {
    throw new Error("retentionUntil must be a valid timestamp");
  }
  if (input.backupKind !== "full") {
    throw new AgentBackupCatalogConflictError(
      "Manifest-v3 catalogue capture is full-only until a real delta producer and compactor are available",
    );
  }
  if (input.parentBackupId !== undefined || input.baseBackupId !== undefined) {
    throw new Error("A full backup cannot reference parent/base backups");
  }
}

function assertReservationReplay(
  row: StoredAgentSandboxBackup,
  input: ReserveAgentBackupOperationInput,
  payloadDigest: string,
): void {
  const matches =
    row.backup_operation_id === input.operationId.toLowerCase() &&
    row.catalog_organization_id === input.organizationId.toLowerCase() &&
    row.catalog_agent_id === input.agentId.toLowerCase() &&
    row.sandbox_record_id === input.sandboxRecordId.toLowerCase() &&
    row.lifecycle_generation === input.activationGeneration.toLowerCase() &&
    row.lifecycle_revision === BigInt(input.lifecycleRevision) &&
    row.catalog_payload_digest === payloadDigest &&
    row.snapshot_type === input.snapshotType &&
    row.backup_kind === input.backupKind &&
    row.parent_backup_id === (input.parentBackupId?.toLowerCase() ?? null) &&
    row.base_backup_id === (input.baseBackupId?.toLowerCase() ?? null) &&
    row.source_provider === input.sourceProvider &&
    row.source_node_record_id === input.sourceNodeRecordId.toLowerCase() &&
    row.source_node_id === input.sourceNodeId &&
    row.source_node_incarnation === input.sourceNodeIncarnation &&
    row.source_provider_server_id === input.sourceProviderServerId &&
    row.source_provider_handle === input.sourceProviderHandle &&
    row.source_container_id === input.sourceContainerId &&
    row.retention_reason === input.retentionReason &&
    row.retention_until?.getTime() === input.retentionUntil.getTime();
  if (!matches) {
    throw new AgentBackupCatalogConflictError(
      "Backup operation ID was already reserved with a different immutable payload",
    );
  }
}

export async function reserveAgentBackupOperation(
  input: ReserveAgentBackupOperationInput,
): Promise<StoredAgentSandboxBackup> {
  return dbWrite.transaction((tx) => reserveAgentBackupOperationInTransaction(tx, input));
}

/**
 * Join the operation-backup first-lock order before a caller acquires sandbox,
 * source-node, parent-chain, or catalogue-authority locks. A missing row is
 * safe because the catalogue authority serializes the later create path.
 */
export async function lockAgentBackupReservationReplayInTransaction(
  tx: DbTransaction,
  input: { organizationId: string; agentId: string; operationId: string },
): Promise<void> {
  const organizationId = requireUuid(input.organizationId, "organizationId");
  const agentId = requireUuid(input.agentId, "agentId");
  const operationId = requireUuid(input.operationId, "operationId");
  await tx
    .select({ id: agentSandboxBackups.id })
    .from(agentSandboxBackups)
    .where(
      and(
        eq(agentSandboxBackups.catalog_organization_id, organizationId),
        eq(agentSandboxBackups.catalog_agent_id, agentId),
        eq(agentSandboxBackups.backup_operation_id, operationId),
      ),
    )
    .for("update")
    .limit(1);
}

/**
 * Transaction-aware reservation used by lifecycle authorities that must make
 * the catalogue row and their owning operation visible in one commit. Callers
 * must acquire the operation-backup replay lock before any outer lock. This
 * function establishes operation-backup -> sandbox -> source-node -> parent
 * chain -> catalogue-authority order for callers without earlier locks.
 */
export async function reserveAgentBackupOperationInTransaction(
  tx: DbTransaction,
  input: ReserveAgentBackupOperationInput,
): Promise<StoredAgentSandboxBackup> {
  validateReservationInput(input);
  const payloadDigest = await sha256Hex(canonicalReservationPayload(input));

  // Replay joins the global lock order operation-backup -> sandbox ->
  // catalogue-authority, matching recordCapturedAgentBackupManifest (backup
  // before sandbox) so a replayed reserve cannot AB-BA a concurrent capture.
  // A missing row is safe: authority locking serializes repository creates
  // before the insert below is attempted.
  await lockAgentBackupReservationReplayInTransaction(tx, input);

  const [sandbox] = await tx
    .select({
      id: agentSandboxes.id,
      organizationId: agentSandboxes.organization_id,
      nodeId: agentSandboxes.node_id,
      sandboxId: agentSandboxes.sandbox_id,
      status: agentSandboxes.status,
      lifecycleRevision: sql<string>`${agentSandboxes.lifecycle_revision}::text`,
      activationGeneration: agentSandboxes.activation_generation,
      activationLifecycleRevision: sql<
        string | null
      >`${agentSandboxes.activation_lifecycle_revision}::text`,
      activationPhase: agentSandboxes.activation_phase,
      activationReceiptHash: agentSandboxes.activation_receipt_hash,
      activationContainerId: agentSandboxes.activation_container_id,
      activationNodeId: agentSandboxes.activation_node_id,
      activationImageDigest: agentSandboxes.activation_image_digest,
      activationBootId: agentSandboxes.activation_boot_id,
      activationAuthorityPublishedAt: agentSandboxes.activation_authority_published_at,
      activationDispatchedAt: agentSandboxes.activation_dispatched_at,
      activationCompletedAt: agentSandboxes.activation_completed_at,
    })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, input.sandboxRecordId))
    .for("update")
    .limit(1);
  if (!sandbox || sandbox.organizationId !== input.organizationId.toLowerCase()) {
    throw new AgentBackupCatalogConflictError("Sandbox backup owner does not match");
  }
  if (input.agentId.toLowerCase() !== sandbox.id) {
    throw new AgentBackupCatalogConflictError("Backup agent identity does not match sandbox");
  }
  const lifecycleRevision = requireCanonicalUint64(input.lifecycleRevision, "lifecycleRevision");
  if (
    sandbox.status !== "running" ||
    sandbox.activationPhase !== "active" ||
    sandbox.activationGeneration !== input.activationGeneration.toLowerCase() ||
    sandbox.lifecycleRevision !== input.lifecycleRevision ||
    sandbox.activationLifecycleRevision !== input.lifecycleRevision ||
    !sandbox.activationReceiptHash ||
    !sandbox.activationBootId ||
    !sandbox.activationImageDigest ||
    !sandbox.activationAuthorityPublishedAt ||
    !sandbox.activationDispatchedAt ||
    !sandbox.activationCompletedAt ||
    sandbox.nodeId !== input.sourceNodeId ||
    sandbox.activationNodeId !== input.sourceNodeId ||
    sandbox.sandboxId !== input.sourceProviderHandle ||
    sandbox.activationContainerId !== input.sourceContainerId
  ) {
    throw new AgentBackupCatalogConflictError("Backup source generation no longer matches");
  }
  let sourceAuthority;
  try {
    sourceAuthority = await resolveAgentBackupManifestSourceAuthorityInTransaction(tx, {
      nodeRecordId: input.sourceNodeRecordId,
      nodeId: input.sourceNodeId,
      nodeIncarnation: input.sourceNodeIncarnation,
      containerId: input.sourceContainerId,
    });
  } catch (cause) {
    if (cause instanceof AgentBackupSourceAuthorityError) {
      throw new AgentBackupCatalogConflictError(cause.message);
    }
    throw cause;
  }
  const sourceKind = input.sourceProvider === "operator-onboarded" ? "robot" : "cloud";
  const resolvedProviderServerId =
    sourceAuthority.kind === "cloud" ? sourceAuthority.providerServerId : null;
  if (
    sourceAuthority.kind !== sourceKind ||
    resolvedProviderServerId !== input.sourceProviderServerId
  ) {
    throw new AgentBackupCatalogConflictError(
      "Backup source node record or Robot/Cloud provider authority does not match",
    );
  }

  if (input.backupKind === "incremental") {
    const [directParent] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, input.parentBackupId as string),
          eq(agentSandboxBackups.catalog_organization_id, input.organizationId),
          eq(agentSandboxBackups.catalog_agent_id, input.agentId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !directParent ||
      !directParent.catalog_state ||
      !catalogStateAllowsRestore(directParent.catalog_state)
    ) {
      throw new AgentBackupCatalogConflictError("Incremental parent is not restorable");
    }
    const expectedBase =
      directParent.backup_kind === "full" ? directParent.id : directParent.base_backup_id;
    if (expectedBase !== input.baseBackupId?.toLowerCase()) {
      throw new AgentBackupCatalogConflictError("Incremental base does not match parent chain");
    }
    const seen = new Set<string>();
    let cursor = directParent;
    let parentDepth = 1;
    while (cursor.backup_kind === "incremental") {
      if (seen.has(cursor.id)) {
        throw new AgentBackupCatalogConflictError("Incremental backup chain contains a cycle");
      }
      seen.add(cursor.id);
      if (parentDepth + 1 >= MAX_INCREMENTAL_CHAIN_DEPTH) {
        throw new AgentBackupCatalogConflictError(
          `Incremental backup chain cannot exceed ${MAX_INCREMENTAL_CHAIN_DEPTH} rows`,
        );
      }
      if (!cursor.parent_backup_id) {
        throw new AgentBackupCatalogConflictError("Incremental ancestor has no parent");
      }
      const [ancestor] = await tx
        .select()
        .from(agentSandboxBackups)
        .where(
          and(
            eq(agentSandboxBackups.id, cursor.parent_backup_id),
            eq(agentSandboxBackups.catalog_organization_id, input.organizationId),
            eq(agentSandboxBackups.catalog_agent_id, input.agentId),
          ),
        )
        .for("update")
        .limit(1);
      if (!ancestor?.catalog_state || !catalogStateAllowsRestore(ancestor.catalog_state)) {
        throw new AgentBackupCatalogConflictError(
          "Incremental ancestor is missing or no longer restorable",
        );
      }
      cursor = ancestor;
      parentDepth += 1;
    }
    if (cursor.id !== input.baseBackupId?.toLowerCase()) {
      throw new AgentBackupCatalogConflictError("Incremental chain does not terminate at base");
    }
  }

  const reservationAuthority = await createAndLockCatalogAuthority(
    tx,
    input.organizationId,
    input.agentId,
  );
  const [inserted] = await tx
    .insert(agentSandboxBackups)
    .values({
      id: randomUUID(),
      sandbox_record_id: input.sandboxRecordId.toLowerCase(),
      snapshot_type: input.snapshotType,
      state_data: EMPTY_BACKUP_STATE,
      state_data_storage: "inline",
      size_bytes: 0,
      backup_kind: input.backupKind,
      parent_backup_id: input.parentBackupId?.toLowerCase() ?? null,
      base_backup_id: input.baseBackupId?.toLowerCase() ?? null,
      backup_operation_id: input.operationId.toLowerCase(),
      catalog_version: 2,
      catalog_state: "scheduled",
      catalog_payload_digest: payloadDigest,
      catalog_organization_id: input.organizationId.toLowerCase(),
      catalog_agent_id: input.agentId.toLowerCase(),
      lifecycle_generation: input.activationGeneration.toLowerCase(),
      lifecycle_revision: lifecycleRevision,
      source_provider: input.sourceProvider,
      source_node_record_id: input.sourceNodeRecordId.toLowerCase(),
      source_node_id: input.sourceNodeId,
      source_node_incarnation: input.sourceNodeIncarnation,
      source_provider_server_id: input.sourceProviderServerId,
      source_provider_handle: input.sourceProviderHandle,
      source_container_id: input.sourceContainerId,
      retention_reason: input.retentionReason,
      retention_until: input.retentionUntil,
      catalog_next_attempt_at: sql`NOW()`,
      catalog_updated_at: sql`NOW()`,
    })
    .onConflictDoNothing()
    .returning({ id: agentSandboxBackups.id });

  if (inserted) {
    const catalogRevision = await advanceAgentBackupCatalogRevision(tx, {
      organizationId: input.organizationId,
      agentId: input.agentId,
      expectedRevision: reservationAuthority.catalog_revision,
    });
    const [revisionStamped] = await tx
      .update(agentSandboxBackups)
      .set({ catalog_revision: catalogRevision })
      .where(
        and(eq(agentSandboxBackups.id, inserted.id), eq(agentSandboxBackups.catalog_revision, 0n)),
      )
      .returning({ id: agentSandboxBackups.id });
    if (!revisionStamped) {
      throw new AgentBackupCatalogConflictError(
        "Backup reservation lost its catalogue revision stamp",
      );
    }
  }

  const [row] = await tx
    .select()
    .from(agentSandboxBackups)
    .where(
      and(
        eq(agentSandboxBackups.catalog_organization_id, input.organizationId),
        eq(agentSandboxBackups.catalog_agent_id, input.agentId),
        eq(agentSandboxBackups.backup_operation_id, input.operationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!row) throw new Error("Backup operation reservation disappeared");
  assertReservationReplay(row, input, payloadDigest);
  const authority = await lockAgentBackupCatalogAuthority(tx, input.organizationId, input.agentId);
  if (row.catalog_revision > authority.catalog_revision) {
    throw new AgentBackupCatalogConflictError(
      "Backup reservation revision exceeds its catalogue authority",
    );
  }
  return row;
}

/**
 * Fairly claim at most one due operation per tenant. Every capture/upload
 * mutation must carry the returned owner+generation fence.
 */
export async function claimDueAgentBackupOperations(params: {
  ownerId: string;
  limit: number;
  leaseMs: number;
}): Promise<AgentBackupOperationClaim[]> {
  requireBoundedIdentity(params.ownerId, "ownerId");
  if (
    !Number.isSafeInteger(params.limit) ||
    params.limit < 1 ||
    params.limit > MAX_OPERATION_CLAIM_BATCH
  ) {
    throw new Error(`limit must be between 1 and ${MAX_OPERATION_CLAIM_BATCH}`);
  }
  if (
    !Number.isSafeInteger(params.leaseMs) ||
    params.leaseMs < 1 ||
    params.leaseMs > MAX_OPERATION_LEASE_MS
  ) {
    throw new Error(`leaseMs must be between 1 and ${MAX_OPERATION_LEASE_MS}`);
  }
  const generation = randomUUID();

  return dbWrite.transaction(async (tx) => {
    const candidates = await sqlRows<{ id: string }>(
      tx,
      sql`
        WITH fair AS MATERIALIZED (
          SELECT DISTINCT ON (backup.catalog_organization_id)
            backup.id,
            backup.catalog_organization_id,
            COALESCE(backup.catalog_next_attempt_at, backup.created_at) AS due_at,
            backup.created_at
          FROM ${agentSandboxBackups} AS backup
          WHERE backup.catalog_version = 2
            AND backup.sandbox_record_id IS NOT NULL
            AND backup.source_provider IN ('operator-onboarded', 'hetzner-cloud')
            AND backup.source_node_record_id IS NOT NULL
            AND backup.source_node_id IS NOT NULL
            AND backup.source_node_id <> ''
            AND backup.source_node_incarnation IS NOT NULL
            AND backup.source_provider_handle IS NOT NULL
            AND backup.source_provider_handle <> ''
            AND backup.source_container_id ~ '^[0-9a-f]{64}$'
            AND backup.source_provider_handle <> backup.source_container_id
            AND (
              (backup.source_provider = 'operator-onboarded'
                AND backup.source_provider_server_id IS NULL)
              OR
              (backup.source_provider = 'hetzner-cloud'
                AND CASE
                  WHEN backup.source_provider_server_id ~ '^[1-9][0-9]{0,19}$'
                    THEN backup.source_provider_server_id::numeric <= 18446744073709551615
                  ELSE FALSE
                END)
            )
            AND backup.catalog_state IN (
              'scheduled', 'capturing', 'captured', 'uploading',
              'primary_uploaded', 'primary_verified', 'secondary_pending',
              'failed_retryable'
            )
            AND (backup.catalog_next_attempt_at IS NULL OR backup.catalog_next_attempt_at <= NOW())
            AND (backup.catalog_lease_expires_at IS NULL OR backup.catalog_lease_expires_at <= NOW())
          ORDER BY backup.catalog_organization_id,
            COALESCE(backup.catalog_next_attempt_at, backup.created_at), backup.created_at
        )
        SELECT backup.id
        FROM ${agentSandboxBackups} AS backup
        JOIN fair ON fair.id = backup.id
        ORDER BY fair.due_at, fair.created_at, backup.id
        LIMIT ${params.limit}
        FOR UPDATE OF backup SKIP LOCKED
      `,
    );
    if (candidates.length === 0) return [];
    const claimed = await tx
      .update(agentSandboxBackups)
      .set({
        catalog_lease_owner: params.ownerId,
        catalog_lease_generation: generation,
        catalog_lease_expires_at: sql`NOW() + (${params.leaseMs} * INTERVAL '1 millisecond')`,
        catalog_updated_at: sql`NOW()`,
      })
      .where(
        and(
          inArray(
            agentSandboxBackups.id,
            candidates.map((candidate) => candidate.id),
          ),
          sql`${agentSandboxBackups.sandbox_record_id} IS NOT NULL`,
          sql`${agentSandboxBackups.source_provider} IN ('operator-onboarded', 'hetzner-cloud')`,
          sql`${agentSandboxBackups.source_node_record_id} IS NOT NULL`,
          sql`${agentSandboxBackups.source_node_id} IS NOT NULL
            AND ${agentSandboxBackups.source_node_id} <> ''`,
          sql`${agentSandboxBackups.source_node_incarnation} IS NOT NULL`,
          sql`${agentSandboxBackups.source_provider_handle} IS NOT NULL
            AND ${agentSandboxBackups.source_provider_handle} <> ''`,
          sql`${agentSandboxBackups.source_container_id} ~ '^[0-9a-f]{64}$'`,
          sql`${agentSandboxBackups.source_provider_handle}
            <> ${agentSandboxBackups.source_container_id}`,
          sql`(
            (${agentSandboxBackups.source_provider} = 'operator-onboarded'
              AND ${agentSandboxBackups.source_provider_server_id} IS NULL)
            OR
            (${agentSandboxBackups.source_provider} = 'hetzner-cloud'
              AND CASE
                WHEN ${agentSandboxBackups.source_provider_server_id} ~ '^[1-9][0-9]{0,19}$'
                  THEN ${agentSandboxBackups.source_provider_server_id}::numeric
                    <= 18446744073709551615
                ELSE FALSE
              END)
          )`,
          sql`(${agentSandboxBackups.catalog_lease_expires_at} IS NULL
            OR ${agentSandboxBackups.catalog_lease_expires_at} <= NOW())`,
        ),
      )
      .returning();
    return claimed.map((backup) => ({
      backup,
      ownerId: params.ownerId,
      generation,
    }));
  });
}

export async function heartbeatAgentBackupOperation(params: {
  organizationId: string;
  backupId: string;
  execution: AgentBackupOperationExecution;
  leaseMs: number;
}): Promise<StoredAgentSandboxBackup> {
  requireUuid(params.organizationId, "organizationId");
  requireUuid(params.backupId, "backupId");
  requireOperationExecution(params.execution);
  if (
    !Number.isSafeInteger(params.leaseMs) ||
    params.leaseMs < 1 ||
    params.leaseMs > MAX_OPERATION_LEASE_MS
  ) {
    throw new Error(`leaseMs must be between 1 and ${MAX_OPERATION_LEASE_MS}`);
  }
  const [updated] = await dbWrite
    .update(agentSandboxBackups)
    .set({
      catalog_lease_expires_at: sql`NOW() + (${params.leaseMs} * INTERVAL '1 millisecond')`,
      catalog_updated_at: sql`NOW()`,
    })
    .where(
      and(
        eq(agentSandboxBackups.id, params.backupId),
        eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
        eq(agentSandboxBackups.catalog_lease_owner, params.execution.ownerId),
        eq(agentSandboxBackups.catalog_lease_generation, params.execution.generation),
        gt(agentSandboxBackups.catalog_lease_expires_at, sql`NOW()`),
        sql`${agentSandboxBackups.sandbox_record_id} IS NOT NULL`,
        sql`${agentSandboxBackups.catalog_state} IN (${sql.join(
          EXECUTION_OWNED_STATES.map((state) => sql`${state}`),
          sql`, `,
        )})`,
      ),
    )
    .returning();
  if (!updated) {
    throw new AgentBackupCatalogConflictError(
      "Backup operation heartbeat lost its execution generation",
    );
  }
  return updated;
}

interface CapturedAgentBackupManifestCommon {
  /** Exact canonical manifest draft bytes (integrity.manifestSha256 omitted). */
  canonicalManifestDraft: string;
  format: string;
  version: number;
  digest: string;
  objectCount: number;
  objectInventoryDigest: string;
  imageDigest: string;
  databaseSchemaVersion: string;
  pluginSetDigest: string;
  watermarkDigest: string;
  rawSizeBytes: number;
  compressedSizeBytes: number;
  encryptedSizeBytes: number;
  kmsKeyId: string;
  kmsKeyVersion: number;
}

export interface CapturedAgentBackupManifestV2
  extends Omit<CapturedAgentBackupManifestCommon, "version"> {
  version: 2;
  wrappedDekCiphertextBase64: string;
  wrappedDekReceiptDigest: string;
  wrappedKeyBundleCiphertextBase64?: never;
  wrappedKeyBundleSha256?: never;
  wrappedKeyBundleLocalReceiptDigest?: never;
  wrappedKeyBundleGenerationId?: never;
  vaultKeyGenerationId?: never;
  vaultKeyAuthorityReceiptDigest?: never;
}

export interface CapturedAgentBackupManifestV3
  extends Omit<CapturedAgentBackupManifestCommon, "version"> {
  version: 3;
  wrappedDekCiphertextBase64?: never;
  wrappedDekReceiptDigest?: never;
  /** Exact 92-byte nonce || ciphertext || tag KMS envelope. */
  wrappedKeyBundleCiphertextBase64: string;
  wrappedKeyBundleSha256: string;
  wrappedKeyBundleLocalReceiptDigest: string;
  wrappedKeyBundleGenerationId: string;
  vaultKeyGenerationId: string;
  vaultKeyAuthorityReceiptDigest: string;
}

export type CapturedAgentBackupManifest =
  | CapturedAgentBackupManifestV2
  | CapturedAgentBackupManifestV3;

/** Temporary structural compatibility for the already-separated v2 producer. */
type CompatibleCapturedAgentBackupManifestV2 = CapturedAgentBackupManifestCommon & {
  wrappedDekCiphertextBase64: string;
  wrappedDekReceiptDigest: string;
  wrappedKeyBundleCiphertextBase64?: never;
  wrappedKeyBundleSha256?: never;
  wrappedKeyBundleLocalReceiptDigest?: never;
  wrappedKeyBundleGenerationId?: never;
  vaultKeyGenerationId?: never;
  vaultKeyAuthorityReceiptDigest?: never;
};

type CapturedAgentBackupManifestInput =
  | CapturedAgentBackupManifest
  | CompatibleCapturedAgentBackupManifestV2;

interface CapturedManifestEnvelopeColumns {
  wrapped_dek_ref: string | null;
  wrapped_dek_ciphertext_base64: string | null;
  wrapped_dek_sha256: string | null;
  wrapped_dek_size_bytes: number | null;
  wrapped_dek_receipt_digest: string | null;
  operation_key_bundle_generation_id: string | null;
  operation_key_bundle_format: string | null;
  operation_key_bundle_ref: string | null;
  operation_key_bundle_ciphertext_base64: string | null;
  operation_key_bundle_sha256: string | null;
  operation_key_bundle_size_bytes: number | null;
  operation_key_bundle_context: string | null;
  operation_key_bundle_context_derivation: string | null;
  operation_key_bundle_local_receipt_derivation: string | null;
  operation_key_bundle_local_receipt_digest: string | null;
  vault_key_generation_id: string | null;
  vault_key_authority_receipt_digest: string | null;
}

interface ValidatedCapturedManifest {
  parsed: AgentBackupManifestV2 | AgentBackupManifestV3;
  canonicalDraft: string;
  envelope: CapturedManifestEnvelopeColumns;
}

const V2_CAPTURE_FIELDS = ["wrappedDekCiphertextBase64", "wrappedDekReceiptDigest"] as const;
const V3_CAPTURE_FIELDS = [
  "wrappedKeyBundleCiphertextBase64",
  "wrappedKeyBundleSha256",
  "wrappedKeyBundleLocalReceiptDigest",
  "wrappedKeyBundleGenerationId",
  "vaultKeyGenerationId",
  "vaultKeyAuthorityReceiptDigest",
] as const;

function ownsField(value: object, field: PropertyKey): boolean {
  return Object.hasOwn(value, field);
}

function requireCapturedString(
  manifest: CapturedAgentBackupManifestInput,
  field: (typeof V2_CAPTURE_FIELDS)[number] | (typeof V3_CAPTURE_FIELDS)[number],
): string {
  const value: unknown = Reflect.get(manifest, field);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`manifest.${field} must be a non-empty string`);
  }
  return value;
}

function decodeCanonicalBase64(value: string, field: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength === 0 || bytes.toString("base64") !== value) {
    throw new AgentBackupCatalogConflictError(`${field} must be canonical base64`);
  }
  return bytes;
}

function withManifestDigest(draft: unknown, digest: string): unknown {
  if (typeof draft !== "object" || draft === null || Array.isArray(draft)) {
    throw new Error("manifest.canonicalManifestDraft must contain a JSON object");
  }
  const integrity = (draft as Record<string, unknown>).integrity;
  if (typeof integrity !== "object" || integrity === null || Array.isArray(integrity)) {
    throw new Error("manifest.canonicalManifestDraft must contain integrity metadata");
  }
  return {
    ...draft,
    integrity: { ...integrity, manifestSha256: digest },
  };
}

async function validateCapturedManifest(
  manifest: CapturedAgentBackupManifestInput,
): Promise<ValidatedCapturedManifest> {
  requireBoundedIdentity(manifest.format, "manifest.format");
  requireBoundedIdentity(manifest.imageDigest, "manifest.imageDigest");
  requireBoundedIdentity(manifest.databaseSchemaVersion, "manifest.databaseSchemaVersion");
  requireBoundedIdentity(manifest.kmsKeyId, "manifest.kmsKeyId");
  requireSha256Hex(manifest.digest, "manifest.digest");
  requireSha256Hex(manifest.objectInventoryDigest, "manifest.objectInventoryDigest");
  requireSha256Hex(manifest.pluginSetDigest, "manifest.pluginSetDigest");
  requireSha256Hex(manifest.watermarkDigest, "manifest.watermarkDigest");
  requireSafeBytes(manifest.rawSizeBytes, "manifest.rawSizeBytes", MAX_CATALOG_BACKUP_BYTES);
  requireSafeBytes(
    manifest.compressedSizeBytes,
    "manifest.compressedSizeBytes",
    MAX_CATALOG_BACKUP_BYTES,
  );
  requireSafeBytes(
    manifest.encryptedSizeBytes,
    "manifest.encryptedSizeBytes",
    MAX_CATALOG_BACKUP_BYTES,
  );
  requireSafeBytes(manifest.objectCount, "manifest.objectCount", 8_192);
  if (manifest.objectCount < 1) {
    throw new Error("manifest.objectCount must be between 1 and 8192");
  }
  if (manifest.version !== 2 && manifest.version !== 3) {
    throw new Error("manifest.version must be exactly 2 or 3");
  }
  if (!Number.isSafeInteger(manifest.kmsKeyVersion) || manifest.kmsKeyVersion < 1) {
    throw new Error("manifest.kmsKeyVersion must be a positive safe integer");
  }
  if (
    new TextEncoder().encode(manifest.canonicalManifestDraft).byteLength >
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxManifestBytes
  ) {
    throw new Error("manifest.canonicalManifestDraft exceeds the manifest byte limit");
  }
  let draft: unknown;
  try {
    draft = JSON.parse(manifest.canonicalManifestDraft);
  } catch (cause) {
    throw new Error("manifest.canonicalManifestDraft must be valid JSON", { cause });
  }
  const canonicalDraft =
    manifest.version === 2
      ? canonicalizeAgentBackupManifestV2(draft as AgentBackupManifestV2Draft)
      : canonicalizeAgentBackupManifestV3(draft as AgentBackupManifestV3Draft);
  if (canonicalDraft !== manifest.canonicalManifestDraft) {
    throw new Error(
      `manifest.canonicalManifestDraft must use canonical manifest-v${manifest.version} JSON`,
    );
  }
  const completeManifest = withManifestDigest(draft, manifest.digest);
  const parsed =
    manifest.version === 2
      ? await parseAgentBackupManifestV2(completeManifest)
      : await parseAgentBackupManifestV3(completeManifest);
  if (
    parsed.format !== manifest.format ||
    parsed.schemaVersion !== manifest.version ||
    parsed.integrity.manifestSha256 !== manifest.digest ||
    parsed.runtime.imageDigest !== manifest.imageDigest ||
    parsed.runtime.databaseSchemaVersion !== manifest.databaseSchemaVersion ||
    parsed.totals.plainBytes !== manifest.rawSizeBytes ||
    parsed.totals.compressedBytes !== manifest.compressedSizeBytes ||
    parsed.totals.encryptedBytes !== manifest.encryptedSizeBytes ||
    parsed.encryption.kms.keyId !== manifest.kmsKeyId ||
    parsed.encryption.kms.keyVersion !== manifest.kmsKeyVersion
  ) {
    throw new AgentBackupCatalogConflictError(
      `Captured manifest summary does not match its canonical manifest-v${manifest.version} authority`,
    );
  }
  const expectedPluginSetDigest = await canonicalProjectionDigest({
    version: 1,
    plugins: parsed.runtime.plugins,
  });
  const expectedWatermarkDigest = await canonicalProjectionDigest({
    version: 1,
    watermarks: parsed.watermarks,
  });
  if (
    manifest.pluginSetDigest !== expectedPluginSetDigest ||
    manifest.watermarkDigest !== expectedWatermarkDigest
  ) {
    throw new AgentBackupCatalogConflictError(
      `Captured manifest projection digests do not match canonical manifest-v${manifest.version} authority`,
    );
  }
  const inventory = parsed.components.flatMap((component) =>
    component.chunks.map((chunk) => ({
      component: component.name,
      chunkIndex: chunk.index,
      contentHmacSha256: chunk.contentHmacSha256,
      ciphertextSha256: chunk.sha256,
      sizeBytes: chunk.encryptedBytes,
    })),
  );
  if (
    inventory.length !== manifest.objectCount ||
    (await agentBackupObjectInventoryDigest(inventory)) !== manifest.objectInventoryDigest
  ) {
    throw new AgentBackupCatalogConflictError(
      `Captured object inventory does not match canonical manifest-v${manifest.version} chunks`,
    );
  }

  if (manifest.version === 2) {
    if (V3_CAPTURE_FIELDS.some((field) => ownsField(manifest, field))) {
      throw new AgentBackupCatalogConflictError(
        "Manifest-v2 capture cannot contain operation key-bundle fields",
      );
    }
    const wrappedDekCiphertextBase64 = requireCapturedString(
      manifest,
      "wrappedDekCiphertextBase64",
    );
    const wrappedDekReceiptDigest = requireCapturedString(manifest, "wrappedDekReceiptDigest");
    requireSha256Hex(wrappedDekReceiptDigest, "manifest.wrappedDekReceiptDigest");
    const wrappedDek = decodeCanonicalBase64(
      wrappedDekCiphertextBase64,
      "manifest.wrappedDekCiphertextBase64",
    );
    if (
      parsed.schemaVersion !== 2 ||
      wrappedDek.byteLength !== parsed.encryption.wrappedDek.bytes ||
      (await sha256Bytes(wrappedDek)) !== parsed.encryption.wrappedDek.sha256
    ) {
      throw new AgentBackupCatalogConflictError(
        "Wrapped DEK bytes do not match canonical manifest-v2 authority",
      );
    }
    return {
      parsed,
      canonicalDraft,
      envelope: {
        wrapped_dek_ref: parsed.encryption.wrappedDek.ref,
        wrapped_dek_ciphertext_base64: wrappedDekCiphertextBase64,
        wrapped_dek_sha256: parsed.encryption.wrappedDek.sha256,
        wrapped_dek_size_bytes: parsed.encryption.wrappedDek.bytes,
        wrapped_dek_receipt_digest: wrappedDekReceiptDigest,
        operation_key_bundle_generation_id: null,
        operation_key_bundle_format: null,
        operation_key_bundle_ref: null,
        operation_key_bundle_ciphertext_base64: null,
        operation_key_bundle_sha256: null,
        operation_key_bundle_size_bytes: null,
        operation_key_bundle_context: null,
        operation_key_bundle_context_derivation: null,
        operation_key_bundle_local_receipt_derivation: null,
        operation_key_bundle_local_receipt_digest: null,
        vault_key_generation_id: null,
        vault_key_authority_receipt_digest: null,
      },
    };
  }

  if (V2_CAPTURE_FIELDS.some((field) => ownsField(manifest, field))) {
    throw new AgentBackupCatalogConflictError(
      "Manifest-v3 capture cannot contain wrapped-DEK fields",
    );
  }
  if (parsed.schemaVersion !== 3) {
    throw new AgentBackupCatalogConflictError("Manifest-v3 parser returned the wrong version");
  }
  // This durable boundary has no trusted deployment-environment authority, so
  // local wrapping fails closed instead of being accepted outside development.
  if (parsed.encryption.kms.provider !== "steward") {
    throw new AgentBackupCatalogConflictError(
      "Durable Hetzner catalogue capture requires a Steward-wrapped manifest-v3 key bundle",
    );
  }
  const wrappedKeyBundleCiphertextBase64 = requireCapturedString(
    manifest,
    "wrappedKeyBundleCiphertextBase64",
  );
  const wrappedKeyBundleSha256 = requireCapturedString(manifest, "wrappedKeyBundleSha256");
  const wrappedKeyBundleLocalReceiptDigest = requireCapturedString(
    manifest,
    "wrappedKeyBundleLocalReceiptDigest",
  );
  const wrappedKeyBundleGenerationId = requireCapturedString(
    manifest,
    "wrappedKeyBundleGenerationId",
  );
  const vaultKeyGenerationId = requireCapturedString(manifest, "vaultKeyGenerationId");
  const vaultKeyAuthorityReceiptDigest = requireCapturedString(
    manifest,
    "vaultKeyAuthorityReceiptDigest",
  );
  requireUuid(wrappedKeyBundleGenerationId, "manifest.wrappedKeyBundleGenerationId");
  requireUuid(vaultKeyGenerationId, "manifest.vaultKeyGenerationId");
  requireSha256Hex(wrappedKeyBundleSha256, "manifest.wrappedKeyBundleSha256");
  requireSha256Hex(
    wrappedKeyBundleLocalReceiptDigest,
    "manifest.wrappedKeyBundleLocalReceiptDigest",
  );
  requireSha256Hex(vaultKeyAuthorityReceiptDigest, "manifest.vaultKeyAuthorityReceiptDigest");
  const operationKeyBundle = parsed.encryption.operationKeyBundle;
  const wrapped = operationKeyBundle.wrapped;
  const wrappedKeyBundle = decodeCanonicalBase64(
    wrappedKeyBundleCiphertextBase64,
    "manifest.wrappedKeyBundleCiphertextBase64",
  );
  const canonicalContext = canonicalizeAgentBackupOperationKeyBundleContext({
    organizationId: parsed.identity.organizationId,
    agentId: parsed.identity.agentId,
    activationGeneration: parsed.identity.activationGeneration,
    lifecycleRevision: parsed.identity.lifecycleRevision,
    operationId: parsed.operationId,
    keyBundleGenerationId: operationKeyBundle.generationId,
    sourceKind: parsed.source.kind,
    sourceProvider: parsed.source.provider,
    kmsProvider: parsed.encryption.kms.provider,
    keyId: parsed.encryption.kms.keyId,
    keyVersion: parsed.encryption.kms.keyVersion,
  });
  const computedBundleSha256 = await sha256Bytes(wrappedKeyBundle);
  const computedLocalReceiptDigest = await operationKeyBundleLocalReceiptDigest({
    keyId: parsed.encryption.kms.keyId,
    keyVersion: parsed.encryption.kms.keyVersion,
    canonicalContext,
    wrappedKeyBundle,
  });
  if (
    operationKeyBundle.format !== AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT ||
    wrapped.bytes !== AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.wrappedBytes ||
    wrappedKeyBundle.byteLength !== wrapped.bytes ||
    wrappedKeyBundleGenerationId !== operationKeyBundle.generationId ||
    wrappedKeyBundleSha256 !== wrapped.sha256 ||
    computedBundleSha256 !== wrapped.sha256 ||
    wrapped.contextDerivation !== AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION ||
    wrapped.localReceiptDerivation !== AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION ||
    wrappedKeyBundleLocalReceiptDigest !== wrapped.localReceiptDigest ||
    computedLocalReceiptDigest !== wrapped.localReceiptDigest ||
    vaultKeyGenerationId !== parsed.vaultKeyAuthority.generationId ||
    vaultKeyAuthorityReceiptDigest !== parsed.vaultKeyAuthority.receiptDigest
  ) {
    throw new AgentBackupCatalogConflictError(
      "Wrapped operation key bundle does not match canonical manifest-v3 authority",
    );
  }
  return {
    parsed,
    canonicalDraft,
    envelope: {
      wrapped_dek_ref: null,
      wrapped_dek_ciphertext_base64: null,
      wrapped_dek_sha256: null,
      wrapped_dek_size_bytes: null,
      wrapped_dek_receipt_digest: null,
      operation_key_bundle_generation_id: operationKeyBundle.generationId,
      operation_key_bundle_format: operationKeyBundle.format,
      operation_key_bundle_ref: wrapped.ref,
      operation_key_bundle_ciphertext_base64: wrappedKeyBundleCiphertextBase64,
      operation_key_bundle_sha256: wrapped.sha256,
      operation_key_bundle_size_bytes: wrapped.bytes,
      operation_key_bundle_context: canonicalContext,
      operation_key_bundle_context_derivation: wrapped.contextDerivation,
      operation_key_bundle_local_receipt_derivation: wrapped.localReceiptDerivation,
      operation_key_bundle_local_receipt_digest: wrapped.localReceiptDigest,
      vault_key_generation_id: parsed.vaultKeyAuthority.generationId,
      vault_key_authority_receipt_digest: parsed.vaultKeyAuthority.receiptDigest,
    },
  };
}

function capturedManifestMatches(
  row: StoredAgentSandboxBackup,
  manifest: CapturedAgentBackupManifestInput,
  validated: ValidatedCapturedManifest,
): boolean {
  return (
    row.manifest_format === manifest.format &&
    row.manifest_version === manifest.version &&
    row.manifest_digest === manifest.digest &&
    row.manifest_canonical_draft === manifest.canonicalManifestDraft &&
    row.manifest_object_count === manifest.objectCount &&
    row.object_inventory_digest === manifest.objectInventoryDigest &&
    row.image_digest === manifest.imageDigest &&
    row.database_schema_version === manifest.databaseSchemaVersion &&
    row.plugin_set_digest === manifest.pluginSetDigest &&
    row.watermark_digest === manifest.watermarkDigest &&
    row.raw_size_bytes === manifest.rawSizeBytes &&
    row.compressed_size_bytes === manifest.compressedSizeBytes &&
    row.encrypted_size_bytes === manifest.encryptedSizeBytes &&
    row.kms_key_id === manifest.kmsKeyId &&
    row.kms_key_version === manifest.kmsKeyVersion &&
    Object.entries(validated.envelope).every(
      ([field, value]) => row[field as keyof CapturedManifestEnvelopeColumns] === value,
    )
  );
}

async function resolveReservedManifestChainAuthority(
  tx: DbTransaction,
  row: StoredAgentSandboxBackup,
): Promise<AgentBackupManifestV3["chain"]> {
  if (row.backup_kind === "full") {
    return { kind: "full", baseOperationId: null, parentOperationId: null, depth: 0 };
  }
  if (
    !row.parent_backup_id ||
    !row.base_backup_id ||
    !row.catalog_organization_id ||
    !row.catalog_agent_id
  ) {
    throw new AgentBackupCatalogConflictError(
      "Canonical manifest chain does not match the incremental backup reservation",
    );
  }

  const seen = new Set<string>();
  let cursorId = row.parent_backup_id;
  let depth = 1;
  let directParentOperationId: string | null = null;
  let baseOperationId: string | null = null;
  for (;;) {
    if (seen.has(cursorId) || depth > MAX_INCREMENTAL_CHAIN_DEPTH) {
      throw new AgentBackupCatalogConflictError(
        "Incremental backup reservation contains an invalid chain",
      );
    }
    seen.add(cursorId);
    const [ancestor] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, cursorId),
          eq(agentSandboxBackups.catalog_organization_id, row.catalog_organization_id),
          eq(agentSandboxBackups.catalog_agent_id, row.catalog_agent_id),
        ),
      )
      .for("update")
      .limit(1);
    if (!ancestor?.backup_operation_id) {
      throw new AgentBackupCatalogConflictError(
        "Incremental backup reservation references a missing chain authority",
      );
    }
    directParentOperationId ??= ancestor.backup_operation_id;
    if (ancestor.backup_kind === "full") {
      if (ancestor.id !== row.base_backup_id) {
        throw new AgentBackupCatalogConflictError(
          "Incremental backup reservation does not terminate at its base",
        );
      }
      baseOperationId = ancestor.backup_operation_id;
      break;
    }
    if (!ancestor.parent_backup_id) {
      throw new AgentBackupCatalogConflictError(
        "Incremental backup reservation contains an ancestor without a parent",
      );
    }
    cursorId = ancestor.parent_backup_id;
    depth += 1;
  }

  if (!directParentOperationId || !baseOperationId) {
    throw new AgentBackupCatalogConflictError(
      "Incremental backup reservation has no complete operation chain",
    );
  }
  return {
    kind: "incremental",
    parentOperationId: directParentOperationId,
    baseOperationId,
    depth,
  };
}

async function assertCapturedManifestChainMatchesReservation(
  tx: DbTransaction,
  row: StoredAgentSandboxBackup,
  parsed: AgentBackupManifestV2 | AgentBackupManifestV3,
): Promise<void> {
  const expected = await resolveReservedManifestChainAuthority(tx, row);
  if (canonicalJson(parsed.chain) !== canonicalJson(expected)) {
    throw new AgentBackupCatalogConflictError(
      "Canonical manifest chain differs from its durable reservation",
    );
  }
}

/** Resolve the exact manifest chain for one currently owned capture operation. */
export async function loadAgentBackupManifestChainAuthority(params: {
  organizationId: string;
  backupId: string;
  operationId: string;
  execution: AgentBackupOperationExecution;
}): Promise<AgentBackupManifestV3["chain"]> {
  requireUuid(params.organizationId, "organizationId");
  requireUuid(params.backupId, "backupId");
  requireUuid(params.operationId, "operationId");
  return dbWrite.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, params.backupId),
          eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
          eq(agentSandboxBackups.backup_operation_id, params.operationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!row?.catalog_state || row.catalog_state !== "capturing") {
      throw new AgentBackupCatalogConflictError(
        "Manifest chain authority requires an owned capturing operation",
      );
    }
    await assertOwnedOperationExecution(tx, row, params.execution);
    return resolveReservedManifestChainAuthority(tx, row);
  });
}

export async function recordCapturedAgentBackupManifest(params: {
  organizationId: string;
  backupId: string;
  operationId: string;
  expectedActivationGeneration: string;
  expectedLifecycleRevision: string;
  execution: AgentBackupOperationExecution;
  manifest: CapturedAgentBackupManifestInput;
}): Promise<StoredAgentSandboxBackup> {
  requireUuid(params.organizationId, "organizationId");
  requireUuid(params.backupId, "backupId");
  requireUuid(params.operationId, "operationId");
  requireUuid(params.expectedActivationGeneration, "expectedActivationGeneration");
  const expectedLifecycleRevision = requireCanonicalUint64(
    params.expectedLifecycleRevision,
    "expectedLifecycleRevision",
  );
  const validatedManifest = await validateCapturedManifest(params.manifest);

  return dbWrite.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, params.backupId),
          eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
          eq(agentSandboxBackups.backup_operation_id, params.operationId),
          eq(agentSandboxBackups.lifecycle_generation, params.expectedActivationGeneration),
          eq(agentSandboxBackups.lifecycle_revision, expectedLifecycleRevision),
        ),
      )
      .for("update")
      .limit(1);
    if (!row?.catalog_state) throw new AgentBackupCatalogConflictError("Backup operation missing");
    await assertOwnedOperationExecution(tx, row, params.execution);
    if (
      !row.sandbox_record_id ||
      !row.catalog_organization_id ||
      !row.catalog_agent_id ||
      !row.source_node_record_id ||
      !row.source_node_id ||
      !row.source_node_incarnation ||
      !row.source_container_id
    ) {
      throw new AgentBackupCatalogConflictError(
        "Captured backup is missing its immutable source authority",
      );
    }
    const [sourceSandbox] = await tx
      .select({
        status: agentSandboxes.status,
        nodeId: agentSandboxes.node_id,
        sandboxId: agentSandboxes.sandbox_id,
        lifecycleRevision: sql<string>`${agentSandboxes.lifecycle_revision}::text`,
        activationGeneration: agentSandboxes.activation_generation,
        activationLifecycleRevision: sql<
          string | null
        >`${agentSandboxes.activation_lifecycle_revision}::text`,
        activationPhase: agentSandboxes.activation_phase,
        activationReceiptHash: agentSandboxes.activation_receipt_hash,
        activationContainerId: agentSandboxes.activation_container_id,
        activationNodeId: agentSandboxes.activation_node_id,
        activationImageDigest: agentSandboxes.activation_image_digest,
        activationBootId: agentSandboxes.activation_boot_id,
        activationAuthorityPublishedAt: agentSandboxes.activation_authority_published_at,
        activationDispatchedAt: agentSandboxes.activation_dispatched_at,
        activationCompletedAt: agentSandboxes.activation_completed_at,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, row.sandbox_record_id),
          eq(agentSandboxes.organization_id, row.catalog_organization_id),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !sourceSandbox ||
      sourceSandbox.status !== "running" ||
      sourceSandbox.activationPhase !== "active" ||
      sourceSandbox.activationGeneration !== row.lifecycle_generation ||
      sourceSandbox.lifecycleRevision !== params.expectedLifecycleRevision ||
      sourceSandbox.activationLifecycleRevision !== params.expectedLifecycleRevision ||
      !sourceSandbox.activationReceiptHash ||
      !sourceSandbox.activationBootId ||
      !sourceSandbox.activationAuthorityPublishedAt ||
      !sourceSandbox.activationDispatchedAt ||
      !sourceSandbox.activationCompletedAt ||
      sourceSandbox.nodeId !== row.source_node_id ||
      sourceSandbox.activationNodeId !== row.source_node_id ||
      sourceSandbox.sandboxId !== row.source_provider_handle ||
      sourceSandbox.activationContainerId !== row.source_container_id ||
      sourceSandbox.activationImageDigest !== validatedManifest.parsed.runtime.imageDigest
    ) {
      throw new AgentBackupCatalogConflictError(
        "Backup source activation changed before the manifest was recorded",
      );
    }
    let currentSourceAuthority;
    try {
      currentSourceAuthority = await resolveAgentBackupManifestSourceAuthorityInTransaction(tx, {
        nodeRecordId: row.source_node_record_id,
        nodeId: row.source_node_id,
        nodeIncarnation: row.source_node_incarnation,
        containerId: row.source_container_id,
      });
    } catch (cause) {
      if (cause instanceof AgentBackupSourceAuthorityError) {
        throw new AgentBackupCatalogConflictError(cause.message);
      }
      throw cause;
    }
    const currentProviderServerId =
      currentSourceAuthority.kind === "cloud" ? currentSourceAuthority.providerServerId : null;
    if (
      currentSourceAuthority.kind !==
        (row.source_provider === "operator-onboarded" ? "robot" : "cloud") ||
      currentProviderServerId !== row.source_provider_server_id
    ) {
      throw new AgentBackupCatalogConflictError(
        "Backup source node authority changed before the manifest was recorded",
      );
    }
    const expectedSourceKind = row.source_provider === "operator-onboarded" ? "robot" : "cloud";
    if (
      validatedManifest.parsed.operationId !== params.operationId.toLowerCase() ||
      validatedManifest.parsed.identity.organizationId !== params.organizationId.toLowerCase() ||
      validatedManifest.parsed.identity.agentId !== row.catalog_agent_id ||
      validatedManifest.parsed.identity.activationGeneration !==
        params.expectedActivationGeneration.toLowerCase() ||
      validatedManifest.parsed.identity.lifecycleRevision !== params.expectedLifecycleRevision ||
      validatedManifest.parsed.source.kind !== expectedSourceKind ||
      validatedManifest.parsed.source.nodeRecordId !== row.source_node_record_id ||
      validatedManifest.parsed.source.nodeId !== row.source_node_id ||
      validatedManifest.parsed.source.nodeIncarnation !== row.source_node_incarnation ||
      (validatedManifest.parsed.source.kind === "cloud"
        ? validatedManifest.parsed.source.providerServerId
        : null) !== row.source_provider_server_id ||
      validatedManifest.parsed.source.containerId !== row.source_container_id ||
      validatedManifest.parsed.runtime.imageDigest !== sourceSandbox.activationImageDigest ||
      validatedManifest.parsed.createdAt !== row.created_at.toISOString()
    ) {
      throw new AgentBackupCatalogConflictError(
        `Canonical manifest-v${validatedManifest.parsed.schemaVersion} identity or immutable source does not match reservation`,
      );
    }
    await assertCapturedManifestChainMatchesReservation(tx, row, validatedManifest.parsed);
    if (row.catalog_state === "captured") {
      if (!capturedManifestMatches(row, params.manifest, validatedManifest)) {
        throw new AgentBackupCatalogConflictError(
          "Backup operation was already captured with a different manifest",
        );
      }
      return row;
    }
    assertAgentBackupCatalogTransition({ from: row.catalog_state, to: "captured" });
    if (!row.catalog_organization_id || !row.catalog_agent_id) {
      throw new AgentBackupCatalogConflictError("Backup catalogue authority is missing");
    }
    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      row.catalog_organization_id,
      row.catalog_agent_id,
    );
    const catalogRevision = await advanceAgentBackupCatalogRevision(tx, {
      organizationId: row.catalog_organization_id,
      agentId: row.catalog_agent_id,
      expectedRevision: authority.catalog_revision,
    });
    const [updated] = await tx
      .update(agentSandboxBackups)
      .set({
        catalog_state: "captured",
        catalog_revision: catalogRevision,
        manifest_format: params.manifest.format,
        manifest_version: validatedManifest.parsed.schemaVersion,
        manifest_digest: params.manifest.digest,
        manifest_canonical_draft: validatedManifest.canonicalDraft,
        manifest_object_count: params.manifest.objectCount,
        object_inventory_digest: params.manifest.objectInventoryDigest,
        image_digest: params.manifest.imageDigest,
        database_schema_version: params.manifest.databaseSchemaVersion,
        plugin_set_digest: params.manifest.pluginSetDigest,
        watermark_digest: params.manifest.watermarkDigest,
        raw_size_bytes: params.manifest.rawSizeBytes,
        compressed_size_bytes: params.manifest.compressedSizeBytes,
        encrypted_size_bytes: params.manifest.encryptedSizeBytes,
        kms_key_id: params.manifest.kmsKeyId,
        kms_key_version: params.manifest.kmsKeyVersion,
        ...validatedManifest.envelope,
        catalog_updated_at: sql`NOW()`,
      })
      .where(
        and(
          eq(agentSandboxBackups.id, row.id),
          eq(agentSandboxBackups.catalog_state, row.catalog_state),
          isNull(agentSandboxBackups.manifest_digest),
        ),
      )
      .returning();
    if (!updated) throw new AgentBackupCatalogConflictError("Backup capture transition lost");
    return updated;
  });
}

async function assertTransitionEvidence(
  tx: DbTransaction,
  backupId: string,
  to: AgentBackupCatalogState,
): Promise<void> {
  if (to === "uploading") {
    const [row] = await tx
      .select({ digest: agentSandboxBackups.manifest_digest })
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, backupId))
      .limit(1);
    if (!row?.digest) throw new AgentBackupCatalogConflictError("Upload requires a manifest");
    return;
  }
  if (to === "primary_uploaded" || to === "primary_verified") {
    const [backup] = await tx
      .select({
        expectedCount: agentSandboxBackups.manifest_object_count,
        expectedDigest: agentSandboxBackups.object_inventory_digest,
      })
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, backupId))
      .limit(1);
    if (!backup?.expectedCount || !backup.expectedDigest) {
      throw new AgentBackupCatalogConflictError("Primary upload is missing manifest inventory");
    }
    const primaryObjects = await tx
      .select({
        component: agentBackupObjects.component,
        chunkIndex: agentBackupObjects.chunk_index,
        contentHmacSha256: agentBackupObjects.content_hmac_sha256,
        ciphertextSha256: agentBackupObjects.ciphertext_sha256,
        sizeBytes: agentBackupObjects.size_bytes,
      })
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.backup_id, backupId),
          eq(agentBackupObjects.copy_role, "primary"),
        ),
      );
    const inventoryDigest = await agentBackupObjectInventoryDigest(primaryObjects);
    if (
      primaryObjects.length !== backup.expectedCount ||
      inventoryDigest !== backup.expectedDigest
    ) {
      throw new AgentBackupCatalogConflictError(
        "Primary object inventory does not match the authenticated manifest",
      );
    }
    const [counts] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        incomplete: sql<number>`count(*) FILTER (
          WHERE ${agentBackupObjects.state} NOT IN ('present', 'verified')
        )::int`,
        unverified: sql<number>`count(*) FILTER (
          WHERE ${agentBackupObjects.state} <> 'verified'
        )::int`,
      })
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.backup_id, backupId),
          eq(agentBackupObjects.copy_role, "primary"),
        ),
      );
    if (!counts || counts.total < 1) {
      throw new AgentBackupCatalogConflictError("Primary upload has no catalogued objects");
    }
    if (to === "primary_uploaded" && counts.incomplete !== 0) {
      throw new AgentBackupCatalogConflictError("Primary upload still has incomplete objects");
    }
    if (to === "primary_verified" && counts.unverified !== 0) {
      throw new AgentBackupCatalogConflictError("Primary objects are not all verified");
    }
    return;
  }
  if (to === "protected") {
    const [coverage] = await sqlRows<{
      expectedCount: number | null;
      primaryCount: number;
      secondaryCount: number;
      missingSecondary: number;
      invalidSecondary: number;
    }>(
      tx,
      sql`
        SELECT
          backup.manifest_object_count AS "expectedCount",
          count(*)::int AS "primaryCount",
          count(*) FILTER (WHERE secondary_object.id IS NULL)::int AS "missingSecondary",
          (
            SELECT count(*)::int
            FROM ${agentBackupObjects} AS all_secondary
            WHERE all_secondary.backup_id = backup.id
              AND all_secondary.copy_role = 'secondary'
          ) AS "secondaryCount",
          (
            SELECT count(*)::int
            FROM ${agentBackupObjects} AS candidate_secondary
            WHERE candidate_secondary.backup_id = backup.id
              AND candidate_secondary.copy_role = 'secondary'
              AND (
                candidate_secondary.state <> 'verified'
                OR NOT EXISTS (
                  SELECT 1
                  FROM ${agentBackupObjects} AS exact_primary
                  WHERE exact_primary.backup_id = candidate_secondary.backup_id
                    AND exact_primary.organization_id = candidate_secondary.organization_id
                    AND exact_primary.component = candidate_secondary.component
                    AND exact_primary.chunk_index = candidate_secondary.chunk_index
                    AND exact_primary.copy_role = 'primary'
                    AND exact_primary.state = 'verified'
                    AND exact_primary.content_hmac_sha256 = candidate_secondary.content_hmac_sha256
                    AND exact_primary.ciphertext_sha256 = candidate_secondary.ciphertext_sha256
                    AND exact_primary.size_bytes = candidate_secondary.size_bytes
                )
              )
          ) AS "invalidSecondary"
        FROM ${agentSandboxBackups} AS backup
        JOIN ${agentBackupObjects} AS primary_object
          ON primary_object.backup_id = backup.id
        LEFT JOIN ${agentBackupObjects} AS secondary_object
          ON secondary_object.backup_id = primary_object.backup_id
          AND secondary_object.organization_id = primary_object.organization_id
          AND secondary_object.component = primary_object.component
          AND secondary_object.chunk_index = primary_object.chunk_index
          AND secondary_object.copy_role = 'secondary'
          AND secondary_object.state = 'verified'
          AND secondary_object.content_hmac_sha256 = primary_object.content_hmac_sha256
          AND secondary_object.ciphertext_sha256 = primary_object.ciphertext_sha256
          AND secondary_object.size_bytes = primary_object.size_bytes
        WHERE backup.id = ${backupId}
          AND primary_object.copy_role = 'primary'
          AND primary_object.state = 'verified'
        GROUP BY backup.id, backup.manifest_object_count
      `,
    );
    if (
      !coverage ||
      coverage.expectedCount == null ||
      coverage.primaryCount !== coverage.expectedCount ||
      coverage.secondaryCount !== coverage.expectedCount ||
      coverage.missingSecondary !== 0 ||
      coverage.invalidSecondary !== 0
    ) {
      throw new AgentBackupCatalogConflictError(
        "Backup cannot be protected until every primary object has a verified secondary copy",
      );
    }
  }
}

export async function transitionAgentBackupOperation(params: {
  organizationId: string;
  backupId: string;
  operationId: string;
  lifecycleGeneration: string;
  expectedState: AgentBackupCatalogState;
  to: AgentBackupCatalogState;
  resumeState?: AgentBackupCatalogState | null;
  execution?: AgentBackupOperationExecution;
}): Promise<StoredAgentSandboxBackup> {
  requireUuid(params.organizationId, "organizationId");
  requireUuid(params.backupId, "backupId");
  requireUuid(params.operationId, "operationId");
  requireUuid(params.lifecycleGeneration, "lifecycleGeneration");
  if (params.to === "restore_verified") {
    throw new Error("Restore verification is committed only by restore coordinator authority");
  }
  if (params.to === "deleting" || params.to === "deleted") {
    throw new Error("Deletion states are owned by the durable GC outbox");
  }
  if (params.to === "failed_retryable" || params.to === "failed_terminal") {
    throw new Error("Failure states require failAgentBackupOperation with bounded error evidence");
  }

  return dbWrite.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, params.backupId),
          eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
          eq(agentSandboxBackups.backup_operation_id, params.operationId),
          eq(agentSandboxBackups.lifecycle_generation, params.lifecycleGeneration),
        ),
      )
      .for("update")
      .limit(1);
    if (!row?.catalog_state) throw new AgentBackupCatalogConflictError("Backup operation missing");
    const executionOwned = EXECUTION_OWNED_STATES.includes(
      row.catalog_state as (typeof EXECUTION_OWNED_STATES)[number],
    );
    if (executionOwned) {
      if (!params.execution) {
        throw new AgentBackupCatalogConflictError(
          "Backup pipeline transition requires an owned execution lease",
        );
      }
      await assertOwnedOperationExecution(tx, row, params.execution);
    } else if (params.execution) {
      requireOperationExecution(params.execution);
    }
    if (row.catalog_state === params.to) {
      const isCompletedRetryResume =
        params.expectedState === "failed_retryable" &&
        params.resumeState === params.to &&
        row.catalog_resume_state === null;
      if (
        !isCompletedRetryResume &&
        (row.catalog_resume_state ?? null) !== (params.resumeState ?? null)
      ) {
        throw new AgentBackupCatalogConflictError(
          "Backup transition replay has a different retry state",
        );
      }
      return row;
    }
    if (row.catalog_state !== params.expectedState) {
      throw new AgentBackupCatalogConflictError(
        `Backup transition expected ${params.expectedState}, found ${row.catalog_state}`,
      );
    }
    if (
      row.catalog_state === "failed_retryable" &&
      (row.catalog_resume_state === null ||
        params.resumeState !== row.catalog_resume_state ||
        params.to !== row.catalog_resume_state)
    ) {
      throw new AgentBackupCatalogConflictError(
        "Retry must resume the exact state recorded by the failed operation",
      );
    }
    let expirationAuthority:
      | Awaited<ReturnType<typeof lockAgentBackupCatalogAuthority>>
      | undefined;
    if (params.to === "expiration_pending") {
      if (!row.catalog_organization_id || !row.catalog_agent_id) {
        throw new AgentBackupCatalogConflictError("Backup catalogue authority is missing");
      }
      expirationAuthority = await lockAgentBackupCatalogAuthority(
        tx,
        row.catalog_organization_id,
        row.catalog_agent_id,
      );
      const databaseNow = await readPostLockDatabaseNow(tx);
      const [retentionEligible] = await tx
        .select({ id: agentSandboxBackups.id })
        .from(agentSandboxBackups)
        .where(
          and(
            eq(agentSandboxBackups.id, row.id),
            lte(agentSandboxBackups.retention_until, databaseNow),
            sql`${agentSandboxBackups.retention_reason} <> 'legal-hold'`,
          ),
        )
        .limit(1);
      if (!retentionEligible) {
        throw new AgentBackupCatalogConflictError(
          row.retention_reason === "legal-hold"
            ? "A legal-hold backup requires an explicit hold-release authority before deletion"
            : "Backup retention has not expired according to the primary database clock",
        );
      }
      const [dependent] = await tx
        .select({ id: agentSandboxBackups.id })
        .from(agentSandboxBackups)
        .where(
          and(
            eq(agentSandboxBackups.catalog_version, 2),
            eq(agentSandboxBackups.catalog_organization_id, row.catalog_organization_id as string),
            eq(agentSandboxBackups.catalog_agent_id, row.catalog_agent_id as string),
            or(
              eq(agentSandboxBackups.parent_backup_id, row.id),
              eq(agentSandboxBackups.base_backup_id, row.id),
            ),
            sql`${agentSandboxBackups.catalog_state} IS DISTINCT FROM 'deleted'`,
            sql`NOT (
              ${agentSandboxBackups.catalog_state} = 'failed_terminal'
              AND NOT EXISTS (
                SELECT 1 FROM agent_backup_objects AS terminal_object
                WHERE terminal_object.backup_id = ${agentSandboxBackups.id}
              )
            )`,
          ),
        )
        .limit(1);
      if (dependent) {
        throw new AgentBackupCatalogConflictError(
          "Backup cannot expire before every dependent incremental is deleted",
        );
      }
      const [activeLease] = await tx
        .select({ id: agentBackupRestoreLeases.id })
        .from(agentBackupRestoreLeases)
        .where(
          and(
            eq(agentBackupRestoreLeases.organization_id, row.catalog_organization_id),
            eq(agentBackupRestoreLeases.agent_id, row.catalog_agent_id),
            eq(agentBackupRestoreLeases.backup_id, row.id),
            isNull(agentBackupRestoreLeases.released_at),
            gt(agentBackupRestoreLeases.expires_at, databaseNow),
          ),
        )
        .limit(1);
      if (activeLease) {
        throw new AgentBackupCatalogConflictError("Backup has an active restore lease");
      }
    }
    assertAgentBackupCatalogTransition({
      from: row.catalog_state,
      to: params.to,
      resumeState: params.resumeState,
    });
    await assertTransitionEvidence(tx, row.id, params.to);
    if (!row.catalog_organization_id || !row.catalog_agent_id) {
      throw new AgentBackupCatalogConflictError("Backup catalogue authority is missing");
    }
    const authority =
      expirationAuthority ??
      (await lockAgentBackupCatalogAuthority(
        tx,
        row.catalog_organization_id,
        row.catalog_agent_id,
      ));
    const catalogRevision = await advanceAgentBackupCatalogRevision(tx, {
      organizationId: row.catalog_organization_id,
      agentId: row.catalog_agent_id,
      expectedRevision: authority.catalog_revision,
    });
    const releasePipelineLease = params.to === "protected";
    const [updated] = await tx
      .update(agentSandboxBackups)
      .set({
        catalog_state: params.to,
        catalog_revision: catalogRevision,
        catalog_resume_state:
          params.to === "failed_retryable" || params.to === "failed_terminal"
            ? params.resumeState
            : null,
        catalog_last_error_code:
          params.to === "failed_retryable" || params.to === "failed_terminal"
            ? row.catalog_last_error_code
            : null,
        catalog_last_error:
          params.to === "failed_retryable" || params.to === "failed_terminal"
            ? row.catalog_last_error
            : null,
        catalog_next_attempt_at: null,
        catalog_lease_owner: releasePipelineLease ? null : row.catalog_lease_owner,
        catalog_lease_generation: releasePipelineLease ? null : row.catalog_lease_generation,
        catalog_lease_expires_at: releasePipelineLease ? null : row.catalog_lease_expires_at,
        catalog_updated_at: sql`NOW()`,
        primary_verified_at:
          params.to === "primary_verified"
            ? sql`COALESCE(${agentSandboxBackups.primary_verified_at}, NOW())`
            : row.primary_verified_at,
        secondary_verified_at:
          params.to === "protected"
            ? sql`COALESCE(${agentSandboxBackups.secondary_verified_at}, NOW())`
            : row.secondary_verified_at,
      })
      .where(
        and(
          eq(agentSandboxBackups.id, row.id),
          eq(agentSandboxBackups.catalog_state, row.catalog_state),
        ),
      )
      .returning();
    if (!updated) throw new AgentBackupCatalogConflictError("Backup transition lost its CAS");
    return updated;
  });
}

export async function failAgentBackupOperation(params: {
  organizationId: string;
  backupId: string;
  operationId: string;
  lifecycleGeneration: string;
  expectedState: Exclude<
    AgentBackupCatalogState,
    "legacy_unmigrated" | "failed_retryable" | "failed_terminal" | "deleting" | "deleted"
  >;
  terminal: boolean;
  error: { code: string; message: string };
  retryDelayMs?: number;
  execution: AgentBackupOperationExecution;
}): Promise<StoredAgentSandboxBackup> {
  requireUuid(params.organizationId, "organizationId");
  requireUuid(params.backupId, "backupId");
  requireUuid(params.operationId, "operationId");
  requireUuid(params.lifecycleGeneration, "lifecycleGeneration");
  const error = boundedBackupCatalogError(params.error);
  const target = params.terminal ? "failed_terminal" : "failed_retryable";
  const retryDelayMs = params.retryDelayMs ?? 0;
  if (
    (!params.terminal &&
      (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1 || retryDelayMs > 86_400_000)) ||
    (params.terminal && retryDelayMs !== 0)
  ) {
    throw new Error(
      params.terminal
        ? "A terminal backup failure cannot schedule a retry"
        : "retryDelayMs must be between 1 and 86400000",
    );
  }

  return dbWrite.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, params.backupId),
          eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
          eq(agentSandboxBackups.backup_operation_id, params.operationId),
          eq(agentSandboxBackups.lifecycle_generation, params.lifecycleGeneration),
        ),
      )
      .for("update")
      .limit(1);
    if (!row?.catalog_state) throw new AgentBackupCatalogConflictError("Backup operation missing");
    if (row.catalog_state === target) {
      if (
        row.catalog_resume_state !== params.expectedState ||
        row.catalog_last_error_code !== error.code ||
        row.catalog_last_error !== error.message
      ) {
        throw new AgentBackupCatalogConflictError("Backup failure replay does not match");
      }
      return row;
    }
    await assertOwnedOperationExecution(tx, row, params.execution);
    if (row.catalog_state !== params.expectedState) {
      throw new AgentBackupCatalogConflictError(
        `Backup failure expected ${params.expectedState}, found ${row.catalog_state}`,
      );
    }
    assertAgentBackupCatalogTransition({
      from: row.catalog_state,
      to: target,
      resumeState: row.catalog_state,
    });
    if (!row.catalog_organization_id || !row.catalog_agent_id) {
      throw new AgentBackupCatalogConflictError("Backup catalogue authority is missing");
    }
    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      row.catalog_organization_id,
      row.catalog_agent_id,
    );
    const catalogRevision = await advanceAgentBackupCatalogRevision(tx, {
      organizationId: row.catalog_organization_id,
      agentId: row.catalog_agent_id,
      expectedRevision: authority.catalog_revision,
    });
    const [updated] = await tx
      .update(agentSandboxBackups)
      .set({
        catalog_state: target,
        catalog_revision: catalogRevision,
        catalog_resume_state: row.catalog_state,
        catalog_attempts: sql`${agentSandboxBackups.catalog_attempts} + 1`,
        catalog_next_attempt_at: params.terminal
          ? null
          : sql`NOW() + (${retryDelayMs} * INTERVAL '1 millisecond')`,
        catalog_last_error_code: error.code,
        catalog_last_error: error.message,
        catalog_lease_owner: null,
        catalog_lease_generation: null,
        catalog_lease_expires_at: null,
        catalog_updated_at: sql`NOW()`,
      })
      .where(
        and(
          eq(agentSandboxBackups.id, row.id),
          eq(agentSandboxBackups.catalog_state, row.catalog_state),
        ),
      )
      .returning();
    if (!updated) throw new AgentBackupCatalogConflictError("Backup failure CAS lost");
    return updated;
  });
}

export interface ReserveAgentBackupObjectInput {
  organizationId: string;
  backupId: string;
  copyRole: AgentBackupCopyRole;
  component: string;
  chunkIndex: number;
  transport: AgentBackupObjectTransport;
  provider: AgentBackupObjectProvider;
  endpointAlias: string;
  endpointIdentityFingerprint: string;
  bucket: string;
  region: string;
  contentHmacSha256: string;
  ciphertextSha256: string;
  sizeBytes: number;
  execution: AgentBackupOperationExecution;
}

const AGENT_BACKUP_COMPONENT_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** The repository, never a caller, owns the tenant-scoped immutable key namespace. */
export function buildAgentBackupObjectKey(input: {
  organizationId: string;
  backupId: string;
  copyRole: AgentBackupCopyRole;
  component: string;
  chunkIndex: number;
}): string {
  const organizationId = requireUuid(input.organizationId, "organizationId");
  const backupId = requireUuid(input.backupId, "backupId");
  if (input.copyRole !== "primary" && input.copyRole !== "secondary") {
    throw new Error("copyRole must be primary or secondary");
  }
  if (!AGENT_BACKUP_COMPONENT_PATTERN.test(input.component)) {
    throw new Error("component must be a canonical backup component name");
  }
  requireSafeBytes(input.chunkIndex, "chunkIndex", 8_191);
  return [
    "agent-sandbox-backups",
    "v2",
    organizationId,
    backupId,
    input.copyRole,
    input.component,
    `${input.chunkIndex.toString().padStart(8, "0")}.bin`,
  ].join("/");
}

function assertObjectReplay(
  row: AgentBackupObject,
  input: ReserveAgentBackupObjectInput,
  objectKey: string,
): void {
  const matches =
    row.organization_id === input.organizationId.toLowerCase() &&
    row.backup_id === input.backupId.toLowerCase() &&
    row.copy_role === input.copyRole &&
    row.component === input.component &&
    row.chunk_index === input.chunkIndex &&
    row.transport === input.transport &&
    row.provider === input.provider &&
    row.endpoint_alias === input.endpointAlias &&
    row.endpoint_identity_fingerprint === input.endpointIdentityFingerprint &&
    row.bucket === input.bucket &&
    row.region === input.region &&
    row.object_key === objectKey &&
    row.content_hmac_sha256 === input.contentHmacSha256 &&
    row.ciphertext_sha256 === input.ciphertextSha256 &&
    row.size_bytes === input.sizeBytes;
  if (!matches) {
    throw new AgentBackupCatalogConflictError(
      "Backup object slot was already reserved with different immutable bytes or locator",
    );
  }
}

export async function reserveAgentBackupObject(
  input: ReserveAgentBackupObjectInput,
): Promise<AgentBackupObject> {
  requireUuid(input.organizationId, "organizationId");
  requireUuid(input.backupId, "backupId");
  requireBoundedIdentity(input.component, "component");
  requireBoundedIdentity(input.endpointAlias, "endpointAlias");
  if (!/^sha256:[0-9a-f]{64}$/.test(input.endpointIdentityFingerprint)) {
    throw new Error("endpointIdentityFingerprint must be a canonical SHA-256 fingerprint");
  }
  requireBoundedIdentity(input.bucket, "bucket");
  requireBoundedIdentity(input.region, "region");
  requireSha256Hex(input.contentHmacSha256, "contentHmacSha256");
  requireSha256Hex(input.ciphertextSha256, "ciphertextSha256");
  requireSafeBytes(input.chunkIndex, "chunkIndex", 8_191);
  requireSafeBytes(input.sizeBytes, "sizeBytes", MAX_CATALOG_OBJECT_BYTES);
  if (input.copyRole === "primary" && input.provider !== "cloudflare-r2") {
    throw new Error("Primary backup objects must use Cloudflare R2");
  }
  if (input.copyRole === "secondary" && input.provider !== "hetzner-object-storage") {
    throw new Error("Secondary backup objects must use Hetzner Object Storage");
  }
  const objectKey = buildAgentBackupObjectKey(input);
  const keyFingerprint = await sha256Hex(objectKey);

  return dbWrite.transaction(async (tx) => {
    const [backup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, input.backupId),
          eq(agentSandboxBackups.catalog_organization_id, input.organizationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!backup || !backup.catalog_state) {
      throw new AgentBackupCatalogConflictError("Backup catalogue operation missing");
    }
    await assertOwnedOperationExecution(tx, backup, input.execution);
    const roleStateAllowed =
      input.copyRole === "primary"
        ? backup.catalog_state === "captured" || backup.catalog_state === "uploading"
        : backup.catalog_state === "secondary_pending";
    if (!roleStateAllowed) {
      throw new AgentBackupCatalogConflictError(
        `${input.copyRole} backup object cannot be reserved while operation is ${backup.catalog_state}`,
      );
    }
    if (!backup.catalog_organization_id || !backup.catalog_agent_id) {
      throw new AgentBackupCatalogConflictError("Backup catalogue authority is missing");
    }
    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      backup.catalog_organization_id,
      backup.catalog_agent_id,
    );
    if (input.copyRole === "secondary") {
      const [primary] = await tx
        .select({
          state: agentBackupObjects.state,
          contentHmacSha256: agentBackupObjects.content_hmac_sha256,
          ciphertextSha256: agentBackupObjects.ciphertext_sha256,
          sizeBytes: agentBackupObjects.size_bytes,
        })
        .from(agentBackupObjects)
        .where(
          and(
            eq(agentBackupObjects.backup_id, input.backupId),
            eq(agentBackupObjects.organization_id, input.organizationId),
            eq(agentBackupObjects.copy_role, "primary"),
            eq(agentBackupObjects.component, input.component),
            eq(agentBackupObjects.chunk_index, input.chunkIndex),
          ),
        )
        .for("key share")
        .limit(1);
      if (
        primary?.state !== "verified" ||
        primary.contentHmacSha256 !== input.contentHmacSha256 ||
        primary.ciphertextSha256 !== input.ciphertextSha256 ||
        primary.sizeBytes !== input.sizeBytes
      ) {
        throw new AgentBackupCatalogConflictError(
          "Secondary object must exactly replicate a verified primary manifest chunk",
        );
      }
    }

    const [inserted] = await tx
      .insert(agentBackupObjects)
      .values({
        organization_id: input.organizationId.toLowerCase(),
        backup_id: input.backupId.toLowerCase(),
        copy_role: input.copyRole,
        component: input.component,
        chunk_index: input.chunkIndex,
        state: "reserved",
        transport: input.transport,
        provider: input.provider,
        endpoint_alias: input.endpointAlias,
        endpoint_identity_fingerprint: input.endpointIdentityFingerprint,
        bucket: input.bucket,
        region: input.region,
        object_key: objectKey,
        key_fingerprint: keyFingerprint,
        content_hmac_sha256: input.contentHmacSha256,
        ciphertext_sha256: input.ciphertextSha256,
        size_bytes: input.sizeBytes,
      })
      .onConflictDoNothing()
      .returning({ id: agentBackupObjects.id });
    const [row] = await tx
      .select()
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.backup_id, input.backupId),
          eq(agentBackupObjects.component, input.component),
          eq(agentBackupObjects.chunk_index, input.chunkIndex),
          eq(agentBackupObjects.copy_role, input.copyRole),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) throw new Error("Backup object reservation disappeared");
    assertObjectReplay(row, input, objectKey);
    if (inserted) {
      await stampAgentBackupCatalogRevision(tx, {
        backupId: backup.id,
        organizationId: backup.catalog_organization_id,
        agentId: backup.catalog_agent_id,
        expectedRevision: authority.catalog_revision,
      });
    }
    return row;
  });
}

/** Persist the provider-write intent before any external PUT can start. */
export async function markAgentBackupObjectUploading(params: {
  organizationId: string;
  objectId: string;
  execution: AgentBackupOperationExecution;
}): Promise<AgentBackupObject> {
  requireUuid(params.organizationId, "organizationId");
  requireUuid(params.objectId, "objectId");
  return dbWrite.transaction(async (tx) => {
    const [objectRef] = await tx
      .select({ backupId: agentBackupObjects.backup_id })
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.id, params.objectId),
          eq(agentBackupObjects.organization_id, params.organizationId),
        ),
      )
      .limit(1);
    if (!objectRef) throw new AgentBackupCatalogConflictError("Backup object missing");
    const [backup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, objectRef.backupId),
          eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!backup) throw new AgentBackupCatalogConflictError("Backup operation missing");
    await assertOwnedOperationExecution(tx, backup, params.execution);
    if (!backup.catalog_organization_id || !backup.catalog_agent_id) {
      throw new AgentBackupCatalogConflictError("Backup catalogue authority is missing");
    }
    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      backup.catalog_organization_id,
      backup.catalog_agent_id,
    );
    const [row] = await tx
      .select()
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.id, params.objectId),
          eq(agentBackupObjects.organization_id, params.organizationId),
          eq(agentBackupObjects.backup_id, objectRef.backupId),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) throw new AgentBackupCatalogConflictError("Backup object disappeared");
    if (
      (row.state === "uploading" || row.state === "present" || row.state === "verified") &&
      row.provider_write_started
    ) {
      return row;
    }
    if (row.state !== "reserved" || row.provider_write_started) {
      throw new AgentBackupCatalogConflictError(
        `Cannot start provider upload while object is ${row.state}`,
      );
    }
    const [updated] = await tx
      .update(agentBackupObjects)
      .set({
        state: "uploading",
        provider_write_started: true,
        updated_at: sql`NOW()`,
      })
      .where(
        and(
          eq(agentBackupObjects.id, row.id),
          eq(agentBackupObjects.state, "reserved"),
          eq(agentBackupObjects.provider_write_started, false),
        ),
      )
      .returning();
    if (!updated) throw new AgentBackupCatalogConflictError("Backup object upload-start CAS lost");
    await stampAgentBackupCatalogRevision(tx, {
      backupId: backup.id,
      organizationId: backup.catalog_organization_id,
      agentId: backup.catalog_agent_id,
      expectedRevision: authority.catalog_revision,
    });
    return updated;
  });
}

export async function recordAgentBackupObjectPresent(params: {
  organizationId: string;
  objectId: string;
  providerVersionId?: string | null;
  providerEtag?: string | null;
  providerChecksum?: string | null;
  uploadReceiptDigest: string;
  execution: AgentBackupOperationExecution;
}): Promise<AgentBackupObject> {
  requireUuid(params.organizationId, "organizationId");
  requireUuid(params.objectId, "objectId");
  requireSha256Hex(params.uploadReceiptDigest, "uploadReceiptDigest");
  if (params.providerVersionId)
    requireBoundedIdentity(params.providerVersionId, "providerVersionId");
  if (params.providerEtag) requireBoundedIdentity(params.providerEtag, "providerEtag");
  if (params.providerChecksum) requireBoundedIdentity(params.providerChecksum, "providerChecksum");
  if (!params.providerVersionId && !params.providerEtag && !params.providerChecksum) {
    throw new Error("A durable provider version, ETag, or checksum authority is required");
  }

  return dbWrite.transaction(async (tx) => {
    const [objectRef] = await tx
      .select({ backupId: agentBackupObjects.backup_id })
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.id, params.objectId),
          eq(agentBackupObjects.organization_id, params.organizationId),
        ),
      )
      .limit(1);
    if (!objectRef) throw new AgentBackupCatalogConflictError("Backup object missing");
    const [backup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, objectRef.backupId),
          eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!backup) throw new AgentBackupCatalogConflictError("Backup operation missing");
    await assertOwnedOperationExecution(tx, backup, params.execution);
    if (!backup.catalog_organization_id || !backup.catalog_agent_id) {
      throw new AgentBackupCatalogConflictError("Backup catalogue authority is missing");
    }
    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      backup.catalog_organization_id,
      backup.catalog_agent_id,
    );
    const [row] = await tx
      .select()
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.id, params.objectId),
          eq(agentBackupObjects.organization_id, params.organizationId),
          eq(agentBackupObjects.backup_id, objectRef.backupId),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) throw new AgentBackupCatalogConflictError("Backup object disappeared");
    const versionId = params.providerVersionId ?? null;
    const etag = params.providerEtag ?? null;
    const checksum = params.providerChecksum ?? null;
    if (row.state === "present" || row.state === "verified") {
      if (
        !row.provider_write_started ||
        row.provider_version_id !== versionId ||
        row.provider_etag !== etag ||
        row.provider_checksum !== checksum ||
        row.upload_receipt_digest !== params.uploadReceiptDigest
      ) {
        throw new AgentBackupCatalogConflictError(
          "Backup object upload receipt replay does not match the immutable provider object",
        );
      }
      return row;
    }
    if (row.state !== "uploading" || !row.provider_write_started) {
      throw new AgentBackupCatalogConflictError(
        `Cannot record upload while object is ${row.state}`,
      );
    }
    const [updated] = await tx
      .update(agentBackupObjects)
      .set({
        state: "present",
        provider_version_id: versionId,
        provider_etag: etag,
        provider_checksum: checksum,
        upload_receipt_digest: params.uploadReceiptDigest,
        updated_at: sql`NOW()`,
      })
      .where(and(eq(agentBackupObjects.id, row.id), eq(agentBackupObjects.state, row.state)))
      .returning();
    if (!updated) throw new AgentBackupCatalogConflictError("Backup object upload CAS lost");
    await stampAgentBackupCatalogRevision(tx, {
      backupId: backup.id,
      organizationId: backup.catalog_organization_id,
      agentId: backup.catalog_agent_id,
      expectedRevision: authority.catalog_revision,
    });
    return updated;
  });
}

export async function markAgentBackupObjectVerified(params: {
  organizationId: string;
  objectId: string;
  uploadReceiptDigest: string;
  execution: AgentBackupOperationExecution;
}): Promise<AgentBackupObject> {
  requireUuid(params.organizationId, "organizationId");
  requireUuid(params.objectId, "objectId");
  requireSha256Hex(params.uploadReceiptDigest, "uploadReceiptDigest");
  return dbWrite.transaction(async (tx) => {
    const [objectRef] = await tx
      .select({ backupId: agentBackupObjects.backup_id })
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.id, params.objectId),
          eq(agentBackupObjects.organization_id, params.organizationId),
        ),
      )
      .limit(1);
    if (!objectRef) throw new AgentBackupCatalogConflictError("Backup object missing");
    const [backup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, objectRef.backupId),
          eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!backup) throw new AgentBackupCatalogConflictError("Backup operation missing");
    await assertOwnedOperationExecution(tx, backup, params.execution);
    if (!backup.catalog_organization_id || !backup.catalog_agent_id) {
      throw new AgentBackupCatalogConflictError("Backup catalogue authority is missing");
    }
    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      backup.catalog_organization_id,
      backup.catalog_agent_id,
    );
    const [object] = await tx
      .select()
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.id, params.objectId),
          eq(agentBackupObjects.organization_id, params.organizationId),
          eq(agentBackupObjects.backup_id, backup.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!object || object.upload_receipt_digest !== params.uploadReceiptDigest) {
      throw new AgentBackupCatalogConflictError(
        "Backup object verification is missing its exact upload receipt",
      );
    }
    if (object.state === "verified") return object;
    if (object.state !== "present") {
      throw new AgentBackupCatalogConflictError(
        `Cannot verify backup object while it is ${object.state}`,
      );
    }
    const [updated] = await tx
      .update(agentBackupObjects)
      .set({
        state: "verified",
        verified_at: sql`COALESCE(${agentBackupObjects.verified_at}, NOW())`,
        updated_at: sql`NOW()`,
      })
      .where(
        and(
          eq(agentBackupObjects.id, params.objectId),
          eq(agentBackupObjects.organization_id, params.organizationId),
          eq(agentBackupObjects.upload_receipt_digest, params.uploadReceiptDigest),
          sql`${agentBackupObjects.state} IN ('present', 'verified')`,
        ),
      )
      .returning();
    if (!updated) {
      throw new AgentBackupCatalogConflictError(
        "Backup object verification is missing its exact upload receipt",
      );
    }
    await stampAgentBackupCatalogRevision(tx, {
      backupId: backup.id,
      organizationId: backup.catalog_organization_id,
      agentId: backup.catalog_agent_id,
      expectedRevision: authority.catalog_revision,
    });
    return updated;
  });
}
