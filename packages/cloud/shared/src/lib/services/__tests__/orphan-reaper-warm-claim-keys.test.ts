/**
 * Exercises warm-claim and cleanup-fence name resolution against an in-process
 * PGlite schema so physical container ownership cannot be mistaken for absence.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { agentNodeIncarnationHistories } from "../../../db/schemas/agent-node-incarnation-histories";
import { agentSandboxes } from "../../../db/schemas/agent-sandboxes";
import { dockerNodes } from "../../../db/schemas/docker-nodes";
import { organizations } from "../../../db/schemas/organizations";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";

const PGLITE_TIMEOUT = 60_000;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let loadSandboxStatusesByIds: typeof import("../docker-node-workloads").loadSandboxStatusesByIds;

let seq = 0;
function uniq(p: string): string {
  seq += 1;
  return `${p}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedOwner(): Promise<{ orgId: string; userId: string }> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: uniq("org"), credit_balance: "1.000000" })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  return { orgId: org.id, userId: user.id };
}

beforeAll(async () => {
  if (AMBIENT_DATABASE_URL !== "" && !AMBIENT_DATABASE_URL.startsWith("pglite")) {
    throw new Error("This suite requires an isolated PGlite DATABASE_URL");
  }
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  ({ loadSandboxStatusesByIds } = await import("../docker-node-workloads"));
  const schema = {
    organizations,
    users,
    userCharacters,
    agentNodeIncarnationHistories,
    dockerNodes,
    agentSandboxes,
  };
  const { apply } = await pushSchema(schema as never, dbWrite as never);
  await apply();
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("orphan reaper key resolution for warm-claimed containers", () => {
  test(
    "a pool key resolves to the live claimed row, on the row's node",
    async () => {
      const { orgId, userId } = await seedOwner();
      const poolId = crypto.randomUUID();
      const [row] = await dbWrite
        .insert(agentSandboxes)
        .values({
          organization_id: orgId,
          user_id: userId,
          agent_name: uniq("claimed"),
          status: "running",
          execution_tier: "dedicated-always",
          node_id: "node-7",
          warm_claim_source_pool_id: poolId,
          container_name: `agent-${poolId}`,
        })
        .returning();

      const placements = await loadSandboxStatusesByIds([poolId]);

      const forPoolKey = placements.filter((p) => p.key === poolId);
      expect(forPoolKey.length).toBeGreaterThanOrEqual(1);
      expect(forPoolKey[0]?.status).toBe("running");
      expect(forPoolKey[0]?.nodeId).toBe("node-7");
      expect(placements.some((p) => p.key === row.id)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "the finalized steady state resolves by physical name after the source id is cleared",
    async () => {
      const { orgId, userId } = await seedOwner();
      const poolId = crypto.randomUUID();
      const [row] = await dbWrite
        .insert(agentSandboxes)
        .values({
          organization_id: orgId,
          user_id: userId,
          agent_name: uniq("finalized"),
          status: "running",
          execution_tier: "dedicated-always",
          node_id: "node-7",
          warm_claim_source_pool_id: null,
          container_name: `agent-${poolId}`,
        })
        .returning();

      const placements = await loadSandboxStatusesByIds([poolId]);

      const forPoolKey = placements.filter((p) => p.key === poolId);
      expect(forPoolKey.length).toBeGreaterThanOrEqual(1);
      expect(forPoolKey[0]?.status).toBe("running");
      expect(forPoolKey[0]?.nodeId).toBe("node-7");
      expect(placements.some((p) => p.key === row.id)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "an unclaimed pool id yields no placement",
    async () => {
      const placements = await loadSandboxStatusesByIds([crypto.randomUUID()]);
      expect(placements).toEqual([]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a cleanup-fenced physical name protects only its own placement",
    async () => {
      const { orgId, userId } = await seedOwner();
      const rowId = crypto.randomUUID();
      const cleanupNameId = crypto.randomUUID();
      await dbWrite
        .insert(agentSandboxes)
        .values({
          id: rowId,
          organization_id: orgId,
          user_id: userId,
          agent_name: uniq("claimed"),
          status: "running",
          execution_tier: "dedicated-always",
          node_id: "node-7",
          container_name: `agent-${rowId}`,
          replacement_cleanup_sandbox_id: crypto.randomUUID(),
          replacement_cleanup_node_id: "node-8",
          replacement_cleanup_container_name: `agent-${cleanupNameId}`,
          replacement_cleanup_attempt_id: crypto.randomUUID(),
          replacement_cleanup_allocation_counted: true,
          replacement_cleanup_created_at: new Date(),
        })
        .returning();

      const placements = await loadSandboxStatusesByIds([cleanupNameId]);
      const forCleanupName = placements.filter((placement) => placement.key === cleanupNameId);
      expect(forCleanupName).toEqual([
        {
          key: cleanupNameId,
          status: "replacement_cleanup_owned",
          nodeId: "node-8",
        },
      ]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a stale exact cleanup follows its immutable record after reboot, rename, and logical-id reuse",
    async () => {
      const { orgId, userId } = await seedOwner();
      const ownerRecordId = crypto.randomUUID();
      const ownerOldHistoryId = crypto.randomUUID();
      const ownerOldIncarnation = crypto.randomUUID();
      const ownerCurrentHistoryId = crypto.randomUUID();
      const ownerCurrentIncarnation = crypto.randomUUID();
      const reusedRecordId = crypto.randomUUID();
      const reusedHistoryId = crypto.randomUUID();
      const reusedIncarnation = crypto.randomUUID();
      const rowId = crypto.randomUUID();
      const cleanupNameId = crypto.randomUUID();
      const cleanupAttemptId = crypto.randomUUID();
      const cleanupContainerId = "a".repeat(64);

      await dbWrite.insert(agentNodeIncarnationHistories).values([
        {
          id: ownerOldHistoryId,
          docker_node_record_id: ownerRecordId,
          node_id: "old-logical-node",
          node_incarnation: ownerOldIncarnation,
          fleet_kind: "robot",
          infrastructure_provider: "hetzner",
          host_key_fingerprint: "SHA256:owner-old",
        },
        {
          id: ownerCurrentHistoryId,
          docker_node_record_id: ownerRecordId,
          node_id: "retired-owner-node",
          node_incarnation: ownerCurrentIncarnation,
          fleet_kind: "robot",
          infrastructure_provider: "hetzner",
          host_key_fingerprint: "SHA256:owner-current",
        },
        {
          id: reusedHistoryId,
          docker_node_record_id: reusedRecordId,
          node_id: "old-logical-node",
          node_incarnation: reusedIncarnation,
          fleet_kind: "robot",
          infrastructure_provider: "hetzner",
          host_key_fingerprint: "SHA256:reused",
        },
      ]);
      await dbWrite.insert(dockerNodes).values([
        {
          id: ownerRecordId,
          node_id: "retired-owner-node",
          hostname: "owner.internal",
          host_key_fingerprint: "SHA256:owner-current",
          fleet_kind: "robot",
          infrastructure_provider: "hetzner",
          status: "healthy",
          node_incarnation: ownerCurrentIncarnation,
          current_node_history_id: ownerCurrentHistoryId,
        },
        {
          id: reusedRecordId,
          node_id: "old-logical-node",
          hostname: "reused.internal",
          host_key_fingerprint: "SHA256:reused",
          fleet_kind: "robot",
          infrastructure_provider: "hetzner",
          status: "healthy",
          node_incarnation: reusedIncarnation,
          current_node_history_id: reusedHistoryId,
        },
      ]);
      await dbWrite.insert(agentSandboxes).values({
        id: rowId,
        organization_id: orgId,
        user_id: userId,
        agent_name: uniq("stale-cleanup"),
        status: "running",
        execution_tier: "dedicated-always",
        node_id: "canonical-node",
        container_name: `agent-${rowId}`,
        replacement_cleanup_sandbox_id: crypto.randomUUID(),
        replacement_cleanup_node_id: "old-logical-node",
        replacement_cleanup_node_record_id: ownerRecordId,
        replacement_cleanup_node_incarnation: ownerOldIncarnation,
        replacement_cleanup_node_history_id: ownerOldHistoryId,
        replacement_cleanup_node_hostname: "owner.internal",
        replacement_cleanup_node_ssh_port: 22,
        replacement_cleanup_node_ssh_user: "root",
        replacement_cleanup_node_host_key_fingerprint: "SHA256:owner-old",
        replacement_cleanup_container_name: `agent-${cleanupNameId}`,
        replacement_cleanup_attempt_id: cleanupAttemptId,
        replacement_cleanup_container_id: cleanupContainerId,
        replacement_cleanup_allocation_counted: true,
        replacement_cleanup_created_at: new Date(),
      });

      const placements = await loadSandboxStatusesByIds([cleanupNameId]);
      expect(placements.filter(({ key }) => key === cleanupNameId)).toEqual([
        {
          key: cleanupNameId,
          status: "replacement_cleanup_owned",
          nodeId: "retired-owner-node",
        },
      ]);
    },
    PGLITE_TIMEOUT,
  );
});
