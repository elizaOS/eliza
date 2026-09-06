/** Retains ordinary candidate resources under the replacement ledger before remote retirement. */
import { ElizaError } from "@elizaos/core";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getVolumePath } from "../../lib/services/docker-sandbox-utils";
import type { DbTransaction } from "../client";
import {
  type AgentSandboxReplacementAttempt,
  agentSandboxReplacementAttempts,
} from "../schemas/agent-sandbox-replacement-attempts";
import {
  type AgentDeletionResourceManifest,
  type AgentDeletionResourceReceipt,
  type AgentDeletionVolumeCapture,
  type AgentDeletionVpnReceipt,
  agentSandboxes,
} from "../schemas/agent-sandboxes";
import { jobs } from "../schemas/jobs";
import {
  assertDeletionResourceManifestOwner,
  deletionResourceAuthorityHash,
  validateDeletionSecretReceipt,
  validateDeletionVolumeCapture,
  validateDeletionVpnReceipt,
} from "./agent-deletion-resource-manifest";
import {
  type AgentSandboxReplacementAttemptReference,
  type AgentSandboxReplacementLocatorInput,
  beginAgentSandboxReplacementCleanupInTransaction,
} from "./agent-sandbox-replacement-attempts";

function conflict(message: string): ElizaError {
  return new ElizaError(message, { code: "AGENT_REPLACEMENT_RESOURCE_AUTHORITY_CHANGED" });
}
function required<T>(value: T | null, field: string): T {
  if (value === null) throw conflict(`Replacement resource authority lacks ${field}`);
  return value;
}

function locatorFromAttempt(
  attempt: AgentSandboxReplacementAttempt,
): AgentSandboxReplacementLocatorInput {
  if (attempt.locator_allocation_counted !== true || attempt.locator_secret_cleanup_version !== 1)
    throw conflict("Replacement resources require capacity and transient-secret ownership");
  return {
    replacementAttemptId: attempt.id,
    sandboxId: required(attempt.locator_sandbox_id, "sandbox"),
    nodeId: required(attempt.locator_node_id, "node"),
    containerName: required(attempt.locator_container_name, "container name"),
    nodeRecordId: required(attempt.locator_node_record_id, "node record"),
    nodeIncarnation: required(attempt.locator_node_incarnation, "node incarnation"),
    nodeHistoryId: required(attempt.locator_node_history_id, "node history"),
    nodeHostname: required(attempt.locator_node_hostname, "hostname"),
    nodeSshPort: required(attempt.locator_node_ssh_port, "SSH port"),
    nodeSshUser: required(attempt.locator_node_ssh_user, "SSH user"),
    nodeHostKeyFingerprint: required(attempt.locator_node_host_key_fingerprint, "SSH host key"),
    replacementSecretCleanupVersion: 1,
    allocationCounted: true,
    containerId: attempt.locator_container_id,
    vpnNodeId: attempt.locator_vpn_node_id,
    vpnNodeName: attempt.locator_vpn_node_name,
    vpnRegistrationStartedAt: attempt.locator_vpn_registration_started_at?.toISOString() ?? null,
    previousVpnNodeId: attempt.locator_previous_vpn_node_id,
    vpnAuthority: attempt.locator_vpn_authority,
  };
}

async function lockCandidate(tx: DbTransaction, ref: AgentSandboxReplacementAttemptReference) {
  const [source] = await tx
    .select({ id: agentSandboxes.id })
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, ref.agentId),
        eq(agentSandboxes.organization_id, ref.organizationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!source) throw conflict("Replacement resource owner is missing");
  const [attempt] = await tx
    .select()
    .from(agentSandboxReplacementAttempts)
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, ref.attemptId),
        eq(agentSandboxReplacementAttempts.agent_id, ref.agentId),
        eq(agentSandboxReplacementAttempts.organization_id, ref.organizationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!attempt || attempt.restore_attempt_id !== null)
    throw conflict("Ordinary replacement resource authority is missing");
  return attempt;
}

/** Admit the existing resource-manifest contract atomically with the cleanup fence. */
export async function admitAgentSandboxReplacementResourcesInTransaction(
  tx: DbTransaction,
  ref: AgentSandboxReplacementAttemptReference,
): Promise<AgentDeletionResourceManifest> {
  const attempt = await lockCandidate(tx, ref);
  const locator = locatorFromAttempt(attempt);
  if (
    !attempt.provider_succeeded_at ||
    !attempt.provider_receipt_digest ||
    !locator.containerId ||
    !/^[0-9a-f]{64}$/.test(locator.containerId)
  )
    throw conflict(
      "Candidate resources require proven provider completion and a complete Docker identity",
    );
  await beginAgentSandboxReplacementCleanupInTransaction(tx, ref, locator);
  const identity: AgentDeletionResourceManifest = {
    version: 1,
    deletionAttemptId: ref.attemptId,
    deletionPolicy: { kind: "recovery_required" },
    agentId: ref.agentId,
    organizationId: ref.organizationId,
    servingPlacement: { version: 1, volumePath: getVolumePath(ref.agentId), locator },
    localStateRetention: null,
    resources: {
      volume: { state: "unknown" },
      vpn: { state: "unknown" },
      secrets: { state: "unknown" },
    },
  };
  const existing = attempt.cleanup_resource_manifest;
  if (existing) {
    assertDeletionResourceManifestOwner(
      existing,
      { id: ref.agentId, organization_id: ref.organizationId },
      ref.attemptId,
    );
    if (deletionResourceAuthorityHash(existing) !== deletionResourceAuthorityHash(identity))
      throw conflict("Candidate resource identity differs from its replacement locator");
    return existing;
  }
  const [written] = await tx
    .update(agentSandboxReplacementAttempts)
    .set({ cleanup_resource_manifest: identity })
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, ref.attemptId),
        eq(agentSandboxReplacementAttempts.state, "cleanup_in_progress"),
      ),
    )
    .returning({ manifest: agentSandboxReplacementAttempts.cleanup_resource_manifest });
  if (!written?.manifest) throw conflict("Candidate resource admission lost its cleanup owner");
  return written.manifest;
}

/** Persist the exact bind-mount generation before any consumer can remove candidate compute. */
export async function recordAgentSandboxReplacementVolumeCaptureInTransaction(
  tx: DbTransaction,
  ref: AgentSandboxReplacementAttemptReference,
  capture: AgentDeletionVolumeCapture,
): Promise<AgentDeletionResourceManifest> {
  const attempt = await lockCandidate(tx, ref);
  if (attempt.state !== "cleanup_in_progress" || !attempt.cleanup_resource_manifest)
    throw conflict("Candidate volume capture has no admitted cleanup manifest");
  const manifest = await admitAgentSandboxReplacementResourcesInTransaction(tx, ref);
  validateDeletionVolumeCapture(manifest, capture);
  const existing = manifest.resources.volume;
  if (existing.state !== "unknown") {
    const fields = [
      "authorityHash",
      "observedAt",
      "path",
      "nodeBootId",
      "rootDevice",
      "rootInode",
      "stateDevice",
      "stateInode",
    ] as const;
    if (existing.state !== "captured" || fields.some((field) => existing[field] !== capture[field]))
      throw conflict("Candidate volume generation cannot change after capture");
    return manifest;
  }
  const next: AgentDeletionResourceManifest = {
    ...manifest,
    resources: { ...manifest.resources, volume: capture },
  };
  const [written] = await tx
    .update(agentSandboxReplacementAttempts)
    .set({ cleanup_resource_manifest: next })
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, ref.attemptId),
        eq(agentSandboxReplacementAttempts.state, "cleanup_in_progress"),
      ),
    )
    .returning({ manifest: agentSandboxReplacementAttempts.cleanup_resource_manifest });
  if (!written?.manifest) throw conflict("Candidate volume capture lost its cleanup owner");
  return written.manifest;
}

/** Retain validated secret/VPN absence receipts without releasing the candidate volume. */
export async function recordAgentSandboxReplacementResourceAbsenceInTransaction(
  tx: DbTransaction,
  ref: AgentSandboxReplacementAttemptReference,
  observation:
    | { kind: "secrets"; value: AgentDeletionResourceReceipt }
    | { kind: "vpn"; value: AgentDeletionVpnReceipt },
): Promise<AgentDeletionResourceManifest> {
  const attempt = await lockCandidate(tx, ref);
  if (attempt.state !== "cleanup_in_progress" || !attempt.cleanup_resource_manifest)
    throw conflict("Candidate resource observation has no admitted cleanup manifest");
  const manifest = await admitAgentSandboxReplacementResourcesInTransaction(tx, ref);
  if (manifest.resources.volume.state === "unknown")
    throw conflict("Candidate resources cannot retire before volume identity is retained");
  if (observation.kind === "secrets") validateDeletionSecretReceipt(manifest, observation.value);
  else validateDeletionVpnReceipt(manifest, observation.value);
  const existing = manifest.resources[observation.kind];
  if (existing.state !== "unknown") {
    // Provider readback may be repeated after a lost response; preserve the first committed receipt.
    // Both receipts have already been validated against this immutable resource authority.
    return manifest;
  }
  const next: AgentDeletionResourceManifest = {
    ...manifest,
    resources: { ...manifest.resources, [observation.kind]: observation.value },
  };
  const [written] = await tx
    .update(agentSandboxReplacementAttempts)
    .set({ cleanup_resource_manifest: next })
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, ref.attemptId),
        eq(agentSandboxReplacementAttempts.state, "cleanup_in_progress"),
      ),
    )
    .returning({ manifest: agentSandboxReplacementAttempts.cleanup_resource_manifest });
  if (!written?.manifest) throw conflict("Candidate resource observation lost its cleanup owner");
  return written.manifest;
}

/** Rotate unfinished, already-fenced resource cleanup through the existing daemon sweep.
 * This schedules readback fairly; it is not a remote-execution lease. Consumers must
 * revalidate the exact attempt and serving ownership before every provider effect.
 */
export async function scheduleAgentSandboxReplacementResourceCleanupInTransaction(
  tx: DbTransaction,
  limit: number,
): Promise<AgentSandboxReplacementAttemptReference[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25)
    throw conflict("Replacement cleanup batch size must be an integer from 1 through 25");
  const result = await tx.execute<{
    id: string;
    agent_id: string;
    organization_id: string;
  }>(sql`
    WITH pending AS (
      SELECT id FROM ${agentSandboxReplacementAttempts}
      WHERE state = 'cleanup_in_progress' AND restore_attempt_id IS NULL
        AND cleanup_resource_manifest IS NOT NULL
        AND (
          cleanup_resource_manifest #>> '{resources,volume,state}' = 'unknown'
          OR cleanup_resource_manifest #>> '{resources,secrets,state}' = 'unknown'
          OR cleanup_resource_manifest #>> '{resources,vpn,state}' = 'unknown'
        )
      ORDER BY updated_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${agentSandboxReplacementAttempts} AS attempt
    SET updated_at = clock_timestamp()
    FROM pending WHERE attempt.id = pending.id
    RETURNING attempt.id, attempt.agent_id, attempt.organization_id
  `);
  return result.rows.map((row) => ({
    attemptId: row.id,
    agentId: row.agent_id,
    organizationId: row.organization_id,
  }));
}

/** Admit unadopted successful candidates before settlement releases their creating job generation. */
export async function admitSettledJobReplacementResourcesInTransaction(
  tx: DbTransaction,
  input: { jobId: string; agentId: string; organizationId: string; executionGeneration: string },
): Promise<void> {
  const [execution] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.id, input.jobId),
        eq(jobs.agent_id, input.agentId),
        eq(jobs.organization_id, input.organizationId),
        eq(jobs.execution_generation, input.executionGeneration),
        inArray(jobs.type, ["agent_upgrade", "agent_downgrade", "agent_admin_canary_image"]),
        inArray(jobs.status, ["pending", "completed", "failed", "cancelled"]),
        sql`${jobs.execution_quiesced_at} IS NOT NULL`,
      ),
    )
    .for("update")
    .limit(1);
  if (!execution)
    throw conflict("Replacement cleanup requires its creating execution's settlement");
  const attempts = await tx
    .select({ id: agentSandboxReplacementAttempts.id })
    .from(agentSandboxReplacementAttempts)
    .where(
      and(
        eq(agentSandboxReplacementAttempts.agent_id, input.agentId),
        eq(agentSandboxReplacementAttempts.organization_id, input.organizationId),
        eq(agentSandboxReplacementAttempts.lifecycle_job_id, input.jobId),
        eq(
          agentSandboxReplacementAttempts.lifecycle_execution_generation,
          input.executionGeneration,
        ),
        isNull(agentSandboxReplacementAttempts.restore_attempt_id),
        inArray(agentSandboxReplacementAttempts.state, [
          "provider_succeeded",
          "cleanup_in_progress",
        ]),
      ),
    );
  for (const attempt of attempts) {
    await admitAgentSandboxReplacementResourcesInTransaction(tx, {
      attemptId: attempt.id,
      agentId: input.agentId,
      organizationId: input.organizationId,
    });
  }
}
