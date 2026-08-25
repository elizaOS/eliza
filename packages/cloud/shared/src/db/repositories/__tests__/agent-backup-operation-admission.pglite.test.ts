/** Real-PGlite proofs for atomic catalogue and provider-lane admission. */

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
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const AGENT_ID = "30000000-0000-4000-8000-000000000001";
const OPERATION_ID = "40000000-0000-4000-8000-000000000001";
const OTHER_OPERATION_ID = "40000000-0000-4000-8000-000000000002";
const ACTIVATION_GENERATION = "50000000-0000-4000-8000-000000000001";
const NODE_RECORD_ID = "60000000-0000-4000-8000-000000000001";
const POISON_NODE_RECORD_ID = "60000000-0000-4000-8000-000000000002";
const NODE_INCARNATION_A = "70000000-0000-4000-8000-000000000001";
const CALLER_GENERATION_A = "80000000-0000-4000-8000-000000000001";
const CALLER_GENERATION_B = "80000000-0000-4000-8000-000000000002";
const CALLER_GENERATION_C = "80000000-0000-4000-8000-000000000003";
const ACTIVATION_PUBLICATION_ID = "90000000-0000-4000-8000-000000000001";
const OWNER_A = "backup-admission-worker-a";
const OWNER_B = "backup-admission-worker-b";
const NODE_ID = "robot-backup-admission-a";
const PROVIDER_HANDLE = "backup-admission-container";
const CONTAINER_ID = "a".repeat(64);
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const SHA_A = "c".repeat(64);
const SHA_B = "d".repeat(64);
const SHA_C = "e".repeat(64);
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
type AdmissionRepository = typeof import("../agent-backup-operation-admission");
type CatalogRepository = typeof import("../agent-backup-catalog");
type ClaimResult = Awaited<
  ReturnType<AdmissionRepository["claimNextAgentBackupOperationAdmission"]>
>;
type SuccessfulClaim = Extract<ClaimResult, { kind: "claimed" | "replayed" }>;

let dbWrite: ClientModule["dbWrite"];
let closeDatabaseConnectionsForTests: ClientModule["closeDatabaseConnectionsForTests"];
let repository: AdmissionRepository;
let catalogRepository: CatalogRepository;
let schemaFailure = "";

const callerA = Object.freeze({ ownerId: OWNER_A, generation: CALLER_GENERATION_A });
const callerB = Object.freeze({ ownerId: OWNER_B, generation: CALLER_GENERATION_B });

function requireAdmission(result: ClaimResult): SuccessfulClaim {
  if (result.kind === "empty" || result.kind === "busy") {
    throw new Error(`Expected an admission, received ${result.kind}`);
  }
  return result;
}

function claimNext(
  callerToken: Readonly<{ ownerId: string; generation: string }> = callerA,
  leaseMs = 60_000,
): Promise<ClaimResult> {
  return repository.claimNextAgentBackupOperationAdmission({ callerToken, leaseMs });
}

async function reserveBackup(operationId = OPERATION_ID) {
  return catalogRepository.reserveAgentBackupOperation({
    organizationId: ORGANIZATION_ID,
    agentId: AGENT_ID,
    sandboxRecordId: AGENT_ID,
    operationId,
    activationGeneration: ACTIVATION_GENERATION,
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
    retentionUntil: new Date("2026-09-17T00:00:00.000Z"),
  });
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

beforeAll(async () => {
  try {
    const client = await import("../../client");
    dbWrite = client.dbWrite;
    closeDatabaseConnectionsForTests = client.closeDatabaseConnectionsForTests;
    repository = await import("../agent-backup-operation-admission");
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
    name: "Backup admission organization",
    slug: "backup-admission-organization",
  });
  await dbWrite.insert(users).values({
    id: USER_ID,
    steward_user_id: "backup-admission-user",
    organization_id: ORGANIZATION_ID,
  });
  await dbWrite.insert(dockerNodes).values({
    id: NODE_RECORD_ID,
    node_id: NODE_ID,
    hostname: "robot-backup-admission-a.example.test",
    host_key_fingerprint: "sha256:backup-admission-host-key",
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
    agent_name: "Backup admission agent",
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
    activation_token_ciphertext: "sealed-admission-token",
    activation_funding_revision: 0n,
    activation_authority_published_at: ACTIVATION_PUBLISHED_AT,
    activation_dispatched_at: new Date("2026-08-17T00:00:01.000Z"),
    activation_completed_at: new Date("2026-08-17T00:00:02.000Z"),
  });
  const [sourceNode] = await dbWrite
    .select({ historyId: dockerNodes.current_node_history_id })
    .from(dockerNodes)
    .where(eq(dockerNodes.id, NODE_RECORD_ID));
  if (!sourceNode?.historyId) throw new Error("Expected source-node occurrence during setup");
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

describe("agent backup operation admission on primary PGlite", () => {
  test("returns empty without mutating any authority or creating a node", async () => {
    const before = await readAuthorityState();
    const beforeNodes = await dbWrite.select().from(dockerNodes);
    const beforeHistories = await dbWrite.select().from(agentNodeIncarnationHistories);

    expect(await claimNext()).toEqual({ kind: "empty" });

    expect(await readAuthorityState()).toEqual(before);
    expect(await dbWrite.select().from(dockerNodes)).toEqual(beforeNodes);
    expect(await dbWrite.select().from(agentNodeIncarnationHistories)).toEqual(beforeHistories);
  });

  test("atomically claims catalogue, global lane, and exact fairness watermarks", async () => {
    const reserved = await reserveBackup();
    const [sourceNode] = await dbWrite
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.id, NODE_RECORD_ID));
    if (!sourceNode?.current_node_history_id) {
      throw new Error("Expected the trigger-owned source-node occurrence");
    }

    const result = requireAdmission(await claimNext());
    expect(result.kind).toBe("claimed");
    expect(result.admission).toMatchObject({
      claim: {
        ownerId: OWNER_A,
        generation: CALLER_GENERATION_A,
        backup: {
          id: reserved.id,
          catalog_organization_id: ORGANIZATION_ID,
          backup_operation_id: OPERATION_ID,
          catalog_lease_owner: OWNER_A,
          catalog_lease_generation: CALLER_GENERATION_A,
        },
      },
      laneExecution: {
        ownerId: OWNER_A,
        generation: CALLER_GENERATION_A,
        claimSequence: 1n,
      },
      sourceNodeHistoryId: sourceNode.current_node_history_id,
    });

    const state = await readAuthorityState();
    expect(state.lane).toMatchObject({
      owner_id: OWNER_A,
      generation: CALLER_GENERATION_A,
      organization_id: ORGANIZATION_ID,
      backup_id: reserved.id,
      operation_id: OPERATION_ID,
      claim_sequence: 1n,
      released_at: null,
    });
    const catalogueExpiry = state.backups[0]?.catalog_lease_expires_at;
    expect(catalogueExpiry).toBeInstanceOf(Date);
    expect(state.lane?.lease_expires_at?.getTime()).toBe(catalogueExpiry?.getTime());
    expect(state.tenantWatermarks).toEqual([
      expect.objectContaining({
        organization_id: ORGANIZATION_ID,
        last_backup_id: reserved.id,
        last_operation_id: OPERATION_ID,
        last_service_sequence: 1n,
        service_count: 1n,
      }),
    ]);
    expect(state.nodeWatermarks).toEqual([
      expect.objectContaining({
        source_node_history_id: sourceNode.current_node_history_id,
        source_node_record_id: NODE_RECORD_ID,
        source_node_incarnation: NODE_INCARNATION_A,
        last_backup_id: reserved.id,
        last_operation_id: OPERATION_ID,
        last_service_sequence: 1n,
        service_count: 1n,
      }),
    ]);
    expect(await dbWrite.select().from(dockerNodes)).toHaveLength(1);
    expect(await dbWrite.select().from(agentNodeIncarnationHistories)).toHaveLength(1);
  });

  test("replays the exact active caller without moving leases or counters", async () => {
    await reserveBackup();
    const first = requireAdmission(await claimNext());
    const beforeReplay = await readAuthorityState();

    const replay = requireAdmission(await claimNext());
    expect(replay.kind).toBe("replayed");
    expect(replay.admission).toEqual(first.admission);

    const afterReplay = await readAuthorityState();
    expect(afterReplay.lane?.claim_sequence).toBe(1n);
    expect(afterReplay.lane?.claimed_at?.getTime()).toBe(beforeReplay.lane?.claimed_at?.getTime());
    expect(afterReplay.lane?.lease_expires_at?.getTime()).toBe(
      beforeReplay.lane?.lease_expires_at?.getTime(),
    );
    expect(afterReplay.backups[0]?.catalog_lease_expires_at?.getTime()).toBe(
      beforeReplay.backups[0]?.catalog_lease_expires_at?.getTime(),
    );
    expect(afterReplay.backups[0]?.catalog_attempts).toBe(
      beforeReplay.backups[0]?.catalog_attempts,
    );
    expect(afterReplay.tenantWatermarks[0]?.service_count).toBe(1n);
    expect(afterReplay.nodeWatermarks[0]?.service_count).toBe(1n);
  });

  test("skips a poisoned earlier row and admits the next exact capture", async () => {
    const poisoned = await reserveBackup();
    await dbWrite
      .update(agentSandboxBackups)
      .set({ source_node_record_id: POISON_NODE_RECORD_ID })
      .where(eq(agentSandboxBackups.id, poisoned.id));
    const valid = await reserveBackup(OTHER_OPERATION_ID);

    const result = requireAdmission(await claimNext());

    expect(result.kind).toBe("claimed");
    expect(result.admission.claim.backup.id).toBe(valid.id);
    const state = await readAuthorityState();
    expect(state.backups.find((backup) => backup.id === poisoned.id)).toMatchObject({
      catalog_lease_owner: null,
      catalog_lease_generation: null,
      catalog_lease_expires_at: null,
    });
  });

  test("returns busy before leasing another catalogue candidate", async () => {
    await reserveBackup();
    await reserveBackup(OTHER_OPERATION_ID);
    const winner = requireAdmission(await claimNext());
    const beforeBusy = await readAuthorityState();

    const busy = await claimNext(callerB);
    expect(busy.kind).toBe("busy");

    const afterBusy = await readAuthorityState();
    expect(afterBusy.lane).toEqual(beforeBusy.lane);
    expect(afterBusy.tenantWatermarks).toEqual(beforeBusy.tenantWatermarks);
    expect(afterBusy.nodeWatermarks).toEqual(beforeBusy.nodeWatermarks);
    const unclaimed = afterBusy.backups.find(
      (backup) => backup.id !== winner.admission.claim.backup.id,
    );
    expect(unclaimed).toMatchObject({
      catalog_lease_owner: null,
      catalog_lease_generation: null,
      catalog_lease_expires_at: null,
    });
  });

  test("uses claimSequence to fence an A/B/A caller-token cycle", async () => {
    await reserveBackup();
    const firstA = requireAdmission(await claimNext());
    expect(firstA.admission.laneExecution.claimSequence).toBe(1n);
    await expireAdmission(firstA.admission);

    const middleB = requireAdmission(await claimNext(callerB));
    expect(middleB).toMatchObject({
      kind: "claimed",
      admission: { laneExecution: { claimSequence: 2n } },
    });
    await expireAdmission(middleB.admission);

    const currentA = requireAdmission(await claimNext());
    expect(currentA).toMatchObject({
      kind: "claimed",
      admission: { laneExecution: { claimSequence: 3n } },
    });
    await expect(
      repository.renewAgentBackupOperationAdmission({
        admission: firstA.admission,
        leaseMs: 60_000,
      }),
    ).rejects.toThrow();

    const state = await readAuthorityState();
    expect(state.lane).toMatchObject({
      owner_id: OWNER_A,
      generation: CALLER_GENERATION_A,
      claim_sequence: 3n,
    });
    expect(state.backups[0]).toMatchObject({
      catalog_lease_owner: OWNER_A,
      catalog_lease_generation: CALLER_GENERATION_A,
    });
    expect(state.tenantWatermarks[0]).toMatchObject({
      last_service_sequence: 3n,
      service_count: 3n,
    });
    expect(state.nodeWatermarks[0]).toMatchObject({
      last_service_sequence: 3n,
      service_count: 3n,
    });
  });

  test("fails closed across an A1-to-A2 occurrence ABA without partial admission", async () => {
    const reserved = await reserveBackup();
    const [original] = await dbWrite
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.id, NODE_RECORD_ID));
    if (!original?.current_node_history_id) throw new Error("Expected original source occurrence");
    await dbWrite
      .update(dockerNodes)
      .set({ node_incarnation: null })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));
    await dbWrite
      .update(dockerNodes)
      .set({ node_incarnation: NODE_INCARNATION_A })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));
    const [reattested] = await dbWrite
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.id, NODE_RECORD_ID));
    expect(reattested?.current_node_history_id).not.toBeNull();
    expect(reattested?.current_node_history_id).not.toBe(original.current_node_history_id);
    expect(reattested?.node_incarnation).toBe(NODE_INCARNATION_A);
    expect(await dbWrite.select().from(agentNodeIncarnationHistories)).toHaveLength(2);
    const beforeClaim = await readAuthorityState();

    expect(await claimNext()).toEqual({ kind: "empty" });

    expect(await readAuthorityState()).toEqual(beforeClaim);
    expect(beforeClaim.lane).toMatchObject({ owner_id: null, claim_sequence: 0n });
    expect(beforeClaim.backups).toEqual([
      expect.objectContaining({
        id: reserved.id,
        source_node_incarnation: NODE_INCARNATION_A,
        catalog_lease_owner: null,
        catalog_lease_generation: null,
        catalog_lease_expires_at: null,
      }),
    ]);
    expect(await dbWrite.select().from(dockerNodes)).toHaveLength(1);
  });

  test("skips a capture whose live sandbox authority drifted", async () => {
    await reserveBackup();
    await dbWrite
      .update(agentSandboxes)
      .set({ status: "stopped" })
      .where(eq(agentSandboxes.id, AGENT_ID));
    const beforeClaim = await readAuthorityState();

    expect(await claimNext()).toEqual({ kind: "empty" });

    expect(await readAuthorityState()).toEqual(beforeClaim);
  });

  test("skips mutable activation economics or token drift without partial admission", async () => {
    await reserveBackup();
    await dbWrite
      .update(agentSandboxes)
      .set({ activation_token_hash: SHA_C, activation_funding_revision: 1n })
      .where(eq(agentSandboxes.id, AGENT_ID));
    const beforeClaim = await readAuthorityState();

    expect(await claimNext()).toEqual({ kind: "empty" });

    expect(await readAuthorityState()).toEqual(beforeClaim);
  });

  test("rejects replay and renewal after an admitted live source drifts", async () => {
    await reserveBackup();
    const claimed = requireAdmission(await claimNext());
    await dbWrite
      .update(agentSandboxes)
      .set({ status: "stopped" })
      .where(eq(agentSandboxes.id, AGENT_ID));
    const beforeRejectedUse = await readAuthorityState();

    await expect(claimNext()).rejects.toThrow();
    await expect(
      repository.renewAgentBackupOperationAdmission({
        admission: claimed.admission,
        leaseMs: 60_000,
      }),
    ).rejects.toThrow();

    expect(await readAuthorityState()).toEqual(beforeRejectedUse);
  });

  test("renews both leases atomically, never shortens, and rolls back on a stale catalogue", async () => {
    await reserveBackup();
    const claimed = requireAdmission(await claimNext(callerA, 1_000));
    const initial = await readAuthorityState();
    const initialExpiry = initial.lane?.lease_expires_at;
    if (!initialExpiry) throw new Error("Expected an active admission lease");

    const renewed = await repository.renewAgentBackupOperationAdmission({
      admission: claimed.admission,
      leaseMs: 60_000,
    });
    const afterRenew = await readAuthorityState();
    expect(renewed.laneExecution).toEqual(claimed.admission.laneExecution);
    expect(afterRenew.lane?.lease_expires_at?.getTime()).toBeGreaterThan(initialExpiry.getTime());
    expect(afterRenew.lane?.lease_expires_at?.getTime()).toBe(
      afterRenew.backups[0]?.catalog_lease_expires_at?.getTime(),
    );

    await repository.renewAgentBackupOperationAdmission({
      admission: renewed,
      leaseMs: 1,
    });
    const afterShortRenew = await readAuthorityState();
    expect(afterShortRenew.lane?.lease_expires_at?.getTime()).toBe(
      afterRenew.lane?.lease_expires_at?.getTime(),
    );
    expect(afterShortRenew.backups[0]?.catalog_lease_expires_at?.getTime()).toBe(
      afterRenew.backups[0]?.catalog_lease_expires_at?.getTime(),
    );

    await dbWrite
      .update(agentSandboxBackups)
      .set({ catalog_lease_generation: CALLER_GENERATION_C })
      .where(eq(agentSandboxBackups.id, renewed.claim.backup.id));
    const beforeRejectedRenew = await readAuthorityState();
    await expect(
      repository.renewAgentBackupOperationAdmission({ admission: renewed, leaseMs: 120_000 }),
    ).rejects.toThrow();
    expect(await readAuthorityState()).toEqual(beforeRejectedRenew);
  });
});
