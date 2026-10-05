/**
 * Durable authority for the restore phases after quarantine creation:
 * container_created -> restoring -> committed -> restart_attested -> probed ->
 * published -> finalized.
 *
 * Every writer re-locks the operation, then its lease, then the sandbox (the
 * shared restore lock order) and requires the caller's live claim. Evidence is
 * recorded write-once in `serving_state`, so a lost response replays instead
 * of re-executing a remote effect. Only `publishAgentBackupRestoreRoute`
 * changes the agent's canonical route; before it, the previous route is never
 * touched, and after it, rollback no longer applies.
 */

import { createHash, randomUUID } from "node:crypto";
import { AgentBackupRestoreV3CandidateReceiptSchema } from "@elizaos/contracts";
import {
  AgentBackupRestoreV3AttestationBodySchema,
  AgentBackupRestoreV3CommittedGenerationSchema,
  AgentBackupRestoreV3RootIdentitiesSchema,
  canonicalizeAgentBackupRestoreV3ServingValue,
} from "@elizaos/contracts/node";
import { and, asc, eq, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { runtimeIdentitySchema } from "../../lib/services/sandbox-runtime-observation";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import {
  type AgentBackupRestoreOperation,
  type AgentBackupRestorePhase,
  agentBackupRestoreLeases,
  agentBackupRestoreOperations,
} from "../schemas/agent-backup-catalog";
import {
  agentActivationPublications,
  agentVaultKeySeedReceipts,
} from "../schemas/agent-backup-restore-history";
import { agentSandboxReplacementAttempts } from "../schemas/agent-sandbox-replacement-attempts";
import {
  type AgentActivationReceipt,
  type AgentSandbox,
  agentSandboxes,
} from "../schemas/agent-sandboxes";
import { dockerNodes, PLACEABLE_NODE_STATE } from "../schemas/docker-nodes";
import { AgentBackupCatalogConflictError } from "./agent-backup-catalog";
import {
  type AgentSandboxReplacementLocatorInput,
  beginAgentSandboxExactRestoreCleanupForLockedAuthoritiesInTransaction,
  finishAgentSandboxExactRestoreCleanupForLockedAuthoritiesInTransaction,
} from "./agent-sandbox-replacement-attempts";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TERMINAL_PHASES = ["finalized", "failed_terminal"] as const;

function conflict(message: string): never {
  throw new AgentBackupCatalogConflictError(message);
}

function requireUuid(value: string, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    conflict(`${field} must be a canonical lowercase UUID`);
  }
  return value;
}

function requireSha256(value: string, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    conflict(`${field} must be a lowercase sha256 digest`);
  }
  return value;
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeAgentBackupRestoreV3ServingValue(value), "utf8")
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Serving-state evidence
// ---------------------------------------------------------------------------

const RouteSnapshotSchema = z.strictObject({
  status: z.string().min(1),
  sandboxId: z.string().nullable(),
  nodeId: z.string().nullable(),
  containerName: z.string().nullable(),
  bridgePort: z.number().int().nullable(),
  webUiPort: z.number().int().nullable(),
  bridgeUrl: z.string().nullable(),
  healthUrl: z.string().nullable(),
  headscaleIp: z.string().nullable(),
  dockerImage: z.string().nullable(),
  imageDigest: z.string().nullable(),
  /** Exact previous container; null when the agent had no live runtime. */
  runtime: runtimeIdentitySchema.nullable(),
});
export type AgentBackupRestorePreviousRoute = z.infer<typeof RouteSnapshotSchema>;

export const AgentBackupRestoreServingStateSchema = z.strictObject({
  roots: AgentBackupRestoreV3RootIdentitiesSchema.optional(),
  candidate: z
    .strictObject({
      session: z.record(z.string(), z.unknown()),
      receipt: AgentBackupRestoreV3CandidateReceiptSchema,
      receiptSha256: z.string().regex(SHA256),
    })
    .optional(),
  generation: AgentBackupRestoreV3CommittedGenerationSchema.optional(),
  previousRoute: RouteSnapshotSchema.optional(),
  serving: z
    .strictObject({
      bridgePort: z.number().int().min(1).max(65_535),
      webUiPort: z.number().int().min(1).max(65_535),
      containerPort: z.number().int().min(1).max(65_535),
    })
    .optional(),
  bootGrantSha256: z.string().regex(SHA256).optional(),
  attestation: z
    .strictObject({
      digest: z.string().regex(SHA256),
      mac: z.string().regex(SHA256),
      body: AgentBackupRestoreV3AttestationBodySchema,
    })
    .optional(),
  probe: z
    .strictObject({
      digest: z.string().regex(SHA256),
      count: z.number().int().min(1),
    })
    .optional(),
  publicationId: z.string().regex(UUID).optional(),
  routePublication: z
    .strictObject({
      lifecycleReceiptDigest: z.string().regex(SHA256),
    })
    .optional(),
  previousRuntimeRetired: z
    .strictObject({
      receiptDigest: z.string().regex(SHA256),
    })
    .optional(),
  finalReceiptId: z.string().regex(UUID).optional(),
});
export type AgentBackupRestoreServingState = z.infer<typeof AgentBackupRestoreServingStateSchema>;
export type AgentBackupRestoreServingStateKey = keyof AgentBackupRestoreServingState;

export function readAgentBackupRestoreServingState(
  operation: Readonly<Pick<AgentBackupRestoreOperation, "serving_state">>,
): AgentBackupRestoreServingState {
  const parsed = AgentBackupRestoreServingStateSchema.safeParse(operation.serving_state ?? {});
  if (!parsed.success) conflict("Restore serving state is malformed");
  return parsed.data;
}

/** Merge write-once keys; an existing key must carry identical canonical bytes. */
function mergeWriteOnce(
  current: AgentBackupRestoreServingState,
  patch: Readonly<AgentBackupRestoreServingState>,
): { next: AgentBackupRestoreServingState; changed: boolean } {
  const next: Record<string, unknown> = { ...current };
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = (current as Record<string, unknown>)[key];
    if (existing === undefined) {
      next[key] = value;
      changed = true;
    } else if (
      canonicalizeAgentBackupRestoreV3ServingValue(existing) !==
      canonicalizeAgentBackupRestoreV3ServingValue(value)
    ) {
      conflict(`Restore serving evidence ${key} is write-once and differs from its replay`);
    }
  }
  const parsed = AgentBackupRestoreServingStateSchema.safeParse(next);
  if (!parsed.success) conflict("Restore serving state patch is malformed");
  return { next: parsed.data, changed };
}

// ---------------------------------------------------------------------------
// Shared locking
// ---------------------------------------------------------------------------

export interface AgentBackupRestoreServingClaim {
  readonly operationId: string;
  readonly ownerId: string;
  readonly claimGeneration: string;
}

interface LockedServingAuthority {
  readonly operation: AgentBackupRestoreOperation;
  readonly sandbox: AgentSandbox;
  readonly databaseNow: Date;
}

async function lockClaimedServingAuthority(
  tx: DbTransaction,
  claim: Readonly<AgentBackupRestoreServingClaim>,
  phase: AgentBackupRestorePhase,
): Promise<LockedServingAuthority> {
  requireUuid(claim.operationId, "operationId");
  requireUuid(claim.claimGeneration, "claimGeneration");
  const [operation] = await tx
    .select()
    .from(agentBackupRestoreOperations)
    .where(eq(agentBackupRestoreOperations.id, claim.operationId))
    .for("update")
    .limit(1);
  if (!operation) conflict("Restore operation is missing");
  const [lease] = await tx
    .select()
    .from(agentBackupRestoreLeases)
    .where(
      and(
        eq(agentBackupRestoreLeases.id, operation.lease_id),
        eq(agentBackupRestoreLeases.organization_id, operation.organization_id),
        eq(agentBackupRestoreLeases.generation, operation.lease_generation),
      ),
    )
    .for("update")
    .limit(1);
  if (!lease) conflict("Restore lease fence was lost");
  const [sandbox] = await tx
    .select()
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, operation.agent_id),
        eq(agentSandboxes.organization_id, operation.organization_id),
      ),
    )
    .for("update")
    .limit(1);
  if (!sandbox) conflict("Restore sandbox authority is missing");
  const databaseNow = await readPostLockDatabaseNow(tx);
  if (lease.released_at !== null || lease.expires_at <= databaseNow) {
    conflict("Restore lease is expired or released");
  }
  if (
    operation.phase !== phase ||
    operation.claim_owner !== claim.ownerId ||
    operation.claim_generation !== claim.claimGeneration ||
    operation.claim_expires_at === null ||
    operation.claim_expires_at <= databaseNow
  ) {
    conflict(`Restore ${phase} claim is not live`);
  }
  if (
    operation.expected_container_id === null ||
    operation.expected_node_record_id === null ||
    operation.expected_node_incarnation === null ||
    operation.expected_node_history_id === null ||
    operation.expected_image_digest === null
  ) {
    conflict("Restore serving requires complete container and target authority");
  }
  if (
    sandbox.activation_generation !== operation.restore_attempt_id ||
    sandbox.activation_purpose !== "restore" ||
    sandbox.activation_backup_id !== operation.backup_id ||
    sandbox.activation_container_id !== operation.expected_container_id ||
    sandbox.activation_boot_id !== operation.expected_node_incarnation ||
    sandbox.deleted_at !== null
  ) {
    conflict("Restore sandbox activation authority diverged from its operation");
  }
  return { operation, sandbox, databaseNow };
}

/** Load the restore's exact container authority under a live claim (read-only). */
export async function loadClaimedAgentBackupRestoreServingAuthority(
  claim: Readonly<AgentBackupRestoreServingClaim>,
  phase: AgentBackupRestorePhase,
): Promise<
  Readonly<{
    operation: Readonly<AgentBackupRestoreOperation>;
    sandbox: Readonly<AgentSandbox>;
    state: AgentBackupRestoreServingState;
  }>
> {
  return dbWrite.transaction(async (tx) => {
    const locked = await lockClaimedServingAuthority(tx, claim, phase);
    return Object.freeze({
      operation: Object.freeze(locked.operation),
      sandbox: Object.freeze(locked.sandbox),
      state: readAgentBackupRestoreServingState(locked.operation),
    });
  });
}

/**
 * Record write-once serving evidence under a live claim without changing the
 * phase or consuming the claim. Exact replays are accepted; changed bytes are
 * a conflict.
 */
export async function recordAgentBackupRestoreServingEvidence(
  input: Readonly<
    AgentBackupRestoreServingClaim & {
      phase: AgentBackupRestorePhase;
      patch: AgentBackupRestoreServingState;
    }
  >,
): Promise<Readonly<{ state: AgentBackupRestoreServingState; replayed: boolean }>> {
  return dbWrite.transaction(async (tx) => {
    const { operation } = await lockClaimedServingAuthority(tx, input, input.phase);
    const current = readAgentBackupRestoreServingState(operation);
    const { next, changed } = mergeWriteOnce(current, input.patch);
    if (!changed) return Object.freeze({ state: current, replayed: true });
    const [updated] = await tx
      .update(agentBackupRestoreOperations)
      .set({ serving_state: next })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operation.id),
          eq(agentBackupRestoreOperations.phase, input.phase),
          eq(agentBackupRestoreOperations.claim_generation, input.claimGeneration),
        ),
      )
      .returning({ id: agentBackupRestoreOperations.id });
    if (!updated) conflict("Restore serving evidence lost its CAS");
    return Object.freeze({ state: next, replayed: false });
  });
}

const SERVING_ADVANCE_REQUIREMENTS: Readonly<
  Partial<
    Record<
      AgentBackupRestorePhase,
      { to: AgentBackupRestorePhase; keys: readonly AgentBackupRestoreServingStateKey[] }
    >
  >
> = Object.freeze({
  container_created: { to: "restoring", keys: ["roots", "candidate"] },
  restoring: { to: "committed", keys: ["roots", "candidate", "generation"] },
  restart_attested: { to: "probed", keys: ["attestation", "probe"] },
});

/**
 * Advance one evidence-only phase and consume the claim. The next phase is
 * unreachable unless its required write-once evidence is already durable.
 */
export async function advanceAgentBackupRestoreServingPhase(
  input: Readonly<AgentBackupRestoreServingClaim & { from: AgentBackupRestorePhase }>,
): Promise<Readonly<AgentBackupRestoreOperation>> {
  const requirement = SERVING_ADVANCE_REQUIREMENTS[input.from];
  if (!requirement) conflict(`Restore phase ${input.from} has no evidence-only successor`);
  return dbWrite.transaction(async (tx) => {
    const { operation } = await lockClaimedServingAuthority(tx, input, input.from);
    const state = readAgentBackupRestoreServingState(operation);
    for (const key of requirement.keys) {
      if (state[key] === undefined) {
        conflict(`Restore ${input.from} cannot advance without ${key} evidence`);
      }
    }
    const [advanced] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        phase: requirement.to,
        resume_phase: null,
        claim_owner: null,
        claim_generation: null,
        claim_expires_at: null,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operation.id),
          eq(agentBackupRestoreOperations.phase, input.from),
          eq(agentBackupRestoreOperations.claim_generation, input.claimGeneration),
        ),
      )
      .returning();
    if (!advanced) conflict("Restore serving phase advance lost its CAS");
    return Object.freeze(advanced);
  });
}

// ---------------------------------------------------------------------------
// committed -> restart_attested
// ---------------------------------------------------------------------------

/** Canonical activation receipt for a restored runtime's signed boot attestation. */
export function buildAgentBackupRestoreActivationReceipt(params: {
  operation: Readonly<AgentBackupRestoreOperation>;
  lifecycleRevision: bigint;
  attestationDigest: string;
  attestationMac: string;
  receiptId: string;
  appliedAt: Date;
}): { receipt: AgentActivationReceipt; receiptSha256: string } {
  const { operation } = params;
  const body = {
    schemaVersion: 1 as const,
    generation: operation.restore_attempt_id,
    purpose: "restore" as const,
    agentId: operation.agent_id,
    organizationId: operation.organization_id,
    lifecycleRevision: params.lifecycleRevision.toString(),
    backupId: operation.backup_id,
    backupHash: operation.expected_manifest_sha256,
    manifestHash: operation.expected_manifest_sha256,
    componentHashes: null,
    freshAuthorization: null,
    containerId: operation.expected_container_id!,
    imageDigest: operation.expected_image_digest!,
    receiptId: params.receiptId,
    receiptHash: params.attestationDigest,
    receiptMac: params.attestationMac,
    appliedAt: params.appliedAt.toISOString(),
    restored: true as const,
    requiresRestart: false,
  } satisfies AgentActivationReceipt;
  return { receipt: body, receiptSha256: sha256Canonical(body) };
}

/**
 * Bind the verified signed boot attestation: the sandbox activation moves
 * restore_pending -> restart_attested and the operation committed ->
 * restart_attested in one transaction. The canonical route is untouched.
 */
export async function recordAgentBackupRestoreRestartAttested(
  input: Readonly<
    AgentBackupRestoreServingClaim & {
      attestation: NonNullable<AgentBackupRestoreServingState["attestation"]>;
    }
  >,
): Promise<Readonly<{ operation: AgentBackupRestoreOperation; replayed: boolean }>> {
  requireSha256(input.attestation.digest, "attestation.digest");
  return dbWrite.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, input.operationId))
      .limit(1);
    if (
      existing &&
      existing.phase !== "committed" &&
      readAgentBackupRestoreServingState(existing).attestation?.digest === input.attestation.digest
    ) {
      return Object.freeze({ operation: Object.freeze(existing), replayed: true });
    }
    const { operation, sandbox, databaseNow } = await lockClaimedServingAuthority(
      tx,
      input,
      "committed",
    );
    const state = readAgentBackupRestoreServingState(operation);
    if (!state.generation || !state.previousRoute || !state.serving || !state.bootGrantSha256) {
      conflict("Restore attestation requires generation, previous route and serving evidence");
    }
    const body = input.attestation.body;
    if (
      body.agentId !== operation.agent_id ||
      body.organizationId !== operation.organization_id ||
      body.restoreAttemptId !== operation.restore_attempt_id ||
      body.containerId !== operation.expected_container_id ||
      body.nodeIncarnation !== operation.expected_node_incarnation ||
      body.committedReceiptSha256 !== state.generation.committedReceiptSha256 ||
      body.tokenSha256 !== sandbox.activation_token_hash ||
      body.listenPort !== state.serving.containerPort ||
      sha256Canonical(body) !== input.attestation.digest
    ) {
      conflict("Restore attestation differs from its durable authority");
    }
    if (sandbox.activation_phase !== "restore_pending") {
      conflict("Restore attestation requires a restore_pending activation");
    }
    const { next } = mergeWriteOnce(state, { attestation: input.attestation });
    const lifecycleRevision = BigInt(sandbox.lifecycle_revision) + 1n;
    const { receipt, receiptSha256 } = buildAgentBackupRestoreActivationReceipt({
      operation,
      lifecycleRevision,
      attestationDigest: input.attestation.digest,
      attestationMac: input.attestation.mac,
      receiptId: randomUUID(),
      appliedAt: databaseNow,
    });
    const [attested] = await tx
      .update(agentSandboxes)
      .set({
        activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
        activation_phase: "restart_attested",
        activation_receipt: receipt,
        activation_receipt_hash: receiptSha256,
        // Restore inherits the agent's existing billing; it opens no new
        // funding grant. Zero records that inherited funding explicitly.
        activation_funding_revision: 0n,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentSandboxes.id, sandbox.id),
          eq(agentSandboxes.organization_id, operation.organization_id),
          eq(agentSandboxes.lifecycle_revision, sandbox.lifecycle_revision),
          eq(agentSandboxes.activation_generation, operation.restore_attempt_id),
          eq(agentSandboxes.activation_phase, "restore_pending"),
          eq(agentSandboxes.activation_container_id, operation.expected_container_id!),
          isNull(agentSandboxes.activation_receipt),
          isNull(agentSandboxes.deleted_at),
        ),
      )
      .returning({ id: agentSandboxes.id });
    if (!attested) conflict("Restore attestation sandbox CAS was lost");
    const [advanced] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        phase: "restart_attested",
        resume_phase: null,
        serving_state: next,
        claim_owner: null,
        claim_generation: null,
        claim_expires_at: null,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operation.id),
          eq(agentBackupRestoreOperations.phase, "committed"),
          eq(agentBackupRestoreOperations.claim_generation, input.claimGeneration),
        ),
      )
      .returning();
    if (!advanced) conflict("Restore attestation operation CAS was lost");
    return Object.freeze({ operation: Object.freeze(advanced), replayed: false });
  });
}

// ---------------------------------------------------------------------------
// probed -> published (route CAS)
// ---------------------------------------------------------------------------

export function buildAgentBackupRestoreLifecycleReceiptDigest(params: {
  operation: Readonly<AgentBackupRestoreOperation>;
  replacementAttemptId: string;
  publicationId: string;
  attestationDigest: string;
  probeDigest: string;
}): string {
  return sha256Canonical({
    format: "eliza.agent-backup-restore.route-publication.v1",
    operationId: params.operation.id,
    organizationId: params.operation.organization_id,
    agentId: params.operation.agent_id,
    restoreAttemptId: params.operation.restore_attempt_id,
    replacementAttemptId: params.replacementAttemptId,
    containerId: params.operation.expected_container_id,
    imageDigest: params.operation.expected_image_digest,
    publicationId: params.publicationId,
    attestationDigest: params.attestationDigest,
    probeDigest: params.probeDigest,
  });
}

function routeMatchesSnapshot(
  sandbox: Readonly<AgentSandbox>,
  route: Readonly<AgentBackupRestorePreviousRoute>,
): boolean {
  return (
    sandbox.status === route.status &&
    sandbox.sandbox_id === route.sandboxId &&
    sandbox.node_id === route.nodeId &&
    sandbox.container_name === route.containerName &&
    sandbox.bridge_port === route.bridgePort &&
    sandbox.web_ui_port === route.webUiPort &&
    sandbox.bridge_url === route.bridgeUrl &&
    sandbox.health_url === route.healthUrl &&
    sandbox.headscale_ip === route.headscaleIp
  );
}

/** Snapshot the canonical route the restore will replace (read-only helper). */
export function snapshotAgentBackupRestorePreviousRoute(
  sandbox: Readonly<AgentSandbox>,
  runtime: AgentBackupRestorePreviousRoute["runtime"],
): AgentBackupRestorePreviousRoute {
  return RouteSnapshotSchema.parse({
    status: sandbox.status,
    sandboxId: sandbox.sandbox_id,
    nodeId: sandbox.node_id,
    containerName: sandbox.container_name,
    bridgePort: sandbox.bridge_port,
    webUiPort: sandbox.web_ui_port,
    bridgeUrl: sandbox.bridge_url,
    healthUrl: sandbox.health_url,
    headscaleIp: sandbox.headscale_ip,
    dockerImage: sandbox.docker_image,
    imageDigest: sandbox.image_digest,
    runtime,
  });
}

/**
 * The single route compare-and-swap. In one transaction it proves the
 * previous route is still exactly the snapshot taken before boot, adopts the
 * provider-settled replacement attempt, activates the restored generation and
 * points the agent's canonical route at the restored container.
 */
export async function publishAgentBackupRestoreRoute(
  input: Readonly<
    AgentBackupRestoreServingClaim & {
      replacementAttemptId: string;
      nodeHostname: string;
    }
  >,
): Promise<Readonly<{ operation: AgentBackupRestoreOperation; replayed: boolean }>> {
  requireUuid(input.replacementAttemptId, "replacementAttemptId");
  return dbWrite.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, input.operationId))
      .limit(1);
    if (existing && existing.route_published_at !== null) {
      return Object.freeze({ operation: Object.freeze(existing), replayed: true });
    }
    const { operation, sandbox, databaseNow } = await lockClaimedServingAuthority(
      tx,
      input,
      "probed",
    );
    const state = readAgentBackupRestoreServingState(operation);
    if (
      !state.previousRoute ||
      !state.serving ||
      !state.attestation ||
      !state.probe ||
      !state.publicationId
    ) {
      conflict("Restore route publication requires complete serving evidence");
    }
    if (sandbox.activation_phase !== "restart_attested") {
      conflict("Restore route publication requires a restart-attested activation");
    }
    if (!routeMatchesSnapshot(sandbox, state.previousRoute)) {
      conflict("Restore route changed after its previous route was captured");
    }
    // The immutable activation publication is appended after this CAS, from
    // the active generation, so it binds the final lifecycle revision.
    const [earlyPublication] = await tx
      .select({ id: agentActivationPublications.id })
      .from(agentActivationPublications)
      .where(
        and(
          eq(agentActivationPublications.organization_id, operation.organization_id),
          eq(agentActivationPublications.agent_id, operation.agent_id),
          eq(agentActivationPublications.activation_generation, operation.restore_attempt_id),
        ),
      )
      .limit(1);
    if (earlyPublication) conflict("Restore activation was published before its route CAS");
    const [attempt] = await tx
      .select()
      .from(agentSandboxReplacementAttempts)
      .where(
        and(
          eq(agentSandboxReplacementAttempts.id, input.replacementAttemptId),
          eq(agentSandboxReplacementAttempts.organization_id, operation.organization_id),
          eq(agentSandboxReplacementAttempts.agent_id, operation.agent_id),
        ),
      )
      .for("update")
      .limit(1);
    const containerName = `agent-restore-${operation.agent_id}-${operation.restore_attempt_id}`;
    if (
      !attempt ||
      attempt.operation_kind !== "provision" ||
      attempt.state !== "provider_succeeded" ||
      attempt.provider_receipt_digest === null ||
      attempt.activation_generation !== operation.restore_attempt_id ||
      attempt.restore_attempt_id !== operation.restore_attempt_id ||
      attempt.restore_lease_id !== operation.lease_id ||
      attempt.restore_lease_generation !== operation.lease_generation ||
      attempt.locator_container_id !== operation.expected_container_id ||
      attempt.locator_container_name !== containerName ||
      attempt.locator_node_record_id !== operation.expected_node_record_id ||
      attempt.locator_node_incarnation !== operation.expected_node_incarnation ||
      attempt.locator_node_history_id !== operation.expected_node_history_id ||
      attempt.locator_node_id !== sandbox.activation_node_id
    ) {
      conflict("Restore route publication lacks its exact provider-settled replacement");
    }
    const [node] = await tx
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.id, operation.expected_node_record_id!))
      .for("update")
      .limit(1);
    if (
      !node ||
      node.node_id !== sandbox.activation_node_id ||
      node.node_incarnation !== operation.expected_node_incarnation ||
      node.current_node_history_id !== operation.expected_node_history_id ||
      node.hostname !== input.nodeHostname
    ) {
      conflict("Restore route target node occurrence changed");
    }
    const lifecycleReceiptDigest = buildAgentBackupRestoreLifecycleReceiptDigest({
      operation,
      replacementAttemptId: attempt.id,
      publicationId: state.publicationId,
      attestationDigest: state.attestation.digest,
      probeDigest: state.probe.digest,
    });
    const [adopted] = await tx
      .update(agentSandboxReplacementAttempts)
      .set({
        state: "lifecycle_committed",
        lifecycle_committed_at: databaseNow,
        lifecycle_receipt_digest: lifecycleReceiptDigest,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentSandboxReplacementAttempts.id, attempt.id),
          eq(agentSandboxReplacementAttempts.state, "provider_succeeded"),
        ),
      )
      .returning({ id: agentSandboxReplacementAttempts.id });
    if (!adopted) conflict("Restore replacement adoption lost its CAS");
    const { serving } = state;
    const [routed] = await tx
      .update(agentSandboxes)
      .set({
        status: "running",
        sandbox_id: containerName,
        node_id: sandbox.activation_node_id,
        container_name: containerName,
        bridge_port: serving.bridgePort,
        web_ui_port: serving.webUiPort,
        bridge_url: `http://${input.nodeHostname}:${serving.bridgePort}`,
        health_url: `http://${input.nodeHostname}:${serving.webUiPort}/api`,
        headscale_ip: null,
        docker_image: operation.expected_image_reference,
        image_digest: operation.expected_image_digest,
        activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
        activation_phase: "active",
        activation_authority_published_at: databaseNow,
        activation_dispatched_at: databaseNow,
        activation_completed_at: databaseNow,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentSandboxes.id, sandbox.id),
          eq(agentSandboxes.organization_id, operation.organization_id),
          eq(agentSandboxes.lifecycle_revision, sandbox.lifecycle_revision),
          eq(agentSandboxes.activation_generation, operation.restore_attempt_id),
          eq(agentSandboxes.activation_phase, "restart_attested"),
          isNull(agentSandboxes.deleted_at),
        ),
      )
      .returning({ id: agentSandboxes.id });
    if (!routed) conflict("Restore route CAS was lost");
    const { next } = mergeWriteOnce(state, { routePublication: { lifecycleReceiptDigest } });
    const [published] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        phase: "published",
        resume_phase: null,
        serving_state: next,
        route_published_at: databaseNow,
        claim_owner: null,
        claim_generation: null,
        claim_expires_at: null,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operation.id),
          eq(agentBackupRestoreOperations.phase, "probed"),
          eq(agentBackupRestoreOperations.claim_generation, input.claimGeneration),
        ),
      )
      .returning();
    if (!published) conflict("Restore route publication operation CAS was lost");
    return Object.freeze({ operation: Object.freeze(published), replayed: false });
  });
}

// ---------------------------------------------------------------------------
// published: retire the previous runtime
// ---------------------------------------------------------------------------

export function buildAgentBackupRestorePreviousRuntimeRetiredDigest(params: {
  operation: Readonly<AgentBackupRestoreOperation>;
  previousRoute: Readonly<AgentBackupRestorePreviousRoute>;
}): string {
  return sha256Canonical({
    format: "eliza.agent-backup-restore.previous-runtime-retired.v1",
    operationId: params.operation.id,
    restoreAttemptId: params.operation.restore_attempt_id,
    previousRoute: params.previousRoute,
  });
}

/**
 * Record exact removal of the previous runtime and release its node slot once.
 * The provider effect precedes this call; the write-once receipt makes the
 * capacity release happen exactly once across replays.
 */
export async function recordAgentBackupRestorePreviousRuntimeRetired(
  input: Readonly<AgentBackupRestoreServingClaim>,
): Promise<Readonly<{ receiptDigest: string; replayed: boolean }>> {
  return dbWrite.transaction(async (tx) => {
    const { operation, databaseNow } = await lockClaimedServingAuthority(tx, input, "published");
    const state = readAgentBackupRestoreServingState(operation);
    if (!state.previousRoute) conflict("Restore retirement lacks its previous route");
    const receiptDigest = buildAgentBackupRestorePreviousRuntimeRetiredDigest({
      operation,
      previousRoute: state.previousRoute,
    });
    if (state.previousRuntimeRetired) {
      if (state.previousRuntimeRetired.receiptDigest !== receiptDigest) {
        conflict("Restore previous-runtime retirement replay mismatch");
      }
      return Object.freeze({ receiptDigest, replayed: true });
    }
    const runtime = state.previousRoute.runtime;
    if (runtime) {
      const [released] = await tx
        .update(dockerNodes)
        .set({
          allocated_count: sql`GREATEST(${dockerNodes.allocated_count} - 1, 0)`,
          updated_at: databaseNow,
        })
        .where(eq(dockerNodes.id, runtime.nodeRecordId))
        .returning({ id: dockerNodes.id });
      if (!released) conflict("Restore previous-runtime node record is missing");
    }
    const { next } = mergeWriteOnce(state, { previousRuntimeRetired: { receiptDigest } });
    const [updated] = await tx
      .update(agentBackupRestoreOperations)
      .set({ serving_state: next })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operation.id),
          eq(agentBackupRestoreOperations.claim_generation, input.claimGeneration),
        ),
      )
      .returning({ id: agentBackupRestoreOperations.id });
    if (!updated) conflict("Restore previous-runtime retirement lost its CAS");
    return Object.freeze({ receiptDigest, replayed: false });
  });
}

// ---------------------------------------------------------------------------
// Terminal rollback before route publication
// ---------------------------------------------------------------------------

/**
 * Close a restore that failed before route publication. The caller has already
 * stopped the restored container and restarted any retained previous runtime;
 * this blocks the restore activation (the canonical route never moved), fails
 * the operation terminally and records why. The restored container and its
 * staging volume remain for the exact cleanup authority.
 */
export async function failAgentBackupRestoreBeforeRoute(
  input: Readonly<
    AgentBackupRestoreServingClaim & {
      phase: AgentBackupRestorePhase;
      errorCode: string;
      error: string;
    }
  >,
): Promise<Readonly<AgentBackupRestoreOperation>> {
  if (!/^[A-Z][A-Z0-9_]{0,95}$/.test(input.errorCode)) conflict("errorCode is not canonical");
  return dbWrite.transaction(async (tx) => {
    const { operation, sandbox, databaseNow } = await lockClaimedServingAuthority(
      tx,
      input,
      input.phase,
    );
    if (operation.route_published_at !== null) {
      conflict("A published restore route cannot be rolled back");
    }
    if (sandbox.activation_phase !== "active") {
      const [blocked] = await tx
        .update(agentSandboxes)
        .set({
          activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
          activation_phase: "blocked",
          updated_at: databaseNow,
        })
        .where(
          and(
            eq(agentSandboxes.id, sandbox.id),
            eq(agentSandboxes.lifecycle_revision, sandbox.lifecycle_revision),
            eq(agentSandboxes.activation_generation, operation.restore_attempt_id),
          ),
        )
        .returning({ id: agentSandboxes.id });
      if (!blocked) conflict("Restore rollback sandbox CAS was lost");
    }
    const failureDigest = sha256Canonical({
      format: "eliza.agent-backup-restore.pre-route-rollback.v1",
      operationId: operation.id,
      phase: input.phase,
      claimGeneration: input.claimGeneration,
      errorCode: input.errorCode,
    });
    const [failed] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        phase: "failed_terminal",
        resume_phase: null,
        claim_owner: null,
        claim_generation: null,
        claim_expires_at: null,
        last_error_code: input.errorCode,
        last_error: input.error,
        last_failure_generation: input.claimGeneration,
        last_failure_digest: failureDigest,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operation.id),
          eq(agentBackupRestoreOperations.phase, input.phase),
          eq(agentBackupRestoreOperations.claim_generation, input.claimGeneration),
        ),
      )
      .returning();
    if (!failed) conflict("Restore rollback operation CAS was lost");
    return Object.freeze(failed);
  });
}

/**
 * Close an operation whose restore lease lapsed while nobody held a live
 * claim. No remote effect can run without the lease, so the only honest
 * outcome is an explicit terminal failure for the operator to reconcile.
 */
export async function abandonAgentBackupRestoreWithExpiredLease(
  operationId: string,
): Promise<Readonly<AgentBackupRestoreOperation> | null> {
  requireUuid(operationId, "operationId");
  return dbWrite.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, operationId))
      .for("update")
      .limit(1);
    if (!operation || (TERMINAL_PHASES as readonly string[]).includes(operation.phase)) {
      return null;
    }
    const [lease] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.id, operation.lease_id),
          eq(agentBackupRestoreLeases.organization_id, operation.organization_id),
          eq(agentBackupRestoreLeases.generation, operation.lease_generation),
        ),
      )
      .for("update")
      .limit(1);
    const databaseNow = await readPostLockDatabaseNow(tx);
    if (lease && lease.released_at === null && lease.expires_at > databaseNow) {
      return null;
    }
    if (operation.claim_expires_at !== null && operation.claim_expires_at > databaseNow) {
      return null;
    }
    const [failed] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        phase: "failed_terminal",
        resume_phase: null,
        claim_owner: null,
        claim_generation: null,
        claim_expires_at: null,
        last_error_code: "AGENT_BACKUP_RESTORE_LEASE_EXPIRED",
        last_error: `Restore lease lapsed in phase ${operation.phase}; operator reconciliation required`,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operation.id),
          eq(agentBackupRestoreOperations.phase, operation.phase),
        ),
      )
      .returning();
    return failed ? Object.freeze(failed) : null;
  });
}

// ---------------------------------------------------------------------------
// Worker selection
// ---------------------------------------------------------------------------

/** Due, unclaimed, non-terminal operations owned by this coordinator, oldest first. */
export async function listDueAgentBackupRestoreOperations(params: {
  ownerId: string;
  limit: number;
}): Promise<readonly Readonly<AgentBackupRestoreOperation>[]> {
  if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100) {
    conflict("limit must be an integer between 1 and 100");
  }
  const rows = await dbWrite
    .select()
    .from(agentBackupRestoreOperations)
    .where(
      and(
        notInArray(agentBackupRestoreOperations.phase, [...TERMINAL_PHASES]),
        eq(agentBackupRestoreOperations.lease_owner_id, params.ownerId),
        lte(agentBackupRestoreOperations.next_attempt_at, sql`now()`),
        or(
          isNull(agentBackupRestoreOperations.claim_expires_at),
          lte(agentBackupRestoreOperations.claim_expires_at, sql`now()`),
        ),
      ),
    )
    .orderBy(
      asc(agentBackupRestoreOperations.next_attempt_at),
      asc(agentBackupRestoreOperations.created_at),
    )
    .limit(params.limit);
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

export interface AgentBackupRestoreTargetNode {
  readonly nodeRecordId: string;
  readonly nodeId: string;
  readonly nodeIncarnation: string;
  readonly nodeHistoryId: string;
}

/**
 * Choose a first-placement candidate for a restore that has not reserved one.
 * This is advisory: the reservation writer re-proves eligibility and capacity
 * under its locks. The agent's current node is preferred so the restored
 * runtime stays near its previous volume and caller routes; otherwise the
 * least-loaded eligible Hetzner node wins. Returns null when none is eligible.
 */
export async function selectAgentBackupRestoreTargetNode(
  operation: Readonly<Pick<AgentBackupRestoreOperation, "organization_id" | "agent_id">>,
): Promise<AgentBackupRestoreTargetNode | null> {
  const [sandbox] = await dbWrite
    .select({ nodeId: agentSandboxes.node_id })
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, operation.agent_id),
        eq(agentSandboxes.organization_id, operation.organization_id),
      ),
    )
    .limit(1);
  const rows = await dbWrite
    .select({
      nodeRecordId: dockerNodes.id,
      nodeId: dockerNodes.node_id,
      nodeIncarnation: dockerNodes.node_incarnation,
      nodeHistoryId: dockerNodes.current_node_history_id,
      allocated: dockerNodes.allocated_count,
      capacity: dockerNodes.capacity,
    })
    .from(dockerNodes)
    .where(
      and(
        eq(dockerNodes.enabled, true),
        eq(dockerNodes.status, "healthy"),
        eq(dockerNodes.placement_state, PLACEABLE_NODE_STATE),
        eq(dockerNodes.infrastructure_provider, "hetzner"),
        sql`${dockerNodes.host_key_fingerprint} IS NOT NULL`,
        sql`${dockerNodes.fleet_kind} IS NOT NULL`,
        sql`${dockerNodes.node_incarnation} IS NOT NULL`,
        sql`${dockerNodes.current_node_history_id} IS NOT NULL`,
        sql`${dockerNodes.metadata}->>'architecture' IN ('amd64', 'arm64')`,
        sql`COALESCE(${dockerNodes.metadata}->>'capacityProvisional', 'false') <> 'true'`,
        sql`${dockerNodes.allocated_count} < ${dockerNodes.capacity}`,
      ),
    )
    .orderBy(
      sql`CASE WHEN ${dockerNodes.node_id} = ${sandbox?.nodeId ?? null} THEN 0 ELSE 1 END`,
      sql`${dockerNodes.allocated_count}::float / GREATEST(${dockerNodes.capacity}, 1)`,
      asc(dockerNodes.id),
    )
    .limit(1);
  const row = rows[0];
  if (!row || !row.nodeIncarnation || !row.nodeHistoryId) return null;
  return Object.freeze({
    nodeRecordId: row.nodeRecordId,
    nodeId: row.nodeId,
    nodeIncarnation: row.nodeIncarnation,
    nodeHistoryId: row.nodeHistoryId,
  });
}

/** Logical node id of an already-reserved target record (null when retired). */
export async function resolveAgentBackupRestoreReservedNodeId(
  nodeRecordId: string,
): Promise<string | null> {
  requireUuid(nodeRecordId, "nodeRecordId");
  const [row] = await dbWrite
    .select({ nodeId: dockerNodes.node_id })
    .from(dockerNodes)
    .where(eq(dockerNodes.id, nodeRecordId))
    .limit(1);
  return row?.nodeId ?? null;
}

// ---------------------------------------------------------------------------
// Exact container authority for remote effects
// ---------------------------------------------------------------------------

export interface AgentBackupRestoreContainerAuthority {
  readonly operation: Readonly<AgentBackupRestoreOperation>;
  readonly sandbox: Readonly<AgentSandbox>;
  readonly replacementAttemptId: string;
  readonly containerId: string;
  readonly containerName: string;
  readonly node: Readonly<{
    nodeId: string;
    nodeRecordId: string;
    nodeIncarnation: string;
    nodeHistoryId: string;
    hostname: string;
    sshPort: number;
    sshUser: string;
    hostKeyFingerprint: string;
  }>;
  /** The attempt-scoped vault seed receipt the final receipt must chain to. */
  readonly seedReceipt: Readonly<{ id: string; digest: string }> | null;
}

/**
 * Resolve the provider-settled replacement that owns the restore container.
 * Remote locators come only from this durable row, never from the caller.
 */
export async function loadAgentBackupRestoreContainerAuthority(
  operationId: string,
): Promise<AgentBackupRestoreContainerAuthority> {
  requireUuid(operationId, "operationId");
  const [operation] = await dbWrite
    .select()
    .from(agentBackupRestoreOperations)
    .where(eq(agentBackupRestoreOperations.id, operationId))
    .limit(1);
  if (!operation) conflict("Restore operation is missing");
  const containerId = operation.expected_container_id;
  if (!containerId) conflict("Restore operation has no settled container");
  const [sandbox] = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, operation.agent_id),
        eq(agentSandboxes.organization_id, operation.organization_id),
      ),
    )
    .limit(1);
  if (!sandbox) conflict("Restore sandbox authority is missing");
  const containerName = `agent-restore-${operation.agent_id}-${operation.restore_attempt_id}`;
  const [attempt] = await dbWrite
    .select()
    .from(agentSandboxReplacementAttempts)
    .where(
      and(
        eq(agentSandboxReplacementAttempts.organization_id, operation.organization_id),
        eq(agentSandboxReplacementAttempts.agent_id, operation.agent_id),
        eq(agentSandboxReplacementAttempts.restore_attempt_id, operation.restore_attempt_id),
        eq(agentSandboxReplacementAttempts.locator_container_id, containerId),
      ),
    )
    .limit(1);
  if (
    !attempt ||
    (attempt.state !== "provider_succeeded" && attempt.state !== "lifecycle_committed") ||
    attempt.locator_container_name !== containerName ||
    attempt.locator_node_id === null ||
    attempt.locator_node_record_id === null ||
    attempt.locator_node_record_id !== operation.expected_node_record_id ||
    attempt.locator_node_incarnation === null ||
    attempt.locator_node_incarnation !== operation.expected_node_incarnation ||
    attempt.locator_node_history_id === null ||
    attempt.locator_node_history_id !== operation.expected_node_history_id ||
    attempt.locator_node_hostname === null ||
    attempt.locator_node_ssh_port === null ||
    attempt.locator_node_ssh_user === null ||
    attempt.locator_node_host_key_fingerprint === null
  ) {
    conflict("Restore container lacks its exact provider-settled replacement");
  }
  const [seed] = await dbWrite
    .select({
      id: agentVaultKeySeedReceipts.id,
      digest: agentVaultKeySeedReceipts.receipt_digest,
    })
    .from(agentVaultKeySeedReceipts)
    .where(
      and(
        eq(agentVaultKeySeedReceipts.organization_id, operation.organization_id),
        eq(agentVaultKeySeedReceipts.agent_id, operation.agent_id),
        eq(agentVaultKeySeedReceipts.restore_attempt_id, operation.restore_attempt_id),
        eq(agentVaultKeySeedReceipts.replacement_attempt_id, attempt.id),
      ),
    )
    .limit(1);
  return Object.freeze({
    operation: Object.freeze(operation),
    sandbox: Object.freeze(sandbox),
    replacementAttemptId: attempt.id,
    containerId,
    containerName,
    node: Object.freeze({
      nodeId: attempt.locator_node_id,
      nodeRecordId: attempt.locator_node_record_id,
      nodeIncarnation: attempt.locator_node_incarnation,
      nodeHistoryId: attempt.locator_node_history_id,
      hostname: attempt.locator_node_hostname,
      sshPort: attempt.locator_node_ssh_port,
      sshUser: attempt.locator_node_ssh_user,
      hostKeyFingerprint: attempt.locator_node_host_key_fingerprint,
    }),
    seedReceipt: seed ? Object.freeze({ id: seed.id, digest: seed.digest }) : null,
  });
}

// ---------------------------------------------------------------------------
// Terminal cleanup of a failed restore container
// ---------------------------------------------------------------------------

export interface AgentBackupRestoreTerminalCleanup {
  readonly operationId: string;
  readonly replacementAttemptId: string;
  readonly restoreAttemptId: string;
  readonly locator: Readonly<AgentSandboxReplacementLocatorInput>;
  readonly settled: boolean;
}

/**
 * Terminally failed restores whose provider-settled container still holds
 * the agent's replacement fence and its node slot, oldest first.
 */
export async function listAgentBackupRestoreTerminalCleanups(params: {
  ownerId: string;
  limit: number;
}): Promise<readonly string[]> {
  if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100) {
    conflict("limit must be an integer between 1 and 100");
  }
  const rows = await dbWrite
    .select({ id: agentBackupRestoreOperations.id })
    .from(agentBackupRestoreOperations)
    .innerJoin(
      agentSandboxReplacementAttempts,
      and(
        eq(
          agentSandboxReplacementAttempts.organization_id,
          agentBackupRestoreOperations.organization_id,
        ),
        eq(agentSandboxReplacementAttempts.agent_id, agentBackupRestoreOperations.agent_id),
        eq(
          agentSandboxReplacementAttempts.restore_attempt_id,
          agentBackupRestoreOperations.restore_attempt_id,
        ),
        eq(
          agentSandboxReplacementAttempts.locator_container_id,
          agentBackupRestoreOperations.expected_container_id,
        ),
      ),
    )
    .where(
      and(
        eq(agentBackupRestoreOperations.phase, "failed_terminal"),
        eq(agentBackupRestoreOperations.lease_owner_id, params.ownerId),
        isNull(agentBackupRestoreOperations.route_published_at),
        sql`${agentSandboxReplacementAttempts.state} IN ('provider_succeeded', 'cleanup_in_progress')`,
      ),
    )
    .orderBy(asc(agentBackupRestoreOperations.updated_at))
    .limit(params.limit);
  return Object.freeze(rows.map((row) => row.id));
}

async function lockTerminalCleanupAuthority(tx: DbTransaction, operationId: string) {
  requireUuid(operationId, "operationId");
  const [operation] = await tx
    .select()
    .from(agentBackupRestoreOperations)
    .where(eq(agentBackupRestoreOperations.id, operationId))
    .for("update")
    .limit(1);
  if (
    !operation ||
    operation.phase !== "failed_terminal" ||
    operation.route_published_at !== null ||
    !operation.expected_container_id
  ) {
    conflict("Restore terminal cleanup requires a failed, never-routed restore container");
  }
  const [sandbox] = await tx
    .select({ id: agentSandboxes.id })
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, operation.agent_id),
        eq(agentSandboxes.organization_id, operation.organization_id),
      ),
    )
    .for("update")
    .limit(1);
  if (!sandbox) conflict("Restore terminal cleanup sandbox authority is missing");
  const [attempt] = await tx
    .select()
    .from(agentSandboxReplacementAttempts)
    .where(
      and(
        eq(agentSandboxReplacementAttempts.organization_id, operation.organization_id),
        eq(agentSandboxReplacementAttempts.agent_id, operation.agent_id),
        eq(agentSandboxReplacementAttempts.restore_attempt_id, operation.restore_attempt_id),
        eq(agentSandboxReplacementAttempts.locator_container_id, operation.expected_container_id),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !attempt ||
    attempt.restore_lease_id === null ||
    attempt.restore_backup_id === null ||
    attempt.restore_lease_owner_id === null ||
    attempt.restore_lease_generation === null ||
    attempt.restore_catalog_epoch === null ||
    attempt.restore_copy_role === null ||
    attempt.restore_operation_id === null ||
    attempt.restore_source_activation_generation === null ||
    attempt.restore_source_lifecycle_revision === null ||
    attempt.restore_manifest_sha256 === null ||
    attempt.restore_lease_expires_at === null ||
    attempt.locator_sandbox_id === null ||
    attempt.locator_node_id === null ||
    attempt.locator_container_name === null ||
    attempt.locator_node_record_id === null ||
    attempt.locator_node_incarnation === null ||
    attempt.locator_node_history_id === null ||
    attempt.locator_node_hostname === null ||
    attempt.locator_node_ssh_port === null ||
    attempt.locator_node_ssh_user === null ||
    attempt.locator_node_host_key_fingerprint === null
  ) {
    conflict("Restore terminal cleanup lacks its exact replacement locator");
  }
  const databaseNow = await readPostLockDatabaseNow(tx);
  const locator: AgentSandboxReplacementLocatorInput = Object.freeze({
    replacementAttemptId: attempt.id,
    sandboxId: attempt.locator_sandbox_id,
    nodeId: attempt.locator_node_id,
    containerName: attempt.locator_container_name,
    nodeRecordId: attempt.locator_node_record_id,
    nodeIncarnation: attempt.locator_node_incarnation,
    nodeHistoryId: attempt.locator_node_history_id,
    nodeHostname: attempt.locator_node_hostname,
    nodeSshPort: attempt.locator_node_ssh_port,
    nodeSshUser: attempt.locator_node_ssh_user,
    nodeHostKeyFingerprint: attempt.locator_node_host_key_fingerprint,
    replacementSecretCleanupVersion: 1,
    allocationCounted: true,
    vpnNodeName: null,
    vpnRegistrationStartedAt: null,
    previousVpnNodeId: null,
    containerId: attempt.locator_container_id,
    vpnNodeId: null,
  });
  const boundary = {
    attemptId: attempt.id,
    organizationId: operation.organization_id,
    agentId: operation.agent_id,
    lifecycleRevision: attempt.lifecycle_revision.toString(),
    activationGeneration: operation.restore_attempt_id,
    lifecycleJobId: attempt.lifecycle_job_id,
    lifecycleExecutionGeneration: attempt.lifecycle_execution_generation,
    restoreAuthority: {
      leaseId: attempt.restore_lease_id,
      backupId: attempt.restore_backup_id,
      restoreAttemptId: operation.restore_attempt_id,
      ownerId: attempt.restore_lease_owner_id,
      fencingToken: attempt.restore_lease_generation,
      catalogEpoch: attempt.restore_catalog_epoch.toString(),
      copyRole: attempt.restore_copy_role,
      operationId: attempt.restore_operation_id,
      sourceActivationGeneration: attempt.restore_source_activation_generation,
      sourceLifecycleRevision: attempt.restore_source_lifecycle_revision.toString(),
      expectedManifestSha256: attempt.restore_manifest_sha256,
      expiresAt: new Date(attempt.restore_lease_expires_at.getTime()),
    },
    locator,
    databaseNow,
  } as const;
  return { operation, attempt, locator, boundary, databaseNow };
}

/**
 * Fence the failed restore container before any remote removal: the attempt
 * moves to cleanup_in_progress, so no delayed callback can adopt it again.
 */
export async function beginAgentBackupRestoreTerminalCleanup(
  operationId: string,
): Promise<AgentBackupRestoreTerminalCleanup> {
  return dbWrite.transaction(async (tx) => {
    const { operation, attempt, locator, boundary } = await lockTerminalCleanupAuthority(
      tx,
      operationId,
    );
    if (attempt.state === "cleanup_proven") {
      return Object.freeze({
        operationId: operation.id,
        replacementAttemptId: attempt.id,
        restoreAttemptId: operation.restore_attempt_id,
        locator,
        settled: true,
      });
    }
    await beginAgentSandboxExactRestoreCleanupForLockedAuthoritiesInTransaction(tx, boundary);
    return Object.freeze({
      operationId: operation.id,
      replacementAttemptId: attempt.id,
      restoreAttemptId: operation.restore_attempt_id,
      locator,
      settled: false,
    });
  });
}

/**
 * Settle the proven remote absence: the attempt becomes cleanup_proven (which
 * releases the agent's replacement fence) and the target node slot reserved
 * for the restore is released exactly once.
 */
export async function finishAgentBackupRestoreTerminalCleanup(input: {
  operationId: string;
  receiptDigest: string;
}): Promise<Readonly<{ replayed: boolean }>> {
  requireSha256(input.receiptDigest, "receiptDigest");
  return dbWrite.transaction(async (tx) => {
    const { operation, attempt, boundary, databaseNow } = await lockTerminalCleanupAuthority(
      tx,
      input.operationId,
    );
    if (attempt.state === "cleanup_proven") {
      if (attempt.cleanup_receipt_digest !== input.receiptDigest) {
        conflict("Restore terminal cleanup receipt replay mismatch");
      }
      return Object.freeze({ replayed: true });
    }
    await finishAgentSandboxExactRestoreCleanupForLockedAuthoritiesInTransaction(tx, {
      ...boundary,
      receiptDigest: input.receiptDigest,
    });
    const [released] = await tx
      .update(dockerNodes)
      .set({
        allocated_count: sql`GREATEST(${dockerNodes.allocated_count} - 1, 0)`,
        updated_at: databaseNow,
      })
      .where(eq(dockerNodes.id, attempt.locator_node_record_id!))
      .returning({ id: dockerNodes.id });
    if (!released) conflict("Restore terminal cleanup target node record is missing");
    if (operation.id !== input.operationId) conflict("Restore terminal cleanup identity drifted");
    return Object.freeze({ replayed: false });
  });
}
