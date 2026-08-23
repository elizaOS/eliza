/**
 * Real-PGlite proofs for durable, one-shot sandbox replacement authority.
 * pushSchema supplies the table and a test-local trigger exercises immutable
 * guards that Drizzle's schema DSL cannot represent.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { ElizaError } from "@elizaos/core";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { and, eq, gt, sql } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { agentBackupRestoreLeases } from "../../schemas/agent-backup-catalog";
import { agentNodeIncarnationHistories } from "../../schemas/agent-node-incarnation-histories";
import { agentSandboxReplacementAttempts } from "../../schemas/agent-sandbox-replacement-attempts";
import {
  agentBackupCatalogAuthorities,
  agentSandboxBackups,
  agentSandboxes,
} from "../../schemas/agent-sandboxes";
import { dockerNodes } from "../../schemas/docker-nodes";
import { organizations } from "../../schemas/organizations";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";
import {
  type AgentSandboxReplacementAttemptReference,
  type AgentSandboxReplacementLocatorInput,
  type AgentSandboxReplacementRestoreAuthority,
  type CommitAgentSandboxReplacementLifecycleAdoptionInput,
  commitAgentSandboxReplacementLifecycleAdoptionInTransaction,
  getAgentSandboxReplacementAttempt,
  recordAgentSandboxReplacementCleanupProvenInTransaction,
  recordAgentSandboxReplacementCreated,
  recordAgentSandboxReplacementIntentInTransaction,
  recordAgentSandboxReplacementProviderSucceeded,
  recordAgentSandboxReplacementVpnRegistered,
  type StartAgentSandboxReplacementAttemptInput,
  startAgentSandboxReplacementAttemptInTransaction,
} from "../agent-sandbox-replacement-attempts";

const TIMEOUT = 120_000;
const ORGANIZATION_ID = "00000000-0000-4000-8000-00000000a001";
const AGENT_ID = "00000000-0000-4000-8000-00000000a002";
const USER_ID = "00000000-0000-4000-8000-00000000a022";
const OTHER_ORGANIZATION_ID = "00000000-0000-4000-8000-00000000a023";
const ATTEMPT_ID = "00000000-0000-4000-8000-00000000a003";
const OTHER_ATTEMPT_ID = "00000000-0000-4000-8000-00000000a004";
const THIRD_ATTEMPT_ID = "00000000-0000-4000-8000-00000000a025";
const ACTIVATION_GENERATION = "00000000-0000-4000-8000-00000000a005";
const NEXT_ACTIVATION_GENERATION = "00000000-0000-4000-8000-00000000a027";
const NODE_RECORD_ID = "00000000-0000-4000-8000-00000000a006";
const LIFECYCLE_JOB_ID = "00000000-0000-4000-8000-00000000a007";
const LIFECYCLE_EXECUTION_GENERATION = "00000000-0000-4000-8000-00000000a008";
const NEXT_LIFECYCLE_JOB_ID = "00000000-0000-4000-8000-00000000a028";
const NEXT_LIFECYCLE_EXECUTION_GENERATION = "00000000-0000-4000-8000-00000000a029";
const BACKUP_ID = "00000000-0000-4000-8000-00000000a009";
const BACKUP_OPERATION_ID = "00000000-0000-4000-8000-00000000a00a";
const BACKUP_ACTIVATION_GENERATION = "00000000-0000-4000-8000-00000000a00b";
const RESTORE_ATTEMPT_ID = "00000000-0000-4000-8000-00000000a00c";
const RESTORE_LEASE_ID = "00000000-0000-4000-8000-00000000a00d";
const RESTORE_FENCE = "00000000-0000-4000-8000-00000000a00e";
const AGED_ATTEMPT_ID = "00000000-0000-4000-8000-00000000a012";
const CONTAINER_ID = "a".repeat(64);
const BACKUP_DIGEST = "9".repeat(64);
const PROVIDER_DIGEST = "b".repeat(64);
const LIFECYCLE_DIGEST = "c".repeat(64);
const CLEANUP_DIGEST = "d".repeat(64);
const CONTAINER_NAME = `agent-${AGENT_ID}`;

async function startAgentSandboxReplacementAttempt(
  input: StartAgentSandboxReplacementAttemptInput,
) {
  return await dbWrite.transaction((tx) =>
    startAgentSandboxReplacementAttemptInTransaction(tx, input),
  );
}

async function recordAgentSandboxReplacementIntent(
  attemptReference: AgentSandboxReplacementAttemptReference,
  replacementLocator: AgentSandboxReplacementLocatorInput,
) {
  return await dbWrite.transaction((tx) =>
    recordIntentAndReserveCapacityInTransaction(tx, attemptReference, replacementLocator),
  );
}

async function recordAgentSandboxReplacementLifecycleCommitted(
  input: CommitAgentSandboxReplacementLifecycleAdoptionInput,
) {
  return await dbWrite.transaction((tx) => commitLifecyclePlacementInTransaction(tx, input));
}

async function recordAgentSandboxReplacementCleanupProven(
  attemptReference: AgentSandboxReplacementAttemptReference,
  receiptDigest: string,
) {
  return await dbWrite.transaction((tx) =>
    settleCleanupResourcesInTransaction(tx, attemptReference, receiptDigest),
  );
}

const reference = (attemptId = ATTEMPT_ID): AgentSandboxReplacementAttemptReference => ({
  attemptId,
  organizationId: ORGANIZATION_ID,
  agentId: AGENT_ID,
});

function startInput(
  overrides: Partial<StartAgentSandboxReplacementAttemptInput> = {},
): StartAgentSandboxReplacementAttemptInput {
  return {
    ...reference(),
    operationKind: "upgrade",
    lifecycleRevision: "7",
    activationGeneration: ACTIVATION_GENERATION,
    lifecycleJobId: LIFECYCLE_JOB_ID,
    lifecycleExecutionGeneration: LIFECYCLE_EXECUTION_GENERATION,
    restoreAuthority: null,
    ...overrides,
  };
}

function locator(
  stage: "intent" | "created" | "vpn" | "final",
  overrides: Partial<AgentSandboxReplacementLocatorInput> = {},
): AgentSandboxReplacementLocatorInput {
  const hasContainer = stage !== "intent";
  const hasVpn = stage === "vpn" || stage === "final";
  return {
    replacementAttemptId: ATTEMPT_ID,
    sandboxId: CONTAINER_NAME,
    nodeId: "robot-node-a",
    containerName: CONTAINER_NAME,
    nodeRecordId: NODE_RECORD_ID,
    nodeHostname: "robot-node-a.internal",
    nodeSshPort: 22,
    nodeSshUser: "root",
    nodeHostKeyFingerprint: "SHA256:test-only-pinned-host-key",
    replacementSecretCleanupVersion: 1,
    allocationCounted: true,
    vpnNodeName: CONTAINER_NAME,
    vpnRegistrationStartedAt: "2026-08-23T12:00:00.000Z",
    previousVpnNodeId: "41",
    containerId: hasContainer ? CONTAINER_ID : null,
    vpnNodeId: hasVpn ? "42" : null,
    ...overrides,
  };
}

function adoptionInput(
  attemptId = ATTEMPT_ID,
  overrides: Partial<CommitAgentSandboxReplacementLifecycleAdoptionInput> = {},
): CommitAgentSandboxReplacementLifecycleAdoptionInput {
  return {
    ...startInput({ attemptId }),
    locator: locator("final", { replacementAttemptId: attemptId }),
    providerReceiptDigest: PROVIDER_DIGEST,
    lifecycleReceiptDigest: LIFECYCLE_DIGEST,
    ...overrides,
  };
}

function rotatedStartInput(
  lifecycleRevision: string,
  attemptId = OTHER_ATTEMPT_ID,
): StartAgentSandboxReplacementAttemptInput {
  return startInput({
    attemptId,
    lifecycleRevision,
    activationGeneration: NEXT_ACTIVATION_GENERATION,
    lifecycleJobId: NEXT_LIFECYCLE_JOB_ID,
    lifecycleExecutionGeneration: NEXT_LIFECYCLE_EXECUTION_GENERATION,
  });
}

async function rotateSandboxLifecycle(expectedLifecycleRevision: number): Promise<void> {
  const rotated = await dbWrite
    .update(agentSandboxes)
    .set({
      lifecycle_job_id: NEXT_LIFECYCLE_JOB_ID,
      lifecycle_execution_generation: NEXT_LIFECYCLE_EXECUTION_GENERATION,
      activation_previous_generation: ACTIVATION_GENERATION,
      activation_generation: NEXT_ACTIVATION_GENERATION,
      activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
      activation_token_hash: "2".repeat(64),
      activation_token_ciphertext: "test-only-rotated-activation-token",
      updated_at: new Date(),
    })
    .where(
      and(
        eq(agentSandboxes.id, AGENT_ID),
        eq(agentSandboxes.organization_id, ORGANIZATION_ID),
        eq(agentSandboxes.lifecycle_revision, expectedLifecycleRevision),
        eq(agentSandboxes.activation_generation, ACTIVATION_GENERATION),
        eq(agentSandboxes.lifecycle_job_id, LIFECYCLE_JOB_ID),
        eq(agentSandboxes.lifecycle_execution_generation, LIFECYCLE_EXECUTION_GENERATION),
      ),
    )
    .returning({
      lifecycleRevision: agentSandboxes.lifecycle_revision,
      activationGeneration: agentSandboxes.activation_generation,
      activationLifecycleRevision: agentSandboxes.activation_lifecycle_revision,
      lifecycleJobId: agentSandboxes.lifecycle_job_id,
      lifecycleExecutionGeneration: agentSandboxes.lifecycle_execution_generation,
    });
  expect(rotated).toEqual([
    {
      lifecycleRevision: expectedLifecycleRevision + 1,
      activationGeneration: NEXT_ACTIVATION_GENERATION,
      activationLifecycleRevision: BigInt(expectedLifecycleRevision + 1),
      lifecycleJobId: NEXT_LIFECYCLE_JOB_ID,
      lifecycleExecutionGeneration: NEXT_LIFECYCLE_EXECUTION_GENERATION,
    },
  ]);
}

async function restampRotatedActivationAuthority(expectedLifecycleRevision: number): Promise<void> {
  const restamped = await dbWrite
    .update(agentSandboxes)
    .set({
      activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(agentSandboxes.id, AGENT_ID),
        eq(agentSandboxes.organization_id, ORGANIZATION_ID),
        eq(agentSandboxes.lifecycle_revision, expectedLifecycleRevision),
        eq(agentSandboxes.activation_generation, NEXT_ACTIVATION_GENERATION),
        eq(agentSandboxes.lifecycle_job_id, NEXT_LIFECYCLE_JOB_ID),
        eq(agentSandboxes.lifecycle_execution_generation, NEXT_LIFECYCLE_EXECUTION_GENERATION),
      ),
    )
    .returning({
      lifecycleRevision: agentSandboxes.lifecycle_revision,
      activationLifecycleRevision: agentSandboxes.activation_lifecycle_revision,
    });
  expect(restamped).toEqual([
    {
      lifecycleRevision: expectedLifecycleRevision + 1,
      activationLifecycleRevision: BigInt(expectedLifecycleRevision + 1),
    },
  ]);
}

async function seedReplacementCleanupLocator(
  attemptId: string,
  expectedLifecycleRevision: number,
): Promise<void> {
  const seeded = await dbWrite
    .update(agentSandboxes)
    .set({
      replacement_cleanup_sandbox_id: CONTAINER_NAME,
      replacement_cleanup_node_id: "robot-node-a",
      replacement_cleanup_container_name: CONTAINER_NAME,
      replacement_cleanup_attempt_id: attemptId,
      replacement_cleanup_container_id: CONTAINER_ID,
      replacement_cleanup_vpn_node_id: "42",
      replacement_cleanup_vpn_node_name: CONTAINER_NAME,
      replacement_cleanup_preserved_vpn_node_id: "41",
      replacement_cleanup_vpn_registration_started_at: new Date("2026-08-23T12:00:00.000Z"),
      replacement_cleanup_allocation_counted: true,
      replacement_cleanup_created_at: new Date("2026-08-23T12:03:00.000Z"),
    })
    .where(
      and(
        eq(agentSandboxes.id, AGENT_ID),
        eq(agentSandboxes.organization_id, ORGANIZATION_ID),
        eq(agentSandboxes.lifecycle_revision, expectedLifecycleRevision),
      ),
    )
    .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
  expect(seeded).toEqual([{ lifecycleRevision: expectedLifecycleRevision + 1 }]);
}

type ReplacementTransaction = Parameters<
  typeof commitAgentSandboxReplacementLifecycleAdoptionInTransaction
>[0];

function callerConflict(
  message: string,
  attemptReference: AgentSandboxReplacementAttemptReference,
): ElizaError {
  return new ElizaError(message, {
    code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    context: {
      replacementAttemptId: attemptReference.attemptId,
      organizationId: attemptReference.organizationId,
      agentId: attemptReference.agentId,
    },
    severity: "fatal",
  });
}

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => {
    throw new Error("Deferred signal was resolved before initialization");
  };
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise() };
}

async function recordIntentAndReserveCapacityInTransaction(
  tx: ReplacementTransaction,
  attemptReference: AgentSandboxReplacementAttemptReference,
  replacementLocator: AgentSandboxReplacementLocatorInput,
) {
  const recorded = await recordAgentSandboxReplacementIntentInTransaction(
    tx,
    attemptReference,
    replacementLocator,
  );
  if (recorded.replayed) return recorded;

  const reserved = await tx
    .update(dockerNodes)
    .set({ allocated_count: sql`${dockerNodes.allocated_count} + 1` })
    .where(
      and(
        eq(dockerNodes.id, replacementLocator.nodeRecordId),
        eq(dockerNodes.node_id, replacementLocator.nodeId),
        eq(dockerNodes.hostname, replacementLocator.nodeHostname),
        eq(dockerNodes.ssh_port, replacementLocator.nodeSshPort),
        eq(dockerNodes.ssh_user, replacementLocator.nodeSshUser),
        eq(dockerNodes.host_key_fingerprint, replacementLocator.nodeHostKeyFingerprint),
        eq(dockerNodes.enabled, true),
        eq(dockerNodes.placement_state, "open"),
        eq(dockerNodes.status, "healthy"),
        sql`${dockerNodes.allocated_count} < ${dockerNodes.capacity}`,
      ),
    )
    .returning({ id: dockerNodes.id });
  if (reserved.length !== 1) {
    throw callerConflict("Replacement capacity reservation CAS failed", attemptReference);
  }
  return recorded;
}

async function commitLifecyclePlacementInTransaction(
  tx: ReplacementTransaction,
  input: CommitAgentSandboxReplacementLifecycleAdoptionInput,
  currentPlacement: {
    sandboxId: string;
    nodeId: string;
    containerName: string;
  } = {
    sandboxId: "old-sandbox",
    nodeId: "old-node",
    containerName: "old-container",
  },
) {
  const consumed = await commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, input);
  if (consumed.replayed) {
    const [committed] = await tx
      .select({ id: agentSandboxes.id })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, input.agentId),
          eq(agentSandboxes.organization_id, input.organizationId),
          eq(agentSandboxes.lifecycle_revision, Number(input.lifecycleRevision) + 1),
          eq(agentSandboxes.activation_generation, input.activationGeneration),
          sql`${agentSandboxes.lifecycle_job_id} IS NOT DISTINCT FROM ${input.lifecycleJobId}`,
          sql`${agentSandboxes.lifecycle_execution_generation}
            IS NOT DISTINCT FROM ${input.lifecycleExecutionGeneration}`,
          eq(agentSandboxes.sandbox_id, input.locator.sandboxId),
          eq(agentSandboxes.node_id, input.locator.nodeId),
          eq(agentSandboxes.container_name, input.locator.containerName),
          eq(agentSandboxes.replacement_cleanup_sandbox_id, "old-sandbox"),
          eq(agentSandboxes.replacement_cleanup_node_id, "old-node"),
          eq(agentSandboxes.replacement_cleanup_container_name, "old-container"),
          eq(agentSandboxes.replacement_cleanup_allocation_counted, true),
          eq(agentSandboxes.replacement_cleanup_created_at, new Date("2026-08-23T12:04:00.000Z")),
        ),
      )
      .for("update")
      .limit(1);
    if (!committed) {
      throw callerConflict("Lifecycle placement replay authority does not match", input);
    }
    return consumed;
  }

  const placed = await tx
    .update(agentSandboxes)
    .set({
      sandbox_id: input.locator.sandboxId,
      node_id: input.locator.nodeId,
      container_name: input.locator.containerName,
      replacement_cleanup_sandbox_id: "old-sandbox",
      replacement_cleanup_node_id: "old-node",
      replacement_cleanup_container_name: "old-container",
      replacement_cleanup_allocation_counted: true,
      replacement_cleanup_created_at: new Date("2026-08-23T12:04:00.000Z"),
    })
    .where(
      and(
        eq(agentSandboxes.id, input.agentId),
        eq(agentSandboxes.organization_id, input.organizationId),
        eq(agentSandboxes.lifecycle_revision, Number(input.lifecycleRevision)),
        eq(agentSandboxes.activation_generation, input.activationGeneration),
        sql`${agentSandboxes.lifecycle_job_id} IS NOT DISTINCT FROM ${input.lifecycleJobId}`,
        sql`${agentSandboxes.lifecycle_execution_generation}
          IS NOT DISTINCT FROM ${input.lifecycleExecutionGeneration}`,
        eq(agentSandboxes.sandbox_id, currentPlacement.sandboxId),
        eq(agentSandboxes.node_id, currentPlacement.nodeId),
        eq(agentSandboxes.container_name, currentPlacement.containerName),
        sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
        sql`${agentSandboxes.replacement_cleanup_sandbox_id} IS NULL`,
      ),
    )
    .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
  if (placed.length !== 1) {
    throw callerConflict("Lifecycle placement CAS failed", input);
  }
  return consumed;
}

async function settleCleanupResourcesInTransaction(
  tx: ReplacementTransaction,
  attemptReference: AgentSandboxReplacementAttemptReference,
  receiptDigest: string,
  afterAttemptSettled?: () => Promise<void> | void,
) {
  const settled = await recordAgentSandboxReplacementCleanupProvenInTransaction(
    tx,
    attemptReference,
    receiptDigest,
  );
  if (settled.replayed) return settled;
  await afterAttemptSettled?.();

  const [sandbox] = await tx
    .select({
      cleanupSandboxId: agentSandboxes.replacement_cleanup_sandbox_id,
      cleanupNodeId: agentSandboxes.replacement_cleanup_node_id,
      cleanupContainerName: agentSandboxes.replacement_cleanup_container_name,
      cleanupAttemptId: agentSandboxes.replacement_cleanup_attempt_id,
      cleanupContainerId: agentSandboxes.replacement_cleanup_container_id,
      cleanupVpnNodeId: agentSandboxes.replacement_cleanup_vpn_node_id,
      cleanupVpnNodeName: agentSandboxes.replacement_cleanup_vpn_node_name,
      cleanupPreviousVpnNodeId: agentSandboxes.replacement_cleanup_preserved_vpn_node_id,
      cleanupVpnStartedAt: agentSandboxes.replacement_cleanup_vpn_registration_started_at,
      cleanupAllocationCounted: agentSandboxes.replacement_cleanup_allocation_counted,
      cleanupCreatedAt: agentSandboxes.replacement_cleanup_created_at,
    })
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, attemptReference.agentId),
        eq(agentSandboxes.organization_id, attemptReference.organizationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!sandbox) throw callerConflict("Cleanup sandbox authority is missing", attemptReference);

  const attempt = settled.attempt;
  if (attempt.locator_recorded_at === null) {
    if (sandbox.cleanupSandboxId !== null) {
      throw callerConflict(
        "Locator-free cleanup found unrelated cleanup ownership",
        attemptReference,
      );
    }
    return settled;
  }
  if (
    sandbox.cleanupSandboxId !== attempt.locator_sandbox_id ||
    sandbox.cleanupNodeId !== attempt.locator_node_id ||
    sandbox.cleanupContainerName !== attempt.locator_container_name ||
    sandbox.cleanupAttemptId !== attempt.id ||
    sandbox.cleanupContainerId !== attempt.locator_container_id ||
    sandbox.cleanupVpnNodeId !== attempt.locator_vpn_node_id ||
    sandbox.cleanupVpnNodeName !== attempt.locator_vpn_node_name ||
    sandbox.cleanupPreviousVpnNodeId !== attempt.locator_previous_vpn_node_id ||
    sandbox.cleanupVpnStartedAt?.getTime() !==
      attempt.locator_vpn_registration_started_at?.getTime() ||
    sandbox.cleanupAllocationCounted !== true ||
    sandbox.cleanupCreatedAt === null
  ) {
    throw callerConflict("Cleanup locator authority does not match", attemptReference);
  }

  const cleared = await tx
    .update(agentSandboxes)
    .set({
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_node_id: null,
      replacement_cleanup_container_name: null,
      replacement_cleanup_attempt_id: null,
      replacement_cleanup_container_id: null,
      replacement_cleanup_vpn_node_id: null,
      replacement_cleanup_vpn_node_name: null,
      replacement_cleanup_preserved_vpn_node_id: null,
      replacement_cleanup_vpn_registration_started_at: null,
      replacement_cleanup_allocation_counted: null,
      replacement_cleanup_created_at: null,
    })
    .where(
      and(
        eq(agentSandboxes.id, attemptReference.agentId),
        eq(agentSandboxes.organization_id, attemptReference.organizationId),
        sql`${agentSandboxes.replacement_cleanup_sandbox_id}
          IS NOT DISTINCT FROM ${sandbox.cleanupSandboxId}`,
        sql`${agentSandboxes.replacement_cleanup_node_id}
          IS NOT DISTINCT FROM ${sandbox.cleanupNodeId}`,
        sql`${agentSandboxes.replacement_cleanup_container_name}
          IS NOT DISTINCT FROM ${sandbox.cleanupContainerName}`,
        sql`${agentSandboxes.replacement_cleanup_attempt_id}
          IS NOT DISTINCT FROM ${sandbox.cleanupAttemptId}`,
        sql`${agentSandboxes.replacement_cleanup_container_id}
          IS NOT DISTINCT FROM ${sandbox.cleanupContainerId}`,
        sql`${agentSandboxes.replacement_cleanup_vpn_node_id}
          IS NOT DISTINCT FROM ${sandbox.cleanupVpnNodeId}`,
        sql`${agentSandboxes.replacement_cleanup_vpn_node_name}
          IS NOT DISTINCT FROM ${sandbox.cleanupVpnNodeName}`,
        sql`${agentSandboxes.replacement_cleanup_preserved_vpn_node_id}
          IS NOT DISTINCT FROM ${sandbox.cleanupPreviousVpnNodeId}`,
        sql`${agentSandboxes.replacement_cleanup_vpn_registration_started_at}
          IS NOT DISTINCT FROM ${sandbox.cleanupVpnStartedAt}`,
        eq(agentSandboxes.replacement_cleanup_allocation_counted, true),
        sql`${agentSandboxes.replacement_cleanup_created_at}
          IS NOT DISTINCT FROM ${sandbox.cleanupCreatedAt}`,
      ),
    )
    .returning({ id: agentSandboxes.id });
  if (cleared.length !== 1) {
    throw callerConflict("Cleanup locator clear CAS failed", attemptReference);
  }

  const released = await tx
    .update(dockerNodes)
    .set({ allocated_count: sql`${dockerNodes.allocated_count} - 1` })
    .where(
      and(
        eq(dockerNodes.id, attempt.locator_node_record_id!),
        eq(dockerNodes.node_id, attempt.locator_node_id!),
        eq(dockerNodes.hostname, attempt.locator_node_hostname!),
        eq(dockerNodes.ssh_port, attempt.locator_node_ssh_port!),
        eq(dockerNodes.ssh_user, attempt.locator_node_ssh_user!),
        eq(dockerNodes.host_key_fingerprint, attempt.locator_node_host_key_fingerprint!),
        gt(dockerNodes.allocated_count, 0),
      ),
    )
    .returning({ id: dockerNodes.id });
  if (released.length !== 1) {
    throw callerConflict("Cleanup capacity release CAS failed", attemptReference);
  }
  return settled;
}

function rawSettledAttempt(input: {
  attemptId: string;
  activationGeneration: string;
  state: "provider_succeeded" | "cleanup_proven";
  locatorRecordedAt: Date;
  containerRecordedAt: Date;
  vpnRecordedAt: Date;
  settledAt: Date;
}): typeof agentSandboxReplacementAttempts.$inferInsert {
  return {
    id: input.attemptId,
    organization_id: ORGANIZATION_ID,
    agent_id: AGENT_ID,
    operation_kind: "upgrade",
    lifecycle_revision: 7n,
    activation_generation: input.activationGeneration,
    lifecycle_job_id: LIFECYCLE_JOB_ID,
    lifecycle_execution_generation: LIFECYCLE_EXECUTION_GENERATION,
    state: input.state,
    locator_sandbox_id: CONTAINER_NAME,
    locator_node_id: "robot-node-a",
    locator_container_name: CONTAINER_NAME,
    locator_node_record_id: NODE_RECORD_ID,
    locator_node_hostname: "robot-node-a.internal",
    locator_node_ssh_port: 22,
    locator_node_ssh_user: "root",
    locator_node_host_key_fingerprint: "SHA256:test-only-pinned-host-key",
    locator_secret_cleanup_version: 1,
    locator_allocation_counted: true,
    locator_vpn_node_name: CONTAINER_NAME,
    locator_vpn_registration_started_at: new Date("2026-08-23T11:59:00.000Z"),
    locator_previous_vpn_node_id: "41",
    locator_recorded_at: input.locatorRecordedAt,
    locator_container_id: CONTAINER_ID,
    locator_container_recorded_at: input.containerRecordedAt,
    locator_vpn_node_id: "42",
    locator_vpn_recorded_at: input.vpnRecordedAt,
    provider_succeeded_at: input.state === "provider_succeeded" ? input.settledAt : null,
    provider_receipt_digest: input.state === "provider_succeeded" ? PROVIDER_DIGEST : null,
    cleanup_proven_at: input.state === "cleanup_proven" ? input.settledAt : null,
    cleanup_receipt_digest: input.state === "cleanup_proven" ? CLEANUP_DIGEST : null,
    created_at: new Date("2026-08-23T11:58:00.000Z"),
    updated_at: input.settledAt,
  };
}

async function seedRestoreLease(): Promise<AgentSandboxReplacementRestoreAuthority> {
  const leaseCreatedAt = new Date(Date.now() - 60_000);
  const leaseExpiresAt = new Date(Date.now() + 600_000);
  await dbWrite
    .insert(agentBackupCatalogAuthorities)
    .values({ organization_id: ORGANIZATION_ID, agent_id: AGENT_ID, catalog_revision: 3n });
  await dbWrite.insert(agentSandboxBackups).values({
    id: BACKUP_ID,
    sandbox_record_id: null,
    snapshot_type: "auto",
    state_data: { memories: [], config: {}, workspaceFiles: {} },
    state_data_storage: "inline",
    size_bytes: 92,
    backup_kind: "full",
    backup_operation_id: BACKUP_OPERATION_ID,
    catalog_version: 2,
    catalog_state: "protected",
    catalog_payload_digest: BACKUP_DIGEST,
    catalog_revision: 3n,
    catalog_organization_id: ORGANIZATION_ID,
    catalog_agent_id: AGENT_ID,
    lifecycle_generation: BACKUP_ACTIVATION_GENERATION,
    lifecycle_revision: 6n,
    source_provider: "operator-onboarded",
    source_node_record_id: NODE_RECORD_ID,
    source_node_id: "backup-source-node",
    source_node_incarnation: "00000000-0000-4000-8000-00000000a00f",
    source_provider_server_id: null,
    source_provider_handle: "backup-source-handle",
    source_container_id: "8".repeat(64),
    retention_reason: "pre-upgrade",
    retention_until: new Date("2027-08-23T00:00:00.000Z"),
    manifest_format: "elizaos.agent-backup",
    manifest_version: 3,
    manifest_digest: BACKUP_DIGEST,
    manifest_canonical_draft: "{}",
    manifest_object_count: 1,
    object_inventory_digest: BACKUP_DIGEST,
    image_digest: `sha256:${BACKUP_DIGEST}`,
    database_schema_version: "1",
    plugin_set_digest: BACKUP_DIGEST,
    watermark_digest: BACKUP_DIGEST,
    raw_size_bytes: 1,
    compressed_size_bytes: 1,
    encrypted_size_bytes: 92,
    kms_key_id: `org:${ORGANIZATION_ID}/backup/v1`,
    kms_key_version: 1,
    operation_key_bundle_generation_id: "00000000-0000-4000-8000-00000000a010",
    operation_key_bundle_format: "kms-aead-operation-key-bundle-v1",
    operation_key_bundle_ref: `backup-key-bundle:${BACKUP_OPERATION_ID}`,
    operation_key_bundle_ciphertext_base64: Buffer.alloc(92, 0x44).toString("base64"),
    operation_key_bundle_sha256: BACKUP_DIGEST,
    operation_key_bundle_size_bytes: 92,
    operation_key_bundle_context: "{}",
    operation_key_bundle_context_derivation: "elizaos.agent-backup.operation-key-bundle-context.v1",
    operation_key_bundle_local_receipt_derivation:
      "elizaos.kms-aead-operation-key-bundle.local-receipt.v1",
    operation_key_bundle_local_receipt_digest: BACKUP_DIGEST,
    vault_key_generation_id: "00000000-0000-4000-8000-00000000a011",
    vault_key_authority_receipt_digest: BACKUP_DIGEST,
  });
  await dbWrite.insert(agentBackupRestoreLeases).values({
    id: RESTORE_LEASE_ID,
    organization_id: ORGANIZATION_ID,
    agent_id: AGENT_ID,
    backup_id: BACKUP_ID,
    operation_id: BACKUP_OPERATION_ID,
    activation_generation: BACKUP_ACTIVATION_GENERATION,
    lifecycle_revision: 6n,
    expected_manifest_sha256: BACKUP_DIGEST,
    copy_role: "primary",
    restore_attempt_id: RESTORE_ATTEMPT_ID,
    owner_id: "restore-worker",
    generation: RESTORE_FENCE,
    catalog_epoch: 3n,
    expires_at: leaseExpiresAt,
    created_at: leaseCreatedAt,
  });
  return {
    leaseId: RESTORE_LEASE_ID,
    backupId: BACKUP_ID,
    restoreAttemptId: RESTORE_ATTEMPT_ID,
    ownerId: "restore-worker",
    fencingToken: RESTORE_FENCE,
    catalogEpoch: "3",
    copyRole: "primary",
    operationId: BACKUP_OPERATION_ID,
    sourceActivationGeneration: BACKUP_ACTIVATION_GENERATION,
    sourceLifecycleRevision: "6",
    expectedManifestSha256: BACKUP_DIGEST,
    expiresAt: leaseExpiresAt,
  };
}

/** Install the database-level guards that Drizzle's table DSL cannot express. */
async function installReplacementAttemptGuards(): Promise<void> {
  await dbWrite.execute(
    sql.raw(`
    CREATE FUNCTION guard_agent_sandbox_replacement_attempt() RETURNS trigger
    LANGUAGE plpgsql AS $guard$
    BEGIN
      IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'replacement attempts cannot be truncated';
      END IF;
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'replacement attempts cannot be deleted';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'in_flight_unresolved'
          OR num_nonnulls(
            NEW.locator_sandbox_id, NEW.locator_node_id, NEW.locator_container_name,
            NEW.locator_node_record_id, NEW.locator_node_hostname, NEW.locator_node_ssh_port,
            NEW.locator_node_ssh_user, NEW.locator_node_host_key_fingerprint,
            NEW.locator_secret_cleanup_version, NEW.locator_allocation_counted,
            NEW.locator_vpn_node_name, NEW.locator_vpn_registration_started_at,
            NEW.locator_previous_vpn_node_id, NEW.locator_recorded_at,
            NEW.locator_container_id, NEW.locator_container_recorded_at,
            NEW.locator_vpn_node_id, NEW.locator_vpn_recorded_at,
            NEW.provider_succeeded_at, NEW.provider_receipt_digest,
            NEW.lifecycle_committed_at, NEW.lifecycle_receipt_digest,
            NEW.cleanup_proven_at, NEW.cleanup_receipt_digest
          ) <> 0 THEN
          RAISE EXCEPTION 'replacement attempt must start before any provider evidence';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.state IN ('lifecycle_committed', 'cleanup_proven') THEN
        RAISE EXCEPTION 'terminal replacement attempt is immutable';
      END IF;
      IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'replacement attempt timestamp cannot rewind';
      END IF;
      IF ROW(
          OLD.id, OLD.organization_id, OLD.agent_id, OLD.operation_kind,
          OLD.lifecycle_revision, OLD.activation_generation, OLD.lifecycle_job_id,
          OLD.lifecycle_execution_generation, OLD.restore_lease_id, OLD.restore_backup_id,
          OLD.restore_attempt_id, OLD.restore_lease_owner_id, OLD.restore_lease_generation,
          OLD.restore_catalog_epoch, OLD.restore_copy_role, OLD.restore_operation_id,
          OLD.restore_source_activation_generation, OLD.restore_source_lifecycle_revision,
          OLD.restore_manifest_sha256, OLD.restore_lease_expires_at, OLD.created_at
        ) IS DISTINCT FROM ROW(
          NEW.id, NEW.organization_id, NEW.agent_id, NEW.operation_kind,
          NEW.lifecycle_revision, NEW.activation_generation, NEW.lifecycle_job_id,
          NEW.lifecycle_execution_generation, NEW.restore_lease_id, NEW.restore_backup_id,
          NEW.restore_attempt_id, NEW.restore_lease_owner_id, NEW.restore_lease_generation,
          NEW.restore_catalog_epoch, NEW.restore_copy_role, NEW.restore_operation_id,
          NEW.restore_source_activation_generation, NEW.restore_source_lifecycle_revision,
          NEW.restore_manifest_sha256, NEW.restore_lease_expires_at, NEW.created_at
        ) THEN
        RAISE EXCEPTION 'replacement attempt identity is immutable';
      END IF;

      IF OLD.locator_recorded_at IS NULL THEN
        IF NEW.locator_recorded_at IS NOT NULL
          AND (NEW.locator_container_id IS NOT NULL OR NEW.locator_vpn_node_id IS NOT NULL) THEN
          RAISE EXCEPTION 'replacement locator enrichments cannot skip intent';
        END IF;
      ELSIF ROW(
          OLD.locator_sandbox_id, OLD.locator_node_id, OLD.locator_container_name,
          OLD.locator_node_record_id, OLD.locator_node_hostname, OLD.locator_node_ssh_port,
          OLD.locator_node_ssh_user, OLD.locator_node_host_key_fingerprint,
          OLD.locator_secret_cleanup_version, OLD.locator_allocation_counted,
          OLD.locator_vpn_node_name, OLD.locator_vpn_registration_started_at,
          OLD.locator_previous_vpn_node_id, OLD.locator_recorded_at
        ) IS DISTINCT FROM ROW(
          NEW.locator_sandbox_id, NEW.locator_node_id, NEW.locator_container_name,
          NEW.locator_node_record_id, NEW.locator_node_hostname, NEW.locator_node_ssh_port,
          NEW.locator_node_ssh_user, NEW.locator_node_host_key_fingerprint,
          NEW.locator_secret_cleanup_version, NEW.locator_allocation_counted,
          NEW.locator_vpn_node_name, NEW.locator_vpn_registration_started_at,
          NEW.locator_previous_vpn_node_id, NEW.locator_recorded_at
        ) THEN
        RAISE EXCEPTION 'replacement locator identity is immutable';
      END IF;

      IF OLD.locator_container_id IS NULL THEN
        IF NEW.locator_container_id IS NOT NULL AND OLD.locator_recorded_at IS NULL THEN
          RAISE EXCEPTION 'replacement Docker enrichment requires durable intent';
        END IF;
      ELSIF ROW(OLD.locator_container_id, OLD.locator_container_recorded_at)
        IS DISTINCT FROM ROW(NEW.locator_container_id, NEW.locator_container_recorded_at) THEN
        RAISE EXCEPTION 'replacement Docker enrichment is immutable';
      END IF;
      IF OLD.locator_vpn_node_id IS NULL THEN
        IF NEW.locator_vpn_node_id IS NOT NULL AND OLD.locator_container_id IS NULL THEN
          RAISE EXCEPTION 'replacement VPN enrichment requires durable Docker identity';
        END IF;
      ELSIF ROW(OLD.locator_vpn_node_id, OLD.locator_vpn_recorded_at)
        IS DISTINCT FROM ROW(NEW.locator_vpn_node_id, NEW.locator_vpn_recorded_at) THEN
        RAISE EXCEPTION 'replacement VPN enrichment is immutable';
      END IF;

      IF OLD.provider_succeeded_at IS NOT NULL
        AND ROW(OLD.provider_succeeded_at, OLD.provider_receipt_digest)
          IS DISTINCT FROM ROW(NEW.provider_succeeded_at, NEW.provider_receipt_digest) THEN
        RAISE EXCEPTION 'replacement provider receipt is immutable';
      END IF;
      IF OLD.lifecycle_committed_at IS NOT NULL
        AND ROW(OLD.lifecycle_committed_at, OLD.lifecycle_receipt_digest)
          IS DISTINCT FROM ROW(NEW.lifecycle_committed_at, NEW.lifecycle_receipt_digest) THEN
        RAISE EXCEPTION 'replacement lifecycle receipt is immutable';
      END IF;
      IF OLD.cleanup_proven_at IS NOT NULL
        AND ROW(OLD.cleanup_proven_at, OLD.cleanup_receipt_digest)
          IS DISTINCT FROM ROW(NEW.cleanup_proven_at, NEW.cleanup_receipt_digest) THEN
        RAISE EXCEPTION 'replacement cleanup receipt is immutable';
      END IF;

      IF NOT (
        NEW.state = OLD.state
        OR (OLD.state = 'in_flight_unresolved'
          AND NEW.state IN ('provider_succeeded', 'cleanup_proven'))
        OR (OLD.state = 'provider_succeeded'
          AND NEW.state IN ('lifecycle_committed', 'cleanup_proven'))
      ) THEN
        RAISE EXCEPTION 'replacement attempt state transition is not monotonic';
      END IF;
      IF OLD.state = 'in_flight_unresolved' AND NEW.state = 'provider_succeeded'
        AND (OLD.locator_recorded_at IS NULL OR OLD.locator_container_id IS NULL) THEN
        RAISE EXCEPTION 'provider success requires previously durable exact placement';
      END IF;
      IF OLD.state <> 'in_flight_unresolved'
        AND ROW(
          OLD.locator_sandbox_id, OLD.locator_node_id, OLD.locator_container_name,
          OLD.locator_node_record_id, OLD.locator_node_hostname, OLD.locator_node_ssh_port,
          OLD.locator_node_ssh_user, OLD.locator_node_host_key_fingerprint,
          OLD.locator_secret_cleanup_version, OLD.locator_allocation_counted,
          OLD.locator_vpn_node_name, OLD.locator_vpn_registration_started_at,
          OLD.locator_previous_vpn_node_id, OLD.locator_recorded_at,
          OLD.locator_container_id, OLD.locator_container_recorded_at,
          OLD.locator_vpn_node_id, OLD.locator_vpn_recorded_at
        ) IS DISTINCT FROM ROW(
          NEW.locator_sandbox_id, NEW.locator_node_id, NEW.locator_container_name,
          NEW.locator_node_record_id, NEW.locator_node_hostname, NEW.locator_node_ssh_port,
          NEW.locator_node_ssh_user, NEW.locator_node_host_key_fingerprint,
          NEW.locator_secret_cleanup_version, NEW.locator_allocation_counted,
          NEW.locator_vpn_node_name, NEW.locator_vpn_registration_started_at,
          NEW.locator_previous_vpn_node_id, NEW.locator_recorded_at,
          NEW.locator_container_id, NEW.locator_container_recorded_at,
          NEW.locator_vpn_node_id, NEW.locator_vpn_recorded_at
        ) THEN
        RAISE EXCEPTION 'settled replacement locator is immutable';
      END IF;
      RETURN NEW;
    END;
    $guard$;
  `),
  );
  await dbWrite.execute(
    sql.raw(`
      CREATE TRIGGER agent_sandbox_replacement_attempts_guard_row
        BEFORE INSERT OR UPDATE OR DELETE ON agent_sandbox_replacement_attempts
        FOR EACH ROW EXECUTE FUNCTION guard_agent_sandbox_replacement_attempt()
    `),
  );
  await dbWrite.execute(
    sql.raw(`
      CREATE TRIGGER agent_sandbox_replacement_attempts_guard_truncate
        BEFORE TRUNCATE ON agent_sandbox_replacement_attempts
        FOR EACH STATEMENT EXECUTE FUNCTION guard_agent_sandbox_replacement_attempt()
    `),
  );
}

let schemaFailure = "";

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    schemaFailure = "isolated PGlite is required; refusing to mutate an ambient Postgres database";
    return;
  }
  try {
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        agentSandboxes,
        agentNodeIncarnationHistories,
        dockerNodes,
        agentSandboxBackups,
        agentBackupCatalogAuthorities,
        agentBackupRestoreLeases,
        agentSandboxReplacementAttempts,
      } as never,
      dbWrite as never,
    );
    await apply();
    await installReplacementAttemptGuards();
    await dbWrite.execute(
      sql.raw(`
        CREATE FUNCTION test_advance_replacement_sandbox_lifecycle_revision()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          NEW.lifecycle_revision := OLD.lifecycle_revision + 1;
          RETURN NEW;
        END;
        $$
      `),
    );
    await dbWrite.execute(
      sql.raw(`
        CREATE TRIGGER test_replacement_sandbox_lifecycle_revision_trigger
        BEFORE UPDATE ON agent_sandboxes
        FOR EACH ROW
        EXECUTE FUNCTION test_advance_replacement_sandbox_lifecycle_revision()
      `),
    );
  } catch (error) {
    // error-policy:J1 Test setup fails every case loudly instead of skipping DB proofs.
    const cause = (error as { cause?: unknown }).cause;
    schemaFailure = `${error instanceof Error ? error.message : String(error)}; cause: ${
      cause instanceof Error ? cause.message : String(cause ?? "unknown")
    }`;
  }
}, TIMEOUT);

beforeEach(async () => {
  expect(schemaFailure).toBe("");
  await dbWrite.execute(
    sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
      DISABLE TRIGGER agent_sandbox_replacement_attempts_guard_row`),
  );
  await dbWrite.execute(
    sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
      DISABLE TRIGGER agent_sandbox_replacement_attempts_guard_truncate`),
  );
  await dbWrite.delete(agentSandboxReplacementAttempts);
  await dbWrite.delete(agentBackupRestoreLeases);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentBackupCatalogAuthorities);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(dockerNodes);
  await dbWrite.delete(agentNodeIncarnationHistories);
  await dbWrite.delete(organizations);
  await dbWrite.execute(
    sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
      ENABLE TRIGGER agent_sandbox_replacement_attempts_guard_row`),
  );
  await dbWrite.execute(
    sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
      ENABLE TRIGGER agent_sandbox_replacement_attempts_guard_truncate`),
  );
  await dbWrite.insert(organizations).values({
    id: ORGANIZATION_ID,
    name: "Replacement attempt tests",
    slug: "replacement-attempt-tests",
  });
  await dbWrite.insert(users).values({
    id: USER_ID,
    organization_id: ORGANIZATION_ID,
    steward_user_id: "replacement-attempt-test-user",
  });
  await dbWrite.insert(agentSandboxes).values({
    id: AGENT_ID,
    organization_id: ORGANIZATION_ID,
    user_id: USER_ID,
    status: "provisioning",
    lifecycle_job_id: LIFECYCLE_JOB_ID,
    lifecycle_execution_generation: LIFECYCLE_EXECUTION_GENERATION,
    activation_generation: ACTIVATION_GENERATION,
    activation_lifecycle_revision: 7n,
    activation_purpose: "provision",
    activation_phase: "container_pending",
    activation_token_hash: "1".repeat(64),
    activation_token_ciphertext: "test-only-activation-token",
    execution_tier: "dedicated-always",
    sandbox_id: "old-sandbox",
    node_id: "old-node",
    container_name: "old-container",
    lifecycle_revision: 7,
  });
  await dbWrite.insert(dockerNodes).values({
    id: NODE_RECORD_ID,
    node_id: "robot-node-a",
    hostname: "robot-node-a.internal",
    ssh_port: 22,
    capacity: 8,
    allocated_count: 0,
    status: "healthy",
    ssh_user: "root",
    host_key_fingerprint: "SHA256:test-only-pinned-host-key",
  });
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("agent sandbox replacement attempts", () => {
  test("rejects malformed or partial authority and never reuses a caller attempt ID", async () => {
    await expect(
      startAgentSandboxReplacementAttempt(startInput({ operationKind: "replace" as "upgrade" })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      startAgentSandboxReplacementAttempt(startInput({ lifecycleExecutionGeneration: null })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          restoreAuthority: {
            leaseId: RESTORE_LEASE_ID,
          } as AgentSandboxReplacementRestoreAuthority,
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });

    await expect(
      dbWrite.transaction(async (tx) => {
        await startAgentSandboxReplacementAttemptInTransaction(tx, startInput());
        throw new Error("force start admission rollback");
      }),
    ).rejects.toThrow("force start admission rollback");
    expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(0);
    await expect(
      startAgentSandboxReplacementAttempt(startInput({ organizationId: OTHER_ORGANIZATION_ID })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          activationGeneration: "00000000-0000-4000-8000-00000000a024",
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      startAgentSandboxReplacementAttempt(startInput({ lifecycleRevision: "8" })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          lifecycleExecutionGeneration: "00000000-0000-4000-8000-00000000a026",
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    await startAgentSandboxReplacementAttempt(startInput());
    await expect(startAgentSandboxReplacementAttempt(startInput())).rejects.toMatchObject({
      code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    });
    expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(1);
  });

  test("serializes concurrent active ownership and keeps provider success fenced", async () => {
    const contenders = await Promise.allSettled([
      startAgentSandboxReplacementAttempt(startInput()),
      startAgentSandboxReplacementAttempt(startInput({ attemptId: OTHER_ATTEMPT_ID })),
    ]);
    expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = contenders.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" },
    });

    const [owned] = await dbWrite.select().from(agentSandboxReplacementAttempts);
    if (!owned) throw new Error("Expected one active replacement attempt");
    await persistSuccessfulProviderAttemptAfterExistingStart(owned.id);
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          attemptId: owned.id === ATTEMPT_ID ? OTHER_ATTEMPT_ID : ATTEMPT_ID,
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("keeps unresolved and provider effects fenced across rotation until cleanup", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await rotateSandboxLifecycle(7);

    await expect(startAgentSandboxReplacementAttempt(rotatedStartInput("8"))).rejects.toMatchObject(
      { code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" },
    );
    expect(await getAgentSandboxReplacementAttempt(reference(OTHER_ATTEMPT_ID))).toBeNull();
    expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(1);

    await persistSuccessfulProviderAttemptAfterExistingStart(ATTEMPT_ID);
    await expect(startAgentSandboxReplacementAttempt(rotatedStartInput("8"))).rejects.toMatchObject(
      { code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" },
    );
    expect(await getAgentSandboxReplacementAttempt(reference(OTHER_ATTEMPT_ID))).toBeNull();
    expect(await getAgentSandboxReplacementAttempt(reference())).toMatchObject({
      state: "provider_succeeded",
      activation_generation: ACTIVATION_GENERATION,
    });
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      lifecycle_revision: 8,
      activation_generation: NEXT_ACTIVATION_GENERATION,
      lifecycle_job_id: NEXT_LIFECYCLE_JOB_ID,
      lifecycle_execution_generation: NEXT_LIFECYCLE_EXECUTION_GENERATION,
    });

    await seedReplacementCleanupLocator(ATTEMPT_ID, 8);
    expect(
      (await recordAgentSandboxReplacementCleanupProven(reference(), CLEANUP_DIGEST)).replayed,
    ).toBe(false);
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      lifecycle_revision: 10,
      activation_generation: NEXT_ACTIVATION_GENERATION,
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_allocation_counted: null,
    });

    await restampRotatedActivationAuthority(10);
    const rotated = await startAgentSandboxReplacementAttempt(rotatedStartInput("11"));
    expect(rotated).toMatchObject({
      replayed: false,
      attempt: {
        id: OTHER_ATTEMPT_ID,
        state: "in_flight_unresolved",
        activation_generation: NEXT_ACTIVATION_GENERATION,
      },
    });
    expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(2);
  });

  test("keeps a committed generation fenced while allowing a rotated generation", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await persistSuccessfulProviderAttemptAfterExistingStart(ATTEMPT_ID);
    expect((await recordAgentSandboxReplacementLifecycleCommitted(adoptionInput())).replayed).toBe(
      false,
    );

    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({ attemptId: OTHER_ATTEMPT_ID, lifecycleRevision: "8" }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect(await getAgentSandboxReplacementAttempt(reference(OTHER_ATTEMPT_ID))).toBeNull();
    expect(await getAgentSandboxReplacementAttempt(reference())).toMatchObject({
      state: "lifecycle_committed",
      activation_generation: ACTIVATION_GENERATION,
    });

    await rotateSandboxLifecycle(8);
    const rotated = await startAgentSandboxReplacementAttempt(rotatedStartInput("9"));
    expect(rotated).toMatchObject({
      replayed: false,
      attempt: {
        id: OTHER_ATTEMPT_ID,
        state: "in_flight_unresolved",
        activation_generation: NEXT_ACTIVATION_GENERATION,
      },
    });
    expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(2);
  });

  test("rejects partial locators and immutable Docker or VPN enrichment drift", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await expect(
      recordAgentSandboxReplacementCreated(reference(), locator("created")),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", { allocationCounted: false as true }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", { replacementSecretCleanupVersion: 2 as 1 }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", { nodeHostKeyFingerprint: "" }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", { vpnRegistrationStartedAt: null }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", {
          vpnRegistrationStartedAt: "2026-08-23T13:00:00.000+01:00",
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });

    await recordAgentSandboxReplacementIntent(reference(), locator("intent"));
    await recordAgentSandboxReplacementCreated(reference(), locator("created"));
    await expect(
      recordAgentSandboxReplacementCreated(
        reference(),
        locator("created", { containerId: "f".repeat(64) }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      recordAgentSandboxReplacementProviderSucceeded(
        reference(),
        locator("final", { vpnNodeId: null }),
        PROVIDER_DIGEST,
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await recordAgentSandboxReplacementVpnRegistered(reference(), locator("vpn"));
    await expect(
      recordAgentSandboxReplacementVpnRegistered(reference(), locator("vpn", { vpnNodeId: "43" })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("commits or rolls back capacity reservation and durable intent together", async () => {
    await startAgentSandboxReplacementAttempt(startInput());

    const reserveAndRecord = async (
      tx: Parameters<typeof recordAgentSandboxReplacementIntentInTransaction>[0],
    ) => await recordIntentAndReserveCapacityInTransaction(tx, reference(), locator("intent"));

    await expect(
      dbWrite.transaction(async (tx) => {
        await reserveAndRecord(tx);
        throw new Error("force intent reservation rollback");
      }),
    ).rejects.toThrow("force intent reservation rollback");
    expect((await dbWrite.select().from(dockerNodes))[0]?.allocated_count).toBe(0);
    expect((await getAgentSandboxReplacementAttempt(reference()))?.locator_recorded_at).toBeNull();

    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 8 })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));
    await expect(dbWrite.transaction(reserveAndRecord)).rejects.toMatchObject({
      code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    });
    expect((await dbWrite.select().from(dockerNodes))[0]?.allocated_count).toBe(8);
    expect((await getAgentSandboxReplacementAttempt(reference()))?.locator_recorded_at).toBeNull();
    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 0 })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));

    const committed = await dbWrite.transaction(reserveAndRecord);
    expect(committed.replayed).toBe(false);
    expect((await dbWrite.select().from(dockerNodes))[0]?.allocated_count).toBe(1);
    expect((await getAgentSandboxReplacementAttempt(reference()))?.locator_node_record_id).toBe(
      NODE_RECORD_ID,
    );
    expect((await dbWrite.transaction(reserveAndRecord)).replayed).toBe(true);
    expect((await dbWrite.select().from(dockerNodes))[0]?.allocated_count).toBe(1);
  });

  test("makes exact stage and receipt replays idempotent and rejects conflicting bytes", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    expect(
      (await recordAgentSandboxReplacementIntent(reference(), locator("intent"))).replayed,
    ).toBe(false);
    expect(
      (await recordAgentSandboxReplacementIntent(reference(), locator("intent"))).replayed,
    ).toBe(true);
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", { nodeHostname: "drifted.internal" }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    await recordAgentSandboxReplacementCreated(reference(), locator("created"));
    expect(
      (await recordAgentSandboxReplacementCreated(reference(), locator("created"))).replayed,
    ).toBe(true);
    await recordAgentSandboxReplacementVpnRegistered(reference(), locator("vpn"));
    expect(
      (await recordAgentSandboxReplacementVpnRegistered(reference(), locator("vpn"))).replayed,
    ).toBe(true);

    expect(
      (
        await recordAgentSandboxReplacementProviderSucceeded(
          reference(),
          locator("final"),
          PROVIDER_DIGEST,
        )
      ).replayed,
    ).toBe(false);
    expect(
      (
        await recordAgentSandboxReplacementProviderSucceeded(
          reference(),
          locator("final"),
          PROVIDER_DIGEST,
        )
      ).replayed,
    ).toBe(true);
    await expect(
      recordAgentSandboxReplacementProviderSucceeded(reference(), locator("final"), "e".repeat(64)),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    expect((await recordAgentSandboxReplacementLifecycleCommitted(adoptionInput())).replayed).toBe(
      false,
    );
    expect((await recordAgentSandboxReplacementLifecycleCommitted(adoptionInput())).replayed).toBe(
      true,
    );
    await expect(
      recordAgentSandboxReplacementCleanupProven(reference(), CLEANUP_DIGEST),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      recordAgentSandboxReplacementIntent(reference(), locator("intent")),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    const retained = await getAgentSandboxReplacementAttempt(reference());
    expect(retained).toMatchObject({
      state: "lifecycle_committed",
      provider_receipt_digest: PROVIDER_DIGEST,
      lifecycle_receipt_digest: LIFECYCLE_DIGEST,
    });
    await expect(
      startAgentSandboxReplacementAttempt(startInput({ lifecycleRevision: "8" })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({ attemptId: OTHER_ATTEMPT_ID, lifecycleRevision: "8" }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("commits or rolls back lifecycle placement and adoption together", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await persistSuccessfulProviderAttemptAfterExistingStart(ATTEMPT_ID);

    const placeAndAdopt = async (
      tx: Parameters<typeof commitAgentSandboxReplacementLifecycleAdoptionInTransaction>[0],
    ) => await commitLifecyclePlacementInTransaction(tx, adoptionInput());

    await expect(
      dbWrite.transaction(async (tx) => {
        const consumed = await placeAndAdopt(tx);
        expect(consumed.attempt.state).toBe("lifecycle_committed");
        throw new Error("force outer lifecycle rollback");
      }),
    ).rejects.toThrow("force outer lifecycle rollback");
    expect((await getAgentSandboxReplacementAttempt(reference()))?.state).toBe(
      "provider_succeeded",
    );
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      sandbox_id: "old-sandbox",
      node_id: "old-node",
      container_name: "old-container",
      lifecycle_revision: 7,
    });

    await expect(
      dbWrite.transaction((tx) =>
        commitLifecyclePlacementInTransaction(tx, adoptionInput(), {
          sandboxId: "stale-old-sandbox",
          nodeId: "old-node",
          containerName: "old-container",
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect((await getAgentSandboxReplacementAttempt(reference()))?.state).toBe(
      "provider_succeeded",
    );

    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 0 })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));
    await expect(dbWrite.transaction(placeAndAdopt)).rejects.toMatchObject({
      code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    });
    expect((await getAgentSandboxReplacementAttempt(reference()))?.state).toBe(
      "provider_succeeded",
    );
    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 1 })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));

    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
          tx,
          adoptionInput(ATTEMPT_ID, { operationKind: "downgrade" }),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    const adoptionRace = await Promise.allSettled([
      dbWrite.transaction(placeAndAdopt),
      startAgentSandboxReplacementAttempt(startInput({ attemptId: OTHER_ATTEMPT_ID })),
    ]);
    expect(adoptionRace[0]).toMatchObject({ status: "fulfilled", value: { replayed: false } });
    expect(adoptionRace[1]).toMatchObject({
      status: "rejected",
      reason: { code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" },
    });
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      sandbox_id: CONTAINER_NAME,
      node_id: "robot-node-a",
      container_name: CONTAINER_NAME,
      lifecycle_revision: 8,
      replacement_cleanup_sandbox_id: "old-sandbox",
      replacement_cleanup_node_id: "old-node",
      replacement_cleanup_container_name: "old-container",
    });
    const replayed = await dbWrite.transaction(placeAndAdopt);
    expect(replayed.replayed).toBe(true);
    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
          tx,
          adoptionInput(ATTEMPT_ID, { lifecycleReceiptDigest: "e".repeat(64) }),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
          tx,
          adoptionInput(ATTEMPT_ID, { providerReceiptDigest: "f".repeat(64) }),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("freezes exact live restore authority and never expires the replacement fence with its lease", async () => {
    const restoreAuthority = await seedRestoreLease();
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          restoreAuthority: {
            ...restoreAuthority,
            expiresAt: new Date(restoreAuthority.expiresAt.getTime() + 1),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    const started = await startAgentSandboxReplacementAttempt(startInput({ restoreAuthority }));
    expect(started.attempt).toMatchObject({
      restore_lease_id: RESTORE_LEASE_ID,
      restore_backup_id: BACKUP_ID,
      restore_attempt_id: RESTORE_ATTEMPT_ID,
      restore_lease_generation: RESTORE_FENCE,
      restore_catalog_epoch: 3n,
      restore_copy_role: "primary",
      restore_operation_id: BACKUP_OPERATION_ID,
      restore_source_activation_generation: BACKUP_ACTIVATION_GENERATION,
      restore_source_lifecycle_revision: 6n,
      restore_manifest_sha256: BACKUP_DIGEST,
    });
    expect(started.attempt.restore_lease_expires_at?.getTime()).toBe(
      restoreAuthority.expiresAt.getTime(),
    );

    await dbWrite
      .update(agentBackupRestoreLeases)
      .set({ expires_at: new Date(Date.now() - 1_000), released_at: new Date() })
      .where(eq(agentBackupRestoreLeases.id, RESTORE_LEASE_ID));
    expect((await getAgentSandboxReplacementAttempt(reference()))?.state).toBe(
      "in_flight_unresolved",
    );
    await expect(
      startAgentSandboxReplacementAttempt(startInput({ attemptId: OTHER_ATTEMPT_ID })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    await persistSuccessfulProviderAttemptAfterExistingStart(ATTEMPT_ID);
    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
          tx,
          adoptionInput(ATTEMPT_ID, {
            restoreAuthority: {
              ...restoreAuthority,
              expiresAt: new Date(restoreAuthority.expiresAt.getTime() + 1),
            },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect(
      (
        await recordAgentSandboxReplacementLifecycleCommitted(
          adoptionInput(ATTEMPT_ID, { restoreAuthority }),
        )
      ).attempt.state,
    ).toBe("lifecycle_committed");
  });

  test("serializes cleanup with a new start and never reopens either terminal state", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await expect(
      recordAgentSandboxReplacementLifecycleCommitted(adoptionInput()),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect(
      (await recordAgentSandboxReplacementCleanupProven(reference(), CLEANUP_DIGEST)).replayed,
    ).toBe(false);
    expect(
      (await recordAgentSandboxReplacementCleanupProven(reference(), CLEANUP_DIGEST)).replayed,
    ).toBe(true);
    await expect(
      recordAgentSandboxReplacementCleanupProven(reference(), "e".repeat(64)),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      recordAgentSandboxReplacementProviderSucceeded(
        reference(),
        locator("final"),
        PROVIDER_DIGEST,
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    await startAgentSandboxReplacementAttempt(startInput({ attemptId: OTHER_ATTEMPT_ID }));
    const otherReference = reference(OTHER_ATTEMPT_ID);
    await recordAgentSandboxReplacementIntent(
      otherReference,
      locator("intent", { replacementAttemptId: OTHER_ATTEMPT_ID }),
    );
    await recordAgentSandboxReplacementCreated(
      otherReference,
      locator("created", { replacementAttemptId: OTHER_ATTEMPT_ID }),
    );
    await recordAgentSandboxReplacementVpnRegistered(
      otherReference,
      locator("vpn", { replacementAttemptId: OTHER_ATTEMPT_ID }),
    );
    await recordAgentSandboxReplacementProviderSucceeded(
      otherReference,
      locator("final", { replacementAttemptId: OTHER_ATTEMPT_ID }),
      PROVIDER_DIGEST,
    );
    await dbWrite
      .update(agentSandboxes)
      .set({
        replacement_cleanup_sandbox_id: CONTAINER_NAME,
        replacement_cleanup_node_id: "robot-node-a",
        replacement_cleanup_container_name: CONTAINER_NAME,
        replacement_cleanup_attempt_id: OTHER_ATTEMPT_ID,
        replacement_cleanup_container_id: CONTAINER_ID,
        replacement_cleanup_vpn_node_id: "42",
        replacement_cleanup_vpn_node_name: CONTAINER_NAME,
        replacement_cleanup_preserved_vpn_node_id: "41",
        replacement_cleanup_vpn_registration_started_at: new Date("2026-08-23T12:00:00.000Z"),
        replacement_cleanup_allocation_counted: true,
        replacement_cleanup_created_at: new Date("2026-08-23T12:03:00.000Z"),
      })
      .where(
        and(
          eq(agentSandboxes.id, AGENT_ID),
          eq(agentSandboxes.organization_id, ORGANIZATION_ID),
          eq(agentSandboxes.lifecycle_revision, 7),
        ),
      );

    const clearReleaseAndSettle = async (tx: ReplacementTransaction) =>
      await settleCleanupResourcesInTransaction(tx, otherReference, CLEANUP_DIGEST);

    await expect(
      dbWrite.transaction(async (tx) => {
        await clearReleaseAndSettle(tx);
        throw new Error("force cleanup convergence rollback");
      }),
    ).rejects.toThrow("force cleanup convergence rollback");
    expect((await getAgentSandboxReplacementAttempt(otherReference))?.state).toBe(
      "provider_succeeded",
    );
    expect((await dbWrite.select().from(dockerNodes))[0]?.allocated_count).toBe(1);
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      lifecycle_revision: 8,
      replacement_cleanup_attempt_id: OTHER_ATTEMPT_ID,
      replacement_cleanup_allocation_counted: true,
    });

    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 0 })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));
    await expect(dbWrite.transaction(clearReleaseAndSettle)).rejects.toMatchObject({
      code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    });
    expect((await getAgentSandboxReplacementAttempt(otherReference))?.state).toBe(
      "provider_succeeded",
    );
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      lifecycle_revision: 8,
      replacement_cleanup_attempt_id: OTHER_ATTEMPT_ID,
      replacement_cleanup_allocation_counted: true,
    });
    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 1 })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));

    const cleanupLocked = deferredSignal();
    const allowCleanupCommit = deferredSignal();
    const cleanupPromise = dbWrite.transaction((tx) =>
      settleCleanupResourcesInTransaction(tx, otherReference, CLEANUP_DIGEST, async () => {
        cleanupLocked.resolve();
        await allowCleanupCommit.promise;
      }),
    );
    await cleanupLocked.promise;
    const nextStartPromise = startAgentSandboxReplacementAttempt(
      startInput({ attemptId: THIRD_ATTEMPT_ID, lifecycleRevision: "9" }),
    );
    await Promise.resolve();
    allowCleanupCommit.resolve();
    const [cleanupResult, nextStartResult] = await Promise.allSettled([
      cleanupPromise,
      nextStartPromise,
    ]);
    expect(cleanupResult).toMatchObject({
      status: "fulfilled",
      value: { replayed: false, attempt: { state: "cleanup_proven" } },
    });
    expect(nextStartResult).toMatchObject({
      status: "fulfilled",
      value: { replayed: false, attempt: { id: THIRD_ATTEMPT_ID } },
    });
    expect((await dbWrite.select().from(dockerNodes))[0]?.allocated_count).toBe(0);
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      lifecycle_revision: 9,
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_allocation_counted: null,
    });
    expect((await dbWrite.transaction(clearReleaseAndSettle)).replayed).toBe(true);
    expect((await dbWrite.select().from(dockerNodes))[0]?.allocated_count).toBe(0);
    await expect(
      recordAgentSandboxReplacementCleanupProven(otherReference, "e".repeat(64)),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      recordAgentSandboxReplacementLifecycleCommitted(adoptionInput(OTHER_ATTEMPT_ID)),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({ attemptId: OTHER_ATTEMPT_ID, lifecycleRevision: "9" }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("does not clear an unresolved attempt because its durable row is old", async () => {
    const oldTimestamp = new Date("2025-08-23T00:00:00.000Z");
    await dbWrite.insert(agentSandboxReplacementAttempts).values({
      id: AGED_ATTEMPT_ID,
      organization_id: ORGANIZATION_ID,
      agent_id: AGENT_ID,
      operation_kind: "provision",
      lifecycle_revision: 0n,
      activation_generation: ACTIVATION_GENERATION,
      lifecycle_job_id: null,
      lifecycle_execution_generation: null,
      created_at: oldTimestamp,
      updated_at: oldTimestamp,
    });

    expect(
      (await getAgentSandboxReplacementAttempt(reference(AGED_ATTEMPT_ID)))?.created_at,
    ).toEqual(oldTimestamp);
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          attemptId: OTHER_ATTEMPT_ID,
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("rejects raw settlement timestamps that precede the last durable locator stage", async () => {
    const locatorRecordedAt = new Date("2026-08-23T12:00:00.000Z");
    const containerRecordedAt = new Date("2026-08-23T12:01:00.000Z");
    const vpnRecordedAt = new Date("2026-08-23T12:02:00.000Z");
    await dbWrite.execute(
      sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
        DISABLE TRIGGER agent_sandbox_replacement_attempts_guard_row`),
    );
    try {
      const invalidRows: (typeof agentSandboxReplacementAttempts.$inferInsert)[] = [
        rawSettledAttempt({
          attemptId: "00000000-0000-4000-8000-00000000a014",
          activationGeneration: "00000000-0000-4000-8000-00000000a017",
          state: "provider_succeeded",
          locatorRecordedAt,
          containerRecordedAt,
          vpnRecordedAt: new Date("2026-08-23T12:00:30.000Z"),
          settledAt: new Date("2026-08-23T12:03:00.000Z"),
        }),
        rawSettledAttempt({
          attemptId: "00000000-0000-4000-8000-00000000a015",
          activationGeneration: "00000000-0000-4000-8000-00000000a018",
          state: "provider_succeeded",
          locatorRecordedAt,
          containerRecordedAt,
          vpnRecordedAt,
          settledAt: new Date("2026-08-23T12:01:30.000Z"),
        }),
        rawSettledAttempt({
          attemptId: "00000000-0000-4000-8000-00000000a016",
          activationGeneration: "00000000-0000-4000-8000-00000000a019",
          state: "cleanup_proven",
          locatorRecordedAt,
          containerRecordedAt,
          vpnRecordedAt,
          settledAt: new Date("2026-08-23T12:01:30.000Z"),
        }),
        {
          ...rawSettledAttempt({
            attemptId: "00000000-0000-4000-8000-00000000a020",
            activationGeneration: "00000000-0000-4000-8000-00000000a021",
            state: "provider_succeeded",
            locatorRecordedAt,
            containerRecordedAt,
            vpnRecordedAt,
            settledAt: new Date("2026-08-23T12:03:00.000Z"),
          }),
          locator_vpn_node_id: null,
          locator_vpn_recorded_at: null,
        },
      ];
      for (const row of invalidRows) {
        await expect(
          (async () => {
            await dbWrite.insert(agentSandboxReplacementAttempts).values(row);
          })(),
        ).rejects.toThrow();
      }
      expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(0);
    } finally {
      await dbWrite.execute(
        sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
          ENABLE TRIGGER agent_sandbox_replacement_attempts_guard_row`),
      );
    }
  });

  test("rejects raw identity tamper, state rewind, terminal mutation, delete, and reuse", async () => {
    await expect(
      (async () => {
        await dbWrite.insert(agentSandboxReplacementAttempts).values({
          id: ATTEMPT_ID,
          organization_id: ORGANIZATION_ID,
          agent_id: AGENT_ID,
          operation_kind: "upgrade",
          lifecycle_revision: 7n,
          activation_generation: ACTIVATION_GENERATION,
          lifecycle_job_id: LIFECYCLE_JOB_ID,
          lifecycle_execution_generation: LIFECYCLE_EXECUTION_GENERATION,
          state: "cleanup_proven",
          cleanup_proven_at: new Date(),
          cleanup_receipt_digest: CLEANUP_DIGEST,
        });
      })(),
    ).rejects.toThrow();

    await startAgentSandboxReplacementAttempt(startInput());
    await recordAgentSandboxReplacementIntent(reference(), locator("intent"));
    await expect(
      (async () => {
        await dbWrite
          .update(agentSandboxReplacementAttempts)
          .set({ lifecycle_revision: 8n })
          .where(eq(agentSandboxReplacementAttempts.id, ATTEMPT_ID));
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite
          .update(agentSandboxReplacementAttempts)
          .set({ locator_node_hostname: "drifted.internal" })
          .where(eq(agentSandboxReplacementAttempts.id, ATTEMPT_ID));
      })(),
    ).rejects.toThrow();

    await recordAgentSandboxReplacementCreated(reference(), locator("created"));
    await recordAgentSandboxReplacementVpnRegistered(reference(), locator("vpn"));
    await recordAgentSandboxReplacementProviderSucceeded(
      reference(),
      locator("final"),
      PROVIDER_DIGEST,
    );
    await expect(
      (async () => {
        await dbWrite
          .update(agentSandboxReplacementAttempts)
          .set({
            state: "in_flight_unresolved",
            provider_succeeded_at: null,
            provider_receipt_digest: null,
          })
          .where(eq(agentSandboxReplacementAttempts.id, ATTEMPT_ID));
      })(),
    ).rejects.toThrow();

    await recordAgentSandboxReplacementLifecycleCommitted(adoptionInput());
    await expect(
      (async () => {
        await dbWrite
          .update(agentSandboxReplacementAttempts)
          .set({ updated_at: new Date() })
          .where(eq(agentSandboxReplacementAttempts.id, ATTEMPT_ID));
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite
          .delete(agentSandboxReplacementAttempts)
          .where(eq(agentSandboxReplacementAttempts.id, ATTEMPT_ID));
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite.execute(sql.raw("TRUNCATE TABLE agent_sandbox_replacement_attempts"));
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite.delete(organizations).where(eq(organizations.id, ORGANIZATION_ID));
      })(),
    ).rejects.toThrow();
    await expect(startAgentSandboxReplacementAttempt(startInput())).rejects.toMatchObject({
      code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    });
  });
});

async function persistSuccessfulProviderAttemptAfterExistingStart(
  attemptId: string,
): Promise<void> {
  const attemptReference = reference(attemptId);
  await recordAgentSandboxReplacementIntent(
    attemptReference,
    locator("intent", { replacementAttemptId: attemptId }),
  );
  await recordAgentSandboxReplacementCreated(
    attemptReference,
    locator("created", { replacementAttemptId: attemptId }),
  );
  await recordAgentSandboxReplacementVpnRegistered(
    attemptReference,
    locator("vpn", { replacementAttemptId: attemptId }),
  );
  await recordAgentSandboxReplacementProviderSucceeded(
    attemptReference,
    locator("final", { replacementAttemptId: attemptId }),
    PROVIDER_DIGEST,
  );
}
