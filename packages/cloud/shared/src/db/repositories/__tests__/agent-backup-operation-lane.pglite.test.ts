/** Real-PGlite lifecycle proofs for the global backup provider-execution lane. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { eq } from "drizzle-orm";
import type { DbTransaction } from "../../client";
import type {
  AgentBackupOperationLane,
  AgentBackupOperationNodeWatermark,
  AgentBackupOperationTenantWatermark,
} from "../../schemas/agent-backup-operation-lane";
import type {
  AgentBackupOperationLaneCallerToken,
  AgentBackupOperationLaneClaimResult,
  AgentBackupOperationLaneFairness,
  AgentBackupOperationLaneTarget,
} from "../agent-backup-operation-lane";
import { readPostLockDatabaseNow } from "../primary-database-clock";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const BACKUP_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_BACKUP_ID = "20000000-0000-4000-8000-000000000002";
const OPERATION_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_OPERATION_ID = "30000000-0000-4000-8000-000000000002";
const NODE_RECORD_ID = "40000000-0000-4000-8000-000000000001";
const NODE_HISTORY_ID = "50000000-0000-4000-8000-000000000001";
const NODE_INCARNATION = "60000000-0000-4000-8000-000000000001";
const OTHER_NODE_INCARNATION = "60000000-0000-4000-8000-000000000002";
const GENERATION_A = "70000000-0000-4000-8000-000000000001";
const GENERATION_B = "70000000-0000-4000-8000-000000000002";
const GENERATION_C = "70000000-0000-4000-8000-000000000003";
const UPPERCASE_UUID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAA1";
const OWNER_A = "backup-provider-worker-a";
const OWNER_B = "backup-provider-worker-b";
const PGLITE_TIMEOUT = 60_000;

let dbWrite: typeof import("../../client").dbWrite;
let closeDatabaseConnectionsForTests: typeof import("../../client").closeDatabaseConnectionsForTests;
let organizationsTable: typeof import("../../schemas/organizations").organizations;
let dockerNodesTable: typeof import("../../schemas/docker-nodes").dockerNodes;
let nodeHistoriesTable: typeof import("../../schemas/agent-node-incarnation-histories").agentNodeIncarnationHistories;
let laneTable: typeof import("../../schemas/agent-backup-operation-lane").agentBackupOperationLane;
let tenantWatermarksTable: typeof import("../../schemas/agent-backup-operation-lane").agentBackupOperationTenantWatermarks;
let nodeWatermarksTable: typeof import("../../schemas/agent-backup-operation-lane").agentBackupOperationNodeWatermarks;
let repository: typeof import("../agent-backup-operation-lane");

const target: AgentBackupOperationLaneTarget = {
  organizationId: ORGANIZATION_ID,
  backupId: BACKUP_ID,
  operationId: OPERATION_ID,
  operationPhase: "capture",
};

const fairness: AgentBackupOperationLaneFairness = {
  sourceNodeHistoryId: NODE_HISTORY_ID,
  sourceNodeRecordId: NODE_RECORD_ID,
  sourceNodeIncarnation: NODE_INCARNATION,
};

const callerA: AgentBackupOperationLaneCallerToken = {
  ownerId: OWNER_A,
  generation: GENERATION_A,
};

const callerB: AgentBackupOperationLaneCallerToken = {
  ownerId: OWNER_B,
  generation: GENERATION_B,
};

type SuccessfulClaim = Extract<
  AgentBackupOperationLaneClaimResult,
  { kind: "claimed" | "replayed" }
>;

beforeAll(async () => {
  process.env.DATABASE_URL = "pglite://memory";
  process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "1";
  process.env.NODE_ENV = "test";

  const client = await import("../../client");
  dbWrite = client.dbWrite;
  closeDatabaseConnectionsForTests = client.closeDatabaseConnectionsForTests;
  ({ organizations: organizationsTable } = await import("../../schemas/organizations"));
  ({ dockerNodes: dockerNodesTable } = await import("../../schemas/docker-nodes"));
  ({ agentNodeIncarnationHistories: nodeHistoriesTable } = await import(
    "../../schemas/agent-node-incarnation-histories"
  ));
  ({
    agentBackupOperationLane: laneTable,
    agentBackupOperationTenantWatermarks: tenantWatermarksTable,
    agentBackupOperationNodeWatermarks: nodeWatermarksTable,
  } = await import("../../schemas/agent-backup-operation-lane"));
  repository = await import("../agent-backup-operation-lane");

  const { pushSchemaToTestDb } = await import("../../push-schema-for-tests");
  await pushSchemaToTestDb({
    organizations: organizationsTable,
    agentNodeIncarnationHistories: nodeHistoriesTable,
    dockerNodes: dockerNodesTable,
    agentBackupOperationLane: laneTable,
    agentBackupOperationTenantWatermarks: tenantWatermarksTable,
    agentBackupOperationNodeWatermarks: nodeWatermarksTable,
  });
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  await dbWrite.delete(nodeWatermarksTable);
  await dbWrite.delete(tenantWatermarksTable);
  await dbWrite.delete(laneTable);
  await dbWrite.delete(dockerNodesTable);
  await dbWrite.delete(nodeHistoriesTable);
  await dbWrite.delete(organizationsTable);

  await dbWrite.insert(organizationsTable).values({
    id: ORGANIZATION_ID,
    name: "Backup lane test organization",
    slug: "backup-lane-test",
  });
  await dbWrite.insert(nodeHistoriesTable).values({
    id: NODE_HISTORY_ID,
    docker_node_record_id: NODE_RECORD_ID,
    node_id: "backup-node-a",
    node_incarnation: NODE_INCARNATION,
    fleet_kind: "robot",
    infrastructure_provider: "hetzner",
    provider_server_id: null,
    host_key_fingerprint: "sha256:test-node-key",
  });
  await dbWrite.insert(dockerNodesTable).values({
    id: NODE_RECORD_ID,
    node_id: "backup-node-a",
    hostname: "backup-node-a.example.test",
    host_key_fingerprint: "sha256:test-node-key",
    fleet_kind: "robot",
    infrastructure_provider: "hetzner",
    provider_server_id: null,
    node_incarnation: NODE_INCARNATION,
    current_node_history_id: NODE_HISTORY_ID,
  });
  await dbWrite.insert(laneTable).values({ singleton: true });
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

interface ClaimOverrides {
  target?: AgentBackupOperationLaneTarget;
  callerToken?: AgentBackupOperationLaneCallerToken;
  fairness?: AgentBackupOperationLaneFairness;
  leaseMs?: number;
}

function claimInTransaction(
  tx: DbTransaction,
  overrides: ClaimOverrides = {},
): Promise<AgentBackupOperationLaneClaimResult> {
  return repository.claimAgentBackupOperationLaneInTransaction(tx, {
    ...(overrides.target ?? target),
    callerToken: overrides.callerToken ?? callerA,
    fairness: overrides.fairness ?? fairness,
    leaseMs: overrides.leaseMs ?? 60_000,
  });
}

function claimCommitted(
  overrides: ClaimOverrides = {},
): Promise<AgentBackupOperationLaneClaimResult> {
  return dbWrite.transaction((tx) => claimInTransaction(tx, overrides));
}

function requireSuccessfulClaim(result: AgentBackupOperationLaneClaimResult): SuccessfulClaim {
  if (result.kind === "busy") throw new Error("Expected a claimed or replayed lane");
  return result;
}

async function readLane(): Promise<AgentBackupOperationLane> {
  return repository.readAgentBackupOperationLane();
}

async function readWatermarks(): Promise<{
  tenants: AgentBackupOperationTenantWatermark[];
  nodes: AgentBackupOperationNodeWatermark[];
}> {
  return {
    tenants: await dbWrite.select().from(tenantWatermarksTable),
    nodes: await dbWrite.select().from(nodeWatermarksTable),
  };
}

async function expireLaneInTransaction(tx: DbTransaction): Promise<void> {
  const claimedAt = new Date("2020-01-01T00:00:00.000Z");
  await tx
    .update(laneTable)
    .set({
      claimed_at: claimedAt,
      lease_expires_at: new Date(claimedAt.getTime() + 1_000),
      released_at: null,
      updated_at: new Date(claimedAt.getTime() + 1_000),
    })
    .where(eq(laneTable.singleton, true));
}

async function expectElizaError(promise: Promise<unknown>, code: string): Promise<ElizaError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ElizaError);
    expect(error).toMatchObject({ code, severity: "fatal" });
    return error as ElizaError;
  }
  throw new Error(`Expected ElizaError ${code}`);
}

async function expectFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail");
}

describe("agent backup operation lane lifecycle on primary PGlite", () => {
  test("claims the singleton and atomically stamps tenant and exact-node watermarks", async () => {
    const result = requireSuccessfulClaim(await claimCommitted());

    expect(result.kind).toBe("claimed");
    expect(result.execution).toEqual({ ...callerA, claimSequence: 1n });
    expect(result.proof.active).toBe(true);
    expect(result.proof.lane).toMatchObject({
      singleton: true,
      owner_id: OWNER_A,
      generation: GENERATION_A,
      organization_id: ORGANIZATION_ID,
      backup_id: BACKUP_ID,
      operation_id: OPERATION_ID,
      operation_phase: "capture",
      claim_sequence: 1n,
      released_at: null,
    });

    const { tenants, nodes } = await readWatermarks();
    expect(tenants).toEqual([
      expect.objectContaining({
        organization_id: ORGANIZATION_ID,
        last_backup_id: BACKUP_ID,
        last_operation_id: OPERATION_ID,
        last_service_sequence: 1n,
        service_count: 1n,
      }),
    ]);
    expect(nodes).toEqual([
      expect.objectContaining({
        source_node_history_id: NODE_HISTORY_ID,
        source_node_record_id: NODE_RECORD_ID,
        source_node_incarnation: NODE_INCARNATION,
        last_backup_id: BACKUP_ID,
        last_operation_id: OPERATION_ID,
        last_service_sequence: 1n,
        service_count: 1n,
      }),
    ]);
  });

  test("retains exact-node fairness after the mutable Docker node is deleted", async () => {
    requireSuccessfulClaim(await claimCommitted());

    await dbWrite.delete(dockerNodesTable).where(eq(dockerNodesTable.id, NODE_RECORD_ID));

    expect(await dbWrite.select().from(dockerNodesTable)).toEqual([]);
    expect((await readWatermarks()).nodes).toEqual([
      expect.objectContaining({
        source_node_history_id: NODE_HISTORY_ID,
        source_node_record_id: NODE_RECORD_ID,
        source_node_incarnation: NODE_INCARNATION,
        last_service_sequence: 1n,
      }),
    ]);
    await expect(
      dbWrite
        .delete(nodeHistoriesTable)
        .where(eq(nodeHistoriesTable.id, NODE_HISTORY_ID))
        .execute(),
    ).rejects.toThrow();
    expect(
      await dbWrite
        .select({ id: nodeHistoriesTable.id })
        .from(nodeHistoriesTable)
        .where(eq(nodeHistoriesTable.id, NODE_HISTORY_ID)),
    ).toEqual([{ id: NODE_HISTORY_ID }]);
  });

  test("requires an explicit transaction to turn the row lock into authority", async () => {
    await expectElizaError(
      repository.lockAgentBackupOperationLaneInTransaction(dbWrite as unknown as DbTransaction),
      "AGENT_BACKUP_OPERATION_LANE_TRANSACTION_REQUIRED",
    );
    expect(await readLane()).toMatchObject({
      owner_id: null,
      operation_phase: null,
      claim_sequence: 0n,
    });
    expect(await readWatermarks()).toEqual({ tenants: [], nodes: [] });
  });

  test("snapshots mutable claim inputs before the first asynchronous boundary", async () => {
    const mutableParams = {
      ...target,
      callerToken: { ...callerA },
      fairness: { ...fairness },
      leaseMs: 60_000,
    };
    let mutationRan = false;

    const claimed = await dbWrite.transaction(async (tx) => {
      const pendingClaim = repository.claimAgentBackupOperationLaneInTransaction(tx, mutableParams);
      queueMicrotask(() => {
        mutableParams.organizationId = OTHER_BACKUP_ID;
        mutableParams.backupId = OTHER_BACKUP_ID;
        mutableParams.operationId = OTHER_OPERATION_ID;
        mutableParams.operationPhase = "publication";
        mutableParams.callerToken.ownerId = OWNER_B;
        mutableParams.callerToken.generation = GENERATION_B;
        mutableParams.fairness.sourceNodeHistoryId = OTHER_BACKUP_ID;
        mutableParams.fairness.sourceNodeRecordId = OTHER_BACKUP_ID;
        mutableParams.fairness.sourceNodeIncarnation = OTHER_NODE_INCARNATION;
        mutationRan = true;
      });
      return requireSuccessfulClaim(await pendingClaim);
    });

    expect(mutationRan).toBe(true);
    expect(claimed.execution).toEqual({ ...callerA, claimSequence: 1n });
    expect(claimed.proof.lane).toMatchObject({
      owner_id: OWNER_A,
      generation: GENERATION_A,
      organization_id: ORGANIZATION_ID,
      backup_id: BACKUP_ID,
      operation_id: OPERATION_ID,
      operation_phase: "capture",
    });
    const { tenants, nodes } = await readWatermarks();
    expect(tenants[0]).toMatchObject({ organization_id: ORGANIZATION_ID });
    expect(nodes[0]).toMatchObject({
      source_node_history_id: NODE_HISTORY_ID,
      source_node_record_id: NODE_RECORD_ID,
      source_node_incarnation: NODE_INCARNATION,
    });
  });

  test("replays one exact active token without incrementing lane or fairness counters", async () => {
    const first = requireSuccessfulClaim(await claimCommitted());
    const firstLane = await readLane();
    const replay = requireSuccessfulClaim(await claimCommitted());

    expect(first.kind).toBe("claimed");
    expect(replay.kind).toBe("replayed");
    expect(replay.execution).toEqual(first.execution);
    expect(replay.proof.active).toBe(true);
    const replayedLane = await readLane();
    expect(replayedLane.claim_sequence).toBe(1n);
    expect(replayedLane.claimed_at?.getTime()).toBe(firstLane.claimed_at?.getTime());
    expect(replayedLane.lease_expires_at?.getTime()).toBe(firstLane.lease_expires_at?.getTime());

    const { tenants, nodes } = await readWatermarks();
    expect(tenants[0]?.service_count).toBe(1n);
    expect(nodes[0]?.service_count).toBe(1n);
  });

  test("persists publication phase and fences every operation against phase drift", async () => {
    const publicationTarget: AgentBackupOperationLaneTarget = {
      ...target,
      operationPhase: "publication",
    };
    const claimed = requireSuccessfulClaim(await claimCommitted({ target: publicationTarget }));
    expect(claimed.proof.lane.operation_phase).toBe("publication");

    await expectElizaError(claimCommitted(), "AGENT_BACKUP_OPERATION_LANE_LOST");
    await expectElizaError(
      dbWrite.transaction((tx) =>
        repository.assertAgentBackupOperationLaneInTransaction(tx, {
          ...target,
          execution: claimed.execution,
        }),
      ),
      "AGENT_BACKUP_OPERATION_LANE_LOST",
    );
    await expectElizaError(
      dbWrite.transaction((tx) =>
        repository.renewAgentBackupOperationLaneInTransaction(tx, {
          ...target,
          execution: claimed.execution,
          leaseMs: 60_000,
        }),
      ),
      "AGENT_BACKUP_OPERATION_LANE_LOST",
    );
    await expectElizaError(
      dbWrite.transaction((tx) =>
        repository.releaseAgentBackupOperationLaneInTransaction(tx, {
          ...target,
          execution: claimed.execution,
        }),
      ),
      "AGENT_BACKUP_OPERATION_LANE_LOST",
    );

    const beforeRelease = await readLane();
    expect(beforeRelease.operation_phase).toBe("publication");
    await expect(
      dbWrite.transaction((tx) =>
        repository.assertAgentBackupOperationLaneInTransaction(tx, {
          ...publicationTarget,
          execution: claimed.execution,
        }),
      ),
    ).resolves.toMatchObject({ active: true });
    const released = await dbWrite.transaction((tx) =>
      repository.releaseAgentBackupOperationLaneInTransaction(tx, {
        ...publicationTarget,
        execution: claimed.execution,
      }),
    );
    expect(released).toMatchObject({
      kind: "released",
      lane: { operation_phase: "publication" },
    });
  });

  test("returns one active winner and a non-mutating busy result to another token", async () => {
    const winner = requireSuccessfulClaim(await claimCommitted());
    const loser = await claimCommitted({
      target: { ...target, backupId: OTHER_BACKUP_ID, operationId: OTHER_OPERATION_ID },
      callerToken: callerB,
    });

    expect(winner.kind).toBe("claimed");
    expect(loser.kind).toBe("busy");
    if (loser.kind !== "busy") throw new Error("Expected the second PGlite claimant to be busy");
    expect(loser.lane).toMatchObject({
      owner_id: OWNER_A,
      generation: GENERATION_A,
      claim_sequence: 1n,
    });
    expect(loser.databaseNow.getTime()).toBeLessThan(
      (loser.lane.lease_expires_at as Date).getTime(),
    );

    const lane = await readLane();
    const { tenants, nodes } = await readWatermarks();
    expect(lane.claim_sequence).toBe(1n);
    expect(tenants[0]?.service_count).toBe(1n);
    expect(nodes[0]?.service_count).toBe(1n);
  });

  test("rejects released or expired token resurrection and increments fresh generations", async () => {
    const first = requireSuccessfulClaim(await claimCommitted());
    await dbWrite.transaction((tx) =>
      repository.releaseAgentBackupOperationLaneInTransaction(tx, {
        ...target,
        execution: first.execution,
      }),
    );

    await expectElizaError(claimCommitted(), "AGENT_BACKUP_OPERATION_LANE_LOST");
    const second = requireSuccessfulClaim(await claimCommitted({ callerToken: callerB }));
    expect(second).toMatchObject({
      kind: "claimed",
      execution: { ...callerB, claimSequence: 2n },
    });

    await dbWrite.transaction((tx) => expireLaneInTransaction(tx));
    await expectElizaError(
      claimCommitted({ callerToken: callerB }),
      "AGENT_BACKUP_OPERATION_LANE_LOST",
    );
    const thirdCaller = { ownerId: OWNER_A, generation: GENERATION_C };
    const third = requireSuccessfulClaim(await claimCommitted({ callerToken: thirdCaller }));
    expect(third).toMatchObject({
      kind: "claimed",
      execution: { ...thirdCaller, claimSequence: 3n },
    });

    const { tenants, nodes } = await readWatermarks();
    expect(tenants[0]).toMatchObject({ last_service_sequence: 3n, service_count: 3n });
    expect(nodes[0]).toMatchObject({ last_service_sequence: 3n, service_count: 3n });
  });

  test("claimSequence fences assert and release against stale or wrong executions", async () => {
    const first = requireSuccessfulClaim(await claimCommitted());
    await dbWrite.transaction((tx) =>
      repository.releaseAgentBackupOperationLaneInTransaction(tx, {
        ...target,
        execution: first.execution,
      }),
    );
    const current = requireSuccessfulClaim(await claimCommitted({ callerToken: callerB }));
    const staleSequence = { ...current.execution, claimSequence: 1n };

    await expectElizaError(
      dbWrite.transaction((tx) =>
        repository.assertAgentBackupOperationLaneInTransaction(tx, {
          ...target,
          execution: staleSequence,
        }),
      ),
      "AGENT_BACKUP_OPERATION_LANE_LOST",
    );
    await expectElizaError(
      dbWrite.transaction((tx) =>
        repository.releaseAgentBackupOperationLaneInTransaction(tx, {
          ...target,
          execution: staleSequence,
        }),
      ),
      "AGENT_BACKUP_OPERATION_LANE_LOST",
    );
    await expectElizaError(
      dbWrite.transaction((tx) =>
        repository.assertAgentBackupOperationLaneInTransaction(tx, {
          ...target,
          execution: { ...current.execution, generation: GENERATION_C },
        }),
      ),
      "AGENT_BACKUP_OPERATION_LANE_LOST",
    );
    await expect(
      dbWrite.transaction((tx) =>
        repository.assertAgentBackupOperationLaneInTransaction(tx, {
          ...target,
          execution: current.execution,
        }),
      ),
    ).resolves.toMatchObject({ active: true });

    await dbWrite.transaction((tx) =>
      repository.releaseAgentBackupOperationLaneInTransaction(tx, {
        ...target,
        execution: current.execution,
      }),
    );
    const reusedCaller = requireSuccessfulClaim(await claimCommitted());
    expect(reusedCaller).toMatchObject({
      kind: "claimed",
      execution: { ...callerA, claimSequence: 3n },
    });
    await expectElizaError(
      dbWrite.transaction((tx) =>
        repository.assertAgentBackupOperationLaneInTransaction(tx, {
          ...target,
          execution: first.execution,
        }),
      ),
      "AGENT_BACKUP_OPERATION_LANE_LOST",
    );
  });

  test("renews only an exact active execution and refuses invalid or expired leases", async () => {
    const claimed = requireSuccessfulClaim(await claimCommitted({ leaseMs: 1_000 }));
    const previousExpiry = claimed.proof.lane.lease_expires_at as Date;
    const renewed = await dbWrite.transaction((tx) =>
      repository.renewAgentBackupOperationLaneInTransaction(tx, {
        ...target,
        execution: claimed.execution,
        leaseMs: 60_000,
      }),
    );
    expect(renewed.active).toBe(true);
    expect((renewed.lane.lease_expires_at as Date).getTime()).toBeGreaterThan(
      previousExpiry.getTime(),
    );

    await expectElizaError(
      dbWrite.transaction((tx) =>
        repository.renewAgentBackupOperationLaneInTransaction(tx, {
          ...target,
          execution: { ...claimed.execution, claimSequence: 2n },
          leaseMs: 60_000,
        }),
      ),
      "AGENT_BACKUP_OPERATION_LANE_LOST",
    );
    await expectElizaError(
      dbWrite.transaction((tx) =>
        repository.renewAgentBackupOperationLaneInTransaction(tx, {
          ...target,
          execution: claimed.execution,
          leaseMs: 300_001,
        }),
      ),
      "AGENT_BACKUP_OPERATION_LANE_INVALID_INPUT",
    );

    await dbWrite.transaction((tx) => expireLaneInTransaction(tx));
    await expectElizaError(
      dbWrite.transaction((tx) =>
        repository.renewAgentBackupOperationLaneInTransaction(tx, {
          ...target,
          execution: claimed.execution,
          leaseMs: 60_000,
        }),
      ),
      "AGENT_BACKUP_OPERATION_LANE_LOST",
    );
  });

  test("refresh re-reads release and supersession while proof mutation cannot bypass fencing", async () => {
    await dbWrite.transaction(async (tx) => {
      const claimed = requireSuccessfulClaim(await claimInTransaction(tx));
      const proof = claimed.proof;
      proof.databaseNow.setTime(0);
      proof.lane.lease_expires_at?.setTime(Date.now() + 86_400_000);
      await repository.releaseAgentBackupOperationLaneInTransaction(tx, {
        ...target,
        execution: claimed.execution,
      });
      await expectElizaError(
        repository.refreshAgentBackupOperationLaneProofInTransaction(tx, proof),
        "AGENT_BACKUP_OPERATION_LANE_LOST",
      );
    });

    await dbWrite.transaction(async (tx) => {
      const claimed = requireSuccessfulClaim(
        await claimInTransaction(tx, { callerToken: callerB }),
      );
      const databaseNow = await readPostLockDatabaseNow(tx);
      await tx
        .update(laneTable)
        .set({
          owner_id: OWNER_A,
          generation: GENERATION_C,
          claimed_at: databaseNow,
          lease_expires_at: new Date(databaseNow.getTime() + 60_000),
          released_at: null,
          claim_sequence: claimed.execution.claimSequence + 1n,
          updated_at: databaseNow,
        })
        .where(eq(laneTable.singleton, true));
      claimed.proof.databaseNow.setTime(0);
      claimed.proof.lane.lease_expires_at?.setTime(Date.now() + 86_400_000);

      await expectElizaError(
        repository.refreshAgentBackupOperationLaneProofInTransaction(tx, claimed.proof),
        "AGENT_BACKUP_OPERATION_LANE_LOST",
      );
    });
  });

  test("releases by exact current-clock CAS and replays without another mutation", async () => {
    await dbWrite.transaction(async (tx) => {
      const claimed = requireSuccessfulClaim(await claimInTransaction(tx));
      const beforeRelease = await readPostLockDatabaseNow(tx);
      const released = await repository.releaseAgentBackupOperationLaneInTransaction(tx, {
        ...target,
        execution: claimed.execution,
      });
      const afterRelease = await readPostLockDatabaseNow(tx);

      expect(released.kind).toBe("released");
      expect(released.lane.released_at).toBeInstanceOf(Date);
      const releasedAt = released.lane.released_at as Date;
      expect(releasedAt.getTime()).toBeGreaterThanOrEqual(beforeRelease.getTime());
      expect(releasedAt.getTime()).toBeLessThanOrEqual(afterRelease.getTime());

      const firstUpdatedAt = released.lane.updated_at;
      await tx
        .update(laneTable)
        .set({
          claimed_at: new Date(releasedAt.getTime() - 2),
          lease_expires_at: new Date(releasedAt.getTime() - 1),
        })
        .where(eq(laneTable.singleton, true));
      const replayed = await repository.releaseAgentBackupOperationLaneInTransaction(tx, {
        ...target,
        execution: claimed.execution,
      });
      expect(replayed.kind).toBe("replayed");
      expect(replayed.lane.released_at?.getTime()).toBe(releasedAt.getTime());
      expect(replayed.lane.updated_at.getTime()).toBe(firstUpdatedAt.getTime());
    });
  });

  test("rolls back lane and both fairness stamps when the claiming transaction aborts", async () => {
    const rolledBackClaim = async (): Promise<void> => {
      await dbWrite.transaction(async (tx) => {
        const claimed = requireSuccessfulClaim(await claimInTransaction(tx));
        expect(claimed.execution.claimSequence).toBe(1n);
        throw new Error("intentional rollback sentinel");
      });
    };
    await expect(rolledBackClaim()).rejects.toThrow("intentional rollback sentinel");

    expect(await readLane()).toMatchObject({
      owner_id: null,
      generation: null,
      organization_id: null,
      backup_id: null,
      operation_id: null,
      operation_phase: null,
      claim_sequence: 0n,
    });
    expect(await readWatermarks()).toEqual({ tenants: [], nodes: [] });
  });

  test("validates UTF-8 owners, UUIDs, lease bounds, and exact node history", async () => {
    const maxOwner = `${"é".repeat(125)}🚀a`;
    expect(new TextEncoder().encode(maxOwner).byteLength).toBe(255);
    const valid = requireSuccessfulClaim(
      await claimCommitted({ callerToken: { ownerId: maxOwner, generation: GENERATION_A } }),
    );
    await dbWrite.transaction((tx) =>
      repository.releaseAgentBackupOperationLaneInTransaction(tx, {
        ...target,
        execution: valid.execution,
      }),
    );

    for (const ownerId of [
      "",
      " leading",
      "trailing ",
      "line\nbreak",
      "c1\u0085control",
      "unpaired-high-\ud800",
      "unpaired-low-\udc00",
      "a".repeat(256),
      "é".repeat(128),
    ]) {
      await expectElizaError(
        claimCommitted({ callerToken: { ownerId, generation: GENERATION_B } }),
        "AGENT_BACKUP_OPERATION_LANE_INVALID_INPUT",
      );
    }

    for (const invalidClaim of [
      { target: { ...target, organizationId: UPPERCASE_UUID } },
      { target: { ...target, operationPhase: "restore" as never } },
      { callerToken: { ...callerB, generation: UPPERCASE_UUID } },
      { fairness: { ...fairness, sourceNodeHistoryId: UPPERCASE_UUID } },
      { leaseMs: 0 },
      { leaseMs: 300_001 },
    ]) {
      await expectElizaError(
        claimCommitted(invalidClaim),
        "AGENT_BACKUP_OPERATION_LANE_INVALID_INPUT",
      );
    }
    await expectElizaError(
      dbWrite.transaction((tx) =>
        repository.claimAgentBackupOperationLaneInTransaction(tx, {
          ...target,
          callerToken: callerB,
          leaseMs: 60_000,
          fairness: null as unknown as AgentBackupOperationLaneFairness,
        }),
      ),
      "AGENT_BACKUP_OPERATION_LANE_INVALID_INPUT",
    );

    const beforeInvalidHistory = await readLane();
    const historyError = await expectFailure(
      claimCommitted({
        callerToken: callerB,
        fairness: {
          ...fairness,
          sourceNodeIncarnation: OTHER_NODE_INCARNATION,
        },
      }),
    );
    expect(historyError).toBeDefined();
    expect(await readLane()).toEqual(beforeInvalidHistory);
    const { tenants, nodes } = await readWatermarks();
    expect(tenants[0]?.service_count).toBe(1n);
    expect(nodes[0]).toMatchObject({
      source_node_history_id: NODE_HISTORY_ID,
      source_node_record_id: NODE_RECORD_ID,
      source_node_incarnation: NODE_INCARNATION,
      service_count: 1n,
    });

    await expectElizaError(
      dbWrite.transaction((tx) =>
        repository.assertAgentBackupOperationLaneInTransaction(tx, {
          ...target,
          execution: { ...valid.execution, claimSequence: 0n },
        }),
      ),
      "AGENT_BACKUP_OPERATION_LANE_INVALID_INPUT",
    );
  });
});
