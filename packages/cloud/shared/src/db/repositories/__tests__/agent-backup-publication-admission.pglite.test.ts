/** PGlite proofs for source-node-detached backup publication admission. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";
import { asc, eq } from "drizzle-orm";
import { installAgentNodeOccurrenceTriggerForTests } from "../../agent-node-occurrence-test-support";
import {
  agentBackupOperationLane,
  agentBackupOperationNodeWatermarks,
  agentBackupOperationTenantWatermarks,
} from "../../schemas/agent-backup-operation-lane";
import { agentActivationPublications } from "../../schemas/agent-backup-restore-history";
import { agentNodeIncarnationHistories } from "../../schemas/agent-node-incarnation-histories";
import {
  type AgentBackupCatalogState,
  agentBackupCatalogAuthorities,
  agentSandboxBackups,
  agentSandboxes,
} from "../../schemas/agent-sandboxes";
import { dockerNodes } from "../../schemas/docker-nodes";
import { organizations } from "../../schemas/organizations";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";

process.env.DATABASE_URL = "pglite://memory";
process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "1";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const PGLITE_TIMEOUT = 60_000;
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000201";
const USER_ID = "20000000-0000-4000-8000-000000000201";
const AGENT_ID = "30000000-0000-4000-8000-000000000201";
const OPERATION_A = "40000000-0000-4000-8000-000000000201";
const OPERATION_B = "40000000-0000-4000-8000-000000000202";
const ACTIVATION_GENERATION = "50000000-0000-4000-8000-000000000201";
const ACTIVATION_GENERATION_B = "50000000-0000-4000-8000-000000000202";
const NODE_RECORD_ID = "60000000-0000-4000-8000-000000000201";
const NODE_INCARNATION_A = "70000000-0000-4000-8000-000000000201";
const NODE_INCARNATION_B = "70000000-0000-4000-8000-000000000202";
const CALLER_GENERATION_A = "80000000-0000-4000-8000-000000000201";
const CALLER_GENERATION_B = "80000000-0000-4000-8000-000000000202";
const CALLER_GENERATION_C = "80000000-0000-4000-8000-000000000203";
const ACTIVATION_PUBLICATION_ID = "90000000-0000-4000-8000-000000000201";
const ACTIVATION_PUBLICATION_ID_B = "90000000-0000-4000-8000-000000000202";
const OWNER_A = "backup-publication-admission-worker-a";
const OWNER_B = "backup-publication-admission-worker-b";
const NODE_ID = "robot-backup-publication-admission";
const PROVIDER_HANDLE = "backup-publication-admission-container";
const CONTAINER_ID = "a".repeat(64);
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const OTHER_IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const SHA_A = "d".repeat(64);
const SHA_B = "e".repeat(64);
const SHA_C = "f".repeat(64);
const ACTIVATION_PUBLISHED_AT = new Date("2026-08-17T00:00:00.000Z");
const ACTIVATION_RECEIPT = Object.freeze({
  schemaVersion: 1 as const,
  generation: ACTIVATION_GENERATION,
  purpose: "provision" as const,
  agentId: AGENT_ID,
  organizationId: ORGANIZATION_ID,
  lifecycleRevision: "0",
  backupId: null,
  backupHash: null,
  manifestHash: null,
  componentHashes: null,
  freshAuthorization: null,
  containerId: CONTAINER_ID,
  imageDigest: IMAGE_DIGEST,
  receiptId: NODE_INCARNATION_A,
  receiptHash: SHA_A,
  receiptMac: SHA_B,
  appliedAt: "2026-08-17T00:00:00.000Z",
  restored: true,
  requiresRestart: false,
});

type ClientModule = typeof import("../../client");
type PublicationRepository = typeof import("../agent-backup-publication-admission");
type CaptureRepository = typeof import("../agent-backup-operation-admission");
type CatalogRepository = typeof import("../agent-backup-catalog");
type ClaimResult = Awaited<
  ReturnType<PublicationRepository["claimNextAgentBackupPublicationAdmission"]>
>;
type SuccessfulClaim = Extract<ClaimResult, { kind: "claimed" | "replayed" }>;

let dbWrite: ClientModule["dbWrite"];
let closeDatabaseConnectionsForTests: ClientModule["closeDatabaseConnectionsForTests"];
let publicationRepository: PublicationRepository;
let captureRepository: CaptureRepository;
let catalogRepository: CatalogRepository;
let schemaFailure = "";

const callerA = Object.freeze({ ownerId: OWNER_A, generation: CALLER_GENERATION_A });
const callerB = Object.freeze({ ownerId: OWNER_B, generation: CALLER_GENERATION_B });

function requireAdmission(result: ClaimResult): SuccessfulClaim {
  if (result.kind === "empty" || result.kind === "busy") {
    throw new Error(`Expected publication admission, received ${result.kind}`);
  }
  return result;
}

function claimNext(
  callerToken: Readonly<{ ownerId: string; generation: string }> = callerA,
  leaseMs = 60_000,
): Promise<ClaimResult> {
  return publicationRepository.claimNextAgentBackupPublicationAdmission({
    callerToken,
    leaseMs,
  });
}

async function reserveBackup(
  operationId = OPERATION_A,
  activationGeneration = ACTIVATION_GENERATION,
) {
  return catalogRepository.reserveAgentBackupOperation({
    organizationId: ORGANIZATION_ID,
    agentId: AGENT_ID,
    sandboxRecordId: AGENT_ID,
    operationId,
    activationGeneration,
    lifecycleRevision: "0",
    snapshotType: "auto",
    backupKind: "full",
    sourceProvider: "operator-onboarded",
    sourceNodeRecordId: NODE_RECORD_ID,
    sourceNodeId: NODE_ID,
    sourceNodeIncarnation: NODE_INCARNATION_A,
    sourceProviderServerId: null,
    sourceProviderHandle: PROVIDER_HANDLE,
    sourceContainerId: CONTAINER_ID,
    retentionReason: "schedule",
    retentionUntil: new Date("2027-08-17T00:00:00.000Z"),
  });
}

async function stampPublicationState(params: {
  backupId: string;
  state?: (typeof PUBLICATION_STATES)[number];
  retryResumeState?: (typeof PUBLICATION_STATES)[number];
  nextAttemptAt?: Date;
}): Promise<void> {
  const retry = params.retryResumeState !== undefined;
  await dbWrite
    .update(agentSandboxBackups)
    .set({
      catalog_state: retry ? "failed_retryable" : (params.state ?? "captured"),
      catalog_resume_state: retry ? params.retryResumeState : null,
      catalog_next_attempt_at: params.nextAttemptAt ?? new Date("2020-01-01T00:00:00.000Z"),
      catalog_last_error_code: retry ? "PUBLICATION_RETRY" : null,
      catalog_last_error: retry ? "retry fixture" : null,
      manifest_format: "elizaos.agent-backup",
      manifest_version: 2,
      manifest_digest: SHA_A,
      manifest_canonical_draft: "{}",
      manifest_object_count: 1,
      object_inventory_digest: SHA_B,
      image_digest: IMAGE_DIGEST,
      database_schema_version: "1",
      plugin_set_digest: SHA_A,
      watermark_digest: SHA_B,
      raw_size_bytes: 1,
      compressed_size_bytes: 1,
      encrypted_size_bytes: 29,
      kms_key_id: `org:${ORGANIZATION_ID}/dek/v1`,
      kms_key_version: 1,
      wrapped_dek_ref: `backup-dek:${params.backupId}`,
      wrapped_dek_ciphertext_base64: "AQ==",
      wrapped_dek_sha256: SHA_C,
      wrapped_dek_size_bytes: 1,
      wrapped_dek_receipt_digest: SHA_A,
      catalog_updated_at: new Date(),
    })
    .where(eq(agentSandboxBackups.id, params.backupId));
}

async function reservePublication(
  params: {
    operationId?: string;
    state?: (typeof PUBLICATION_STATES)[number];
    retryResumeState?: (typeof PUBLICATION_STATES)[number];
    nextAttemptAt?: Date;
    activationGeneration?: string;
  } = {},
) {
  const backup = await reserveBackup(params.operationId, params.activationGeneration);
  await stampPublicationState({
    backupId: backup.id,
    state: params.state,
    retryResumeState: params.retryResumeState,
    nextAttemptAt: params.nextAttemptAt,
  });
  const [updated] = await dbWrite
    .select()
    .from(agentSandboxBackups)
    .where(eq(agentSandboxBackups.id, backup.id));
  if (!updated) throw new Error("Expected publication backup fixture");
  return updated;
}

async function readAuthorityState() {
  const [lane] = await dbWrite
    .select()
    .from(agentBackupOperationLane)
    .where(eq(agentBackupOperationLane.singleton, true));
  return {
    lane,
    backups: await dbWrite.select().from(agentSandboxBackups).orderBy(asc(agentSandboxBackups.id)),
    tenantWatermarks: await dbWrite
      .select()
      .from(agentBackupOperationTenantWatermarks)
      .orderBy(asc(agentBackupOperationTenantWatermarks.organization_id)),
    nodeWatermarks: await dbWrite
      .select()
      .from(agentBackupOperationNodeWatermarks)
      .orderBy(asc(agentBackupOperationNodeWatermarks.source_node_history_id)),
  };
}

async function expireAdmission(admission: SuccessfulClaim["admission"]): Promise<void> {
  const claimedAt = new Date("2020-01-01T00:00:00.000Z");
  const expiredAt = new Date("2020-01-01T00:00:01.000Z");
  await dbWrite.transaction(async (tx) => {
    await tx
      .update(agentBackupOperationLane)
      .set({
        claimed_at: claimedAt,
        lease_expires_at: expiredAt,
        released_at: null,
        updated_at: expiredAt,
      })
      .where(eq(agentBackupOperationLane.singleton, true));
    await tx
      .update(agentSandboxBackups)
      .set({ catalog_lease_expires_at: expiredAt, catalog_updated_at: expiredAt })
      .where(eq(agentSandboxBackups.id, admission.claim.backup.id));
  });
}

const PUBLICATION_STATES = [
  "captured",
  "uploading",
  "primary_uploaded",
  "primary_verified",
  "secondary_pending",
] as const satisfies readonly AgentBackupCatalogState[];

beforeAll(async () => {
  try {
    const client = await import("../../client");
    dbWrite = client.dbWrite;
    closeDatabaseConnectionsForTests = client.closeDatabaseConnectionsForTests;
    publicationRepository = await import("../agent-backup-publication-admission");
    captureRepository = await import("../agent-backup-operation-admission");
    catalogRepository = await import("../agent-backup-catalog");

    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        agentNodeIncarnationHistories,
        dockerNodes,
        agentSandboxes,
        agentSandboxBackups,
        agentBackupCatalogAuthorities,
        agentBackupOperationLane,
        agentBackupOperationTenantWatermarks,
        agentBackupOperationNodeWatermarks,
        agentActivationPublications,
      } as never,
      dbWrite as never,
    );
    await apply();
    await installAgentNodeOccurrenceTriggerForTests((statement) => dbWrite.execute(statement));
  } catch (error) {
    schemaFailure = error instanceof Error ? error.message : String(error);
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(schemaFailure).toBe("");
  await dbWrite.delete(agentBackupOperationNodeWatermarks);
  await dbWrite.delete(agentBackupOperationTenantWatermarks);
  await dbWrite.delete(agentBackupOperationLane);
  await dbWrite.delete(agentActivationPublications);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentBackupCatalogAuthorities);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(dockerNodes);
  await dbWrite.delete(agentNodeIncarnationHistories);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);

  await dbWrite.insert(organizations).values({
    id: ORGANIZATION_ID,
    name: "Backup publication admission organization",
    slug: "backup-publication-admission-organization",
  });
  await dbWrite.insert(users).values({
    id: USER_ID,
    steward_user_id: "backup-publication-admission-user",
    organization_id: ORGANIZATION_ID,
  });
  await dbWrite.insert(dockerNodes).values({
    id: NODE_RECORD_ID,
    node_id: NODE_ID,
    hostname: "robot-backup-publication-admission.example.test",
    host_key_fingerprint: "sha256:backup-publication-admission-host-key",
    fleet_kind: "robot",
    infrastructure_provider: "hetzner",
    provider_server_id: null,
    node_incarnation: NODE_INCARNATION_A,
    status: "healthy",
    enabled: true,
  });
  await dbWrite.insert(agentSandboxes).values({
    id: AGENT_ID,
    organization_id: ORGANIZATION_ID,
    user_id: USER_ID,
    agent_name: "Backup publication admission agent",
    status: "running",
    execution_tier: "dedicated-always",
    sandbox_id: PROVIDER_HANDLE,
    node_id: NODE_ID,
    container_name: PROVIDER_HANDLE,
    image_digest: IMAGE_DIGEST,
    lifecycle_revision: 0,
    activation_generation: ACTIVATION_GENERATION,
    activation_lifecycle_revision: 0n,
    activation_purpose: "provision",
    activation_phase: "active",
    activation_receipt: ACTIVATION_RECEIPT,
    activation_receipt_hash: SHA_A,
    activation_container_id: CONTAINER_ID,
    activation_node_id: NODE_ID,
    activation_image_digest: IMAGE_DIGEST,
    activation_boot_id: NODE_INCARNATION_A,
    activation_token_hash: SHA_B,
    activation_token_ciphertext: "sealed-publication-admission-token",
    activation_funding_revision: 0n,
    activation_authority_published_at: ACTIVATION_PUBLISHED_AT,
    activation_dispatched_at: new Date("2026-08-17T00:00:01.000Z"),
    activation_completed_at: new Date("2026-08-17T00:00:02.000Z"),
  });
  const [sourceNode] = await dbWrite
    .select({ historyId: dockerNodes.current_node_history_id })
    .from(dockerNodes)
    .where(eq(dockerNodes.id, NODE_RECORD_ID));
  if (!sourceNode?.historyId) throw new Error("Expected source occurrence during setup");
  await dbWrite.insert(agentActivationPublications).values({
    id: ACTIVATION_PUBLICATION_ID,
    organization_id: ORGANIZATION_ID,
    agent_id: AGENT_ID,
    activation_generation: ACTIVATION_GENERATION,
    previous_activation_generation: null,
    lifecycle_revision: 0n,
    purpose: "provision",
    backup_id: null,
    backup_manifest_sha256: null,
    activation_receipt: ACTIVATION_RECEIPT,
    activation_receipt_sha256: SHA_A,
    container_id: CONTAINER_ID,
    node_history_id: sourceNode.historyId,
    docker_node_record_id: NODE_RECORD_ID,
    node_id: NODE_ID,
    node_incarnation: NODE_INCARNATION_A,
    image_digest: IMAGE_DIGEST,
    token_sha256: SHA_B,
    funding_revision: 0n,
    published_at: ACTIVATION_PUBLISHED_AT,
  });
  await dbWrite.insert(agentBackupOperationLane).values({ singleton: true });
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

describe("detached backup publication admission on primary PGlite", () => {
  test("returns empty for capture work without mutating authority or creating a node", async () => {
    await reserveBackup();
    const before = await readAuthorityState();
    const nodesBefore = await dbWrite.select().from(dockerNodes);
    const historiesBefore = await dbWrite.select().from(agentNodeIncarnationHistories);

    expect(await claimNext()).toEqual({ kind: "empty" });

    expect(await readAuthorityState()).toEqual(before);
    expect(await dbWrite.select().from(dockerNodes)).toEqual(nodesBefore);
    expect(await dbWrite.select().from(agentNodeIncarnationHistories)).toEqual(historiesBefore);
  });

  test("atomically claims publication, phase, catalogue lease, and historical fairness", async () => {
    const backup = await reservePublication();
    const [publication] = await dbWrite.select().from(agentActivationPublications);
    if (!publication) throw new Error("Expected activation publication fixture");

    const result = requireAdmission(await claimNext());
    expect(result.kind).toBe("claimed");
    expect(result.admission).toMatchObject({
      claim: {
        ownerId: OWNER_A,
        generation: CALLER_GENERATION_A,
        backup: { id: backup.id, backup_operation_id: OPERATION_A },
      },
      laneExecution: {
        ownerId: OWNER_A,
        generation: CALLER_GENERATION_A,
        claimSequence: 1n,
      },
      sourceNodeHistoryId: publication.node_history_id,
    });
    const authority = await readAuthorityState();
    expect(authority.lane).toMatchObject({
      owner_id: OWNER_A,
      generation: CALLER_GENERATION_A,
      organization_id: ORGANIZATION_ID,
      backup_id: backup.id,
      operation_id: OPERATION_A,
      operation_phase: "publication",
      claim_sequence: 1n,
      released_at: null,
    });
    expect(authority.backups[0]?.catalog_lease_expires_at?.getTime()).toBe(
      authority.lane?.lease_expires_at?.getTime(),
    );
    expect(authority.tenantWatermarks).toEqual([
      expect.objectContaining({
        organization_id: ORGANIZATION_ID,
        last_backup_id: backup.id,
        last_operation_id: OPERATION_A,
        last_service_sequence: 1n,
        service_count: 1n,
      }),
    ]);
    expect(authority.nodeWatermarks).toEqual([
      expect.objectContaining({
        source_node_history_id: publication.node_history_id,
        source_node_record_id: NODE_RECORD_ID,
        source_node_incarnation: NODE_INCARNATION_A,
        last_backup_id: backup.id,
        last_operation_id: OPERATION_A,
        last_service_sequence: 1n,
        service_count: 1n,
      }),
    ]);
  });

  for (const state of PUBLICATION_STATES) {
    test(`admits the exact ${state} publication state`, async () => {
      const backup = await reservePublication({ state });
      const result = requireAdmission(await claimNext());
      expect(result.kind).toBe("claimed");
      expect(result.admission.claim.backup).toMatchObject({
        id: backup.id,
        catalog_state: state,
        catalog_resume_state: null,
      });
    });

    test(`admits failed_retryable only when it resumes ${state}`, async () => {
      const backup = await reservePublication({ retryResumeState: state });
      const result = requireAdmission(await claimNext());
      expect(result.kind).toBe("claimed");
      expect(result.admission.claim.backup).toMatchObject({
        id: backup.id,
        catalog_state: "failed_retryable",
        catalog_resume_state: state,
      });
    });
  }

  test("survives sandbox drift plus source-node reboot and deletion without recreating a node", async () => {
    const backup = await reservePublication();
    const [publication] = await dbWrite.select().from(agentActivationPublications);
    if (!publication) throw new Error("Expected activation publication fixture");
    await dbWrite
      .update(agentSandboxes)
      .set({
        status: "stopped",
        activation_token_hash: SHA_C,
        activation_token_ciphertext: "sealed-drifted-publication-token",
      })
      .where(eq(agentSandboxes.id, AGENT_ID));
    await dbWrite
      .update(dockerNodes)
      .set({ node_incarnation: NODE_INCARNATION_B })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));
    await dbWrite.delete(dockerNodes).where(eq(dockerNodes.id, NODE_RECORD_ID));
    expect(await dbWrite.select().from(dockerNodes)).toEqual([]);

    const result = requireAdmission(await claimNext());
    expect(result.kind).toBe("claimed");
    expect(result.admission).toMatchObject({
      claim: { backup: { id: backup.id } },
      sourceNodeHistoryId: publication.node_history_id,
    });
    expect(await dbWrite.select().from(dockerNodes)).toEqual([]);
    expect(await dbWrite.select().from(agentBackupOperationNodeWatermarks)).toEqual([
      expect.objectContaining({ source_node_history_id: publication.node_history_id }),
    ]);
  });

  test("skips an earlier poisoned immutable binding and admits the next publication", async () => {
    const poisoned = await reservePublication({
      operationId: OPERATION_A,
      nextAttemptAt: new Date("2010-01-01T00:00:00.000Z"),
    });
    await dbWrite
      .update(agentSandboxBackups)
      .set({ image_digest: OTHER_IMAGE_DIGEST })
      .where(eq(agentSandboxBackups.id, poisoned.id));
    const valid = await reservePublication({
      operationId: OPERATION_B,
      nextAttemptAt: new Date("2011-01-01T00:00:00.000Z"),
    });

    const result = requireAdmission(await claimNext());
    expect(result.admission.claim.backup.id).toBe(valid.id);
    const [poisonedAfter] = await dbWrite
      .select()
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, poisoned.id));
    expect(poisonedAfter).toMatchObject({
      catalog_lease_owner: null,
      catalog_lease_generation: null,
      catalog_lease_expires_at: null,
    });
  });

  test("skips a semantically poisoned receipt without globally blocking later work", async () => {
    const poisoned = await reservePublication({
      operationId: OPERATION_A,
      nextAttemptAt: new Date("2010-01-01T00:00:00.000Z"),
    });
    const [publication] = await dbWrite
      .select()
      .from(agentActivationPublications)
      .where(eq(agentActivationPublications.id, ACTIVATION_PUBLICATION_ID));
    if (!publication) throw new Error("Expected activation publication fixture");
    await dbWrite
      .update(agentActivationPublications)
      .set({ activation_receipt: { ...ACTIVATION_RECEIPT, restored: false } })
      .where(eq(agentActivationPublications.id, ACTIVATION_PUBLICATION_ID));

    const validReceipt = Object.freeze({
      ...ACTIVATION_RECEIPT,
      generation: ACTIVATION_GENERATION_B,
    });
    await dbWrite.insert(agentActivationPublications).values({
      ...publication,
      id: ACTIVATION_PUBLICATION_ID_B,
      activation_generation: ACTIVATION_GENERATION_B,
      activation_receipt: validReceipt,
    });
    await dbWrite
      .update(agentSandboxes)
      .set({
        activation_generation: ACTIVATION_GENERATION_B,
        activation_receipt: validReceipt,
      })
      .where(eq(agentSandboxes.id, AGENT_ID));
    const valid = await reservePublication({
      operationId: OPERATION_B,
      activationGeneration: ACTIVATION_GENERATION_B,
      nextAttemptAt: new Date("2011-01-01T00:00:00.000Z"),
    });

    const result = requireAdmission(await claimNext());
    expect(result.admission.claim.backup.id).toBe(valid.id);
    const [poisonedAfter] = await dbWrite
      .select()
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, poisoned.id));
    expect(poisonedAfter).toMatchObject({
      catalog_lease_owner: null,
      catalog_lease_generation: null,
      catalog_lease_expires_at: null,
    });
  });

  test("returns busy without leasing a second publication", async () => {
    const first = await reservePublication({ operationId: OPERATION_A });
    const second = await reservePublication({ operationId: OPERATION_B });
    const winner = requireAdmission(await claimNext(callerA));
    expect([first.id, second.id]).toContain(winner.admission.claim.backup.id);

    const blocked = await claimNext(callerB);
    expect(blocked.kind).toBe("busy");
    const backups = await dbWrite.select().from(agentSandboxBackups);
    expect(backups.filter((backup) => backup.catalog_lease_owner !== null)).toHaveLength(1);
    expect(backups.filter((backup) => backup.catalog_lease_owner === null)).toHaveLength(1);
  });

  test("does not replay one active capture as publication even with the same caller token", async () => {
    const backup = await reserveBackup();
    const capture = await captureRepository.claimNextAgentBackupOperationAdmission({
      callerToken: callerA,
      leaseMs: 60_000,
    });
    if (capture.kind === "empty" || capture.kind === "busy") {
      throw new Error(`Expected capture admission, received ${capture.kind}`);
    }
    await stampPublicationState({ backupId: backup.id });

    const publication = await claimNext(callerA);
    expect(publication.kind).toBe("busy");
    const authority = await readAuthorityState();
    expect(authority.lane).toMatchObject({
      operation_phase: "capture",
      claim_sequence: 1n,
    });
    expect(authority.tenantWatermarks[0]).toMatchObject({
      last_service_sequence: 1n,
      service_count: 1n,
    });
    expect(authority.nodeWatermarks[0]).toMatchObject({
      last_service_sequence: 1n,
      service_count: 1n,
    });
  });

  test("replays the exact publication without moving leases or counters", async () => {
    await reservePublication();
    const claimed = requireAdmission(await claimNext());
    const before = await readAuthorityState();

    const replayed = requireAdmission(await claimNext());
    const after = await readAuthorityState();

    expect(replayed.kind).toBe("replayed");
    expect(replayed.admission).toEqual(claimed.admission);
    expect(after).toEqual(before);
  });

  test("uses claimSequence to fence an A/B/A publication caller cycle", async () => {
    await reservePublication();
    const firstA = requireAdmission(await claimNext(callerA));
    expect(firstA.admission.laneExecution.claimSequence).toBe(1n);
    await expireAdmission(firstA.admission);

    const claimB = requireAdmission(await claimNext(callerB));
    expect(claimB.admission.laneExecution.claimSequence).toBe(2n);
    await expireAdmission(claimB.admission);

    const secondA = requireAdmission(await claimNext(callerA));
    expect(secondA.admission.laneExecution).toEqual({
      ...callerA,
      claimSequence: 3n,
    });
  });

  test("renews both leases without shortening and rolls back when catalogue ownership drifts", async () => {
    await reservePublication();
    const claimed = requireAdmission(await claimNext(callerA, 120_000));
    const before = await readAuthorityState();
    const renewed = await publicationRepository.renewAgentBackupPublicationAdmission({
      admission: claimed.admission,
      leaseMs: 1,
    });
    const afterRenew = await readAuthorityState();
    expect(renewed.claim.backup.catalog_lease_expires_at?.getTime()).toBe(
      before.lane?.lease_expires_at?.getTime(),
    );
    expect(afterRenew.lane?.lease_expires_at?.getTime()).toBe(
      before.lane?.lease_expires_at?.getTime(),
    );

    await dbWrite
      .update(agentSandboxBackups)
      .set({ catalog_lease_generation: CALLER_GENERATION_C })
      .where(eq(agentSandboxBackups.id, claimed.admission.claim.backup.id));
    const beforeFailure = await readAuthorityState();
    await expect(
      publicationRepository.renewAgentBackupPublicationAdmission({
        admission: renewed,
        leaseMs: 120_000,
      }),
    ).rejects.toMatchObject({ code: "AGENT_BACKUP_PUBLICATION_ADMISSION_LOST" });
    expect(await readAuthorityState()).toEqual(beforeFailure);
  });

  test("rejects replay and renewal after immutable publication drift", async () => {
    await reservePublication();
    const claimed = requireAdmission(await claimNext());
    await dbWrite
      .update(agentActivationPublications)
      .set({ image_digest: OTHER_IMAGE_DIGEST })
      .where(eq(agentActivationPublications.id, ACTIVATION_PUBLICATION_ID));

    await expect(claimNext()).rejects.toMatchObject({
      code: "AGENT_BACKUP_PUBLICATION_ADMISSION_LOST",
    });
    await expect(
      publicationRepository.renewAgentBackupPublicationAdmission({
        admission: claimed.admission,
        leaseMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: "AGENT_BACKUP_PUBLICATION_ADMISSION_LOST" });
  });
});
