/**
 * Durable deletion-allocation ownership (#17185): one logical managed Docker
 * allocation gives back exactly one `docker_nodes.allocated_count` slot, however
 * many times its teardown runs.
 *
 * The defect these pin is a double-free, not a leak. Remote teardown is
 * retryable and treats "No such container" as success, but the sandbox row keeps
 * its node locator until the row is deleted — so a retry after any post-stop
 * failure used to decrement the same node again and free a LIVE sibling's slot,
 * with `GREATEST(count - 1, 0)` hiding the underflow. Ownership makes the second
 * release a no-op instead.
 *
 * Drives the REAL repository CAS and the REAL workload-reconciliation query
 * against in-process PGlite (real Drizzle schema via pushSchema) with NOTHING
 * mocked, so the actual SQL — the cross-table transaction, the locator
 * predicate, the `allocated_count > 0` guard — executes. Fails LOUDLY if
 * PGlite/pushSchema is unavailable; it never silently passes.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { and, eq } from "drizzle-orm";
import { agentSandboxes } from "../../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../../db/schemas/api-keys";
import { containers } from "../../../db/schemas/containers";
import { dockerNodes } from "../../../db/schemas/docker-nodes";
import { generations } from "../../../db/schemas/generations";
import { jobExecutionLeases } from "../../../db/schemas/job-execution-leases";
import { jobs } from "../../../db/schemas/jobs";
import { organizations } from "../../../db/schemas/organizations";
import { usageRecords } from "../../../db/schemas/usage-records";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";
import {
  holdsCountedNodeSlot,
  isDeletionContinuation,
  TERMINAL_SANDBOX_STATUSES,
} from "../docker-node-workload-queries";
import { JOB_TYPES } from "../provisioning-job-types";

const PGLITE_TIMEOUT = 60_000;

let pgliteReady = true;
let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let agentSandboxesRepository: typeof import("../../../db/repositories/agent-sandboxes").agentSandboxesRepository;
let countAllocatedWorkloadsOnNodeWithDatabase: typeof import("../docker-node-workload-queries").countAllocatedWorkloadsOnNodeWithDatabase;
let ElizaSandboxService: typeof import("../eliza-sandbox").ElizaSandboxService;
let elizaSandboxService: typeof import("../eliza-sandbox").elizaSandboxService;
let ProvisioningJobService: typeof import("../provisioning-jobs").ProvisioningJobService;

let seq = 0;
function uniq(p: string): string {
  seq += 1;
  return `${p}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.error("[deletion-allocation-ownership.test] non-PGlite DATABASE_URL; failing.");
    return;
  }
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ agentSandboxesRepository } = await import("../../../db/repositories/agent-sandboxes"));
    ({ countAllocatedWorkloadsOnNodeWithDatabase } = await import(
      "../docker-node-workload-queries"
    ));
    ({ ElizaSandboxService, elizaSandboxService } = await import("../eliza-sandbox"));
    ({ ProvisioningJobService } = await import("../provisioning-jobs"));

    const schema = {
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      apiKeys,
      generations,
      usageRecords,
      jobs,
      jobExecutionLeases,
      dockerNodes,
      containers,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[deletion-allocation-ownership.test] PGlite/pushSchema unavailable — failing.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

/**
 * A node carrying two allocations: the row under test plus a live sibling. The
 * sibling is the thing a double-free actually harms, so every release assertion
 * below is really "did the sibling keep its slot".
 */
async function seedNodeWithTargetAndSibling(options: {
  allocationCounted: boolean | null;
  status?: "running" | "stopped" | "sleeping" | "deletion_pending" | "deletion_failed";
  withDeletionIntent?: boolean;
}): Promise<{ agentId: string; orgId: string; nodeId: string; deletionAttemptId: string }> {
  const nodeId = uniq("node");
  const deletionAttemptId = crypto.randomUUID();

  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: uniq("org"), credit_balance: "5.000000" })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();

  await dbWrite
    .insert(dockerNodes)
    .values({ node_id: nodeId, hostname: `${nodeId}.test.invalid`, allocated_count: 2 });

  const withIntent = options.withDeletionIntent ?? true;
  const [agent] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: org.id,
      user_id: user.id,
      agent_name: uniq("agent"),
      status: options.status ?? "deletion_pending",
      node_id: nodeId,
      container_name: uniq("container"),
      ...(withIntent
        ? { deletion_attempt_id: deletionAttemptId, deletion_started_at: new Date() }
        : {}),
      deletion_allocation_counted: options.allocationCounted,
    })
    .returning();

  return { agentId: agent.id, orgId: org.id, nodeId, deletionAttemptId };
}

async function allocatedCount(nodeId: string): Promise<number> {
  const [row] = await dbWrite
    .select({ n: dockerNodes.allocated_count })
    .from(dockerNodes)
    .where(eq(dockerNodes.node_id, nodeId));
  return Number(row.n);
}

/** A real agent row created through the service, so the delete path sees a genuine one. */
async function seedAgentViaService(): Promise<{
  agentId: string;
  orgId: string;
  userId: string;
}> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: uniq("org"), credit_balance: "5.000000" })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  const res = await new ElizaSandboxService().createAgent({
    organizationId: org.id,
    userId: user.id,
    agentName: uniq("agent"),
    executionTier: "dedicated-always",
    maxNonTerminalAgents: 10,
  });
  return { agentId: res.agent.id, orgId: org.id, userId: user.id };
}

async function deletionAttemptId(agentId: string): Promise<string> {
  const [row] = await dbWrite
    .select({ id: agentSandboxes.deletion_attempt_id })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, agentId));
  if (!row.id) throw new Error("expected a deletion attempt id to be stamped");
  return row.id;
}

async function ownership(agentId: string): Promise<boolean | null> {
  const [row] = await dbWrite
    .select({ owned: agentSandboxes.deletion_allocation_counted })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, agentId));
  return row.owned;
}

async function lifecycleRevision(agentId: string): Promise<number> {
  const [row] = await dbWrite
    .select({ revision: agentSandboxes.lifecycle_revision })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, agentId));
  if (!row) throw new Error("expected seeded sandbox row");
  return row.revision;
}

describe("tryReleaseDeletionAllocation — releases exactly once", () => {
  test(
    "retry after a post-stop failure does not free the live sibling's slot",
    async () => {
      if (!pgliteReady) return;
      const { agentId, orgId, nodeId, deletionAttemptId } = await seedNodeWithTargetAndSibling({
        allocationCounted: true,
      });

      // First pass: teardown succeeded, slot handed back. 2 -> 1.
      expect(
        await agentSandboxesRepository.tryReleaseDeletionAllocation(
          agentId,
          orgId,
          deletionAttemptId,
          nodeId,
        ),
      ).toBe("released");
      expect(await allocatedCount(nodeId)).toBe(1);
      expect(await ownership(agentId)).toBe(false);

      // Credential revocation / row-delete / job-status failed downstream, so the
      // whole delete re-runs and the remote stop reports "No such container".
      // The sibling's slot must survive.
      expect(
        await agentSandboxesRepository.tryReleaseDeletionAllocation(
          agentId,
          orgId,
          deletionAttemptId,
          nodeId,
        ),
      ).toBe("not-owned");
      expect(await allocatedCount(nodeId)).toBe(1);

      // A third recovery sweep is still a no-op.
      expect(
        await agentSandboxesRepository.tryReleaseDeletionAllocation(
          agentId,
          orgId,
          deletionAttemptId,
          nodeId,
        ),
      ).toBe("not-owned");
      expect(await allocatedCount(nodeId)).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a second release of an already-spent generation is a no-op",
    async () => {
      if (!pgliteReady) return;
      const { agentId, orgId, nodeId, deletionAttemptId } = await seedNodeWithTargetAndSibling({
        allocationCounted: true,
      });

      const results = await Promise.all([
        agentSandboxesRepository.tryReleaseDeletionAllocation(
          agentId,
          orgId,
          deletionAttemptId,
          nodeId,
        ),
        agentSandboxesRepository.tryReleaseDeletionAllocation(
          agentId,
          orgId,
          deletionAttemptId,
          nodeId,
        ),
      ]);

      // This harness cannot demonstrate a race, and the test does not claim to.
      // PGlite is a single WASM backend behind one connection, so these two
      // transactions cannot interleave — the second queues and begins after the
      // first commits. What is pinned is the property the retry path actually
      // relies on: releasing an already-spent generation returns `not-owned` and
      // does not decrement twice.
      //
      // NOT covered here: real row-lock contention, where a second transaction
      // blocks on the UPDATE and then re-evaluates its WHERE against the updated
      // row under READ COMMITTED. That needs two independent PostgreSQL
      // connections, and the isolation level matters — under REPEATABLE READ the
      // loser raises a serialization failure instead of returning `not-owned`,
      // and no caller here catches that.
      //
      // Assert the outcomes by name: every outcome is a truthy string, so a
      // truthiness count would pass whichever two came back.
      expect(results.filter((r) => r === "released")).toHaveLength(1);
      expect(results.filter((r) => r === "not-owned")).toHaveLength(1);
      expect(await allocatedCount(nodeId)).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a suspended row that never owned a slot never decrements one",
    async () => {
      if (!pgliteReady) return;
      // Suspend already handed the slot back while keeping the locator — the
      // exact shape that let a later delete decrement a second time.
      const { agentId, orgId, nodeId, deletionAttemptId } = await seedNodeWithTargetAndSibling({
        allocationCounted: false,
      });

      expect(
        await agentSandboxesRepository.tryReleaseDeletionAllocation(
          agentId,
          orgId,
          deletionAttemptId,
          nodeId,
        ),
      ).toBe("not-owned");
      expect(await allocatedCount(nodeId)).toBe(2);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a stale deletion generation cannot release the current one's slot",
    async () => {
      if (!pgliteReady) return;
      const { agentId, orgId, nodeId } = await seedNodeWithTargetAndSibling({
        allocationCounted: true,
      });

      expect(
        await agentSandboxesRepository.tryReleaseDeletionAllocation(
          agentId,
          orgId,
          crypto.randomUUID(), // a superseded attempt id
          nodeId,
        ),
      ).toBe("not-owned");
      expect(await allocatedCount(nodeId)).toBe(2);
      expect(await ownership(agentId)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "the prepared revision fences release and the returned revision fences row deletion",
    async () => {
      if (!pgliteReady) return;
      const { agentId, orgId, nodeId, deletionAttemptId } = await seedNodeWithTargetAndSibling({
        allocationCounted: true,
      });
      const preparedRevision = await lifecycleRevision(agentId);

      await expect(
        agentSandboxesRepository.tryReleaseDeletionAllocationForCommit(
          agentId,
          orgId,
          deletionAttemptId,
          nodeId,
          preparedRevision - 1,
        ),
      ).resolves.toEqual({ outcome: "not-owned", lifecycleRevision: null });
      expect(await allocatedCount(nodeId)).toBe(2);
      expect(await ownership(agentId)).toBe(true);

      const release = await agentSandboxesRepository.tryReleaseDeletionAllocationForCommit(
        agentId,
        orgId,
        deletionAttemptId,
        nodeId,
        preparedRevision,
      );
      expect(release).toEqual({ outcome: "released", lifecycleRevision: preparedRevision + 1 });
      expect(await lifecycleRevision(agentId)).toBe(release.lifecycleRevision);
      expect(await allocatedCount(nodeId)).toBe(1);

      const deleted = await dbWrite
        .delete(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, orgId),
            eq(agentSandboxes.deletion_attempt_id, deletionAttemptId),
            eq(agentSandboxes.lifecycle_revision, release.lifecycleRevision as number),
          ),
        )
        .returning({ id: agentSandboxes.id });
      expect(deleted).toEqual([{ id: agentId }]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a stale node locator cannot release a different node's capacity",
    async () => {
      if (!pgliteReady) return;
      const { agentId, orgId, nodeId, deletionAttemptId } = await seedNodeWithTargetAndSibling({
        allocationCounted: true,
      });
      const otherNodeId = uniq("node");
      await dbWrite.insert(dockerNodes).values({
        node_id: otherNodeId,
        hostname: `${otherNodeId}.test.invalid`,
        allocated_count: 2,
      });

      expect(
        await agentSandboxesRepository.tryReleaseDeletionAllocation(
          agentId,
          orgId,
          deletionAttemptId,
          otherNodeId,
        ),
      ).toBe("not-owned");
      expect(await allocatedCount(otherNodeId)).toBe(2);
      expect(await allocatedCount(nodeId)).toBe(2);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "another organization cannot release this row's slot",
    async () => {
      if (!pgliteReady) return;
      const { agentId, nodeId, deletionAttemptId } = await seedNodeWithTargetAndSibling({
        allocationCounted: true,
      });

      expect(
        await agentSandboxesRepository.tryReleaseDeletionAllocation(
          agentId,
          crypto.randomUUID(),
          deletionAttemptId,
          nodeId,
        ),
      ).toBe("not-owned");
      expect(await allocatedCount(nodeId)).toBe(2);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "an already-zero counter is left alone rather than driven negative",
    async () => {
      if (!pgliteReady) return;
      const { agentId, orgId, nodeId, deletionAttemptId } = await seedNodeWithTargetAndSibling({
        allocationCounted: true,
      });
      await dbWrite
        .update(dockerNodes)
        .set({ allocated_count: 0 })
        .where(eq(dockerNodes.node_id, nodeId));

      // Ownership IS consumed — the claim was real — but the guard blocks the
      // underflow. The outcome must say so: `counter-unchanged` is an accounting
      // mismatch worth a warn, distinct from the benign `not-owned` retry.
      expect(
        await agentSandboxesRepository.tryReleaseDeletionAllocation(
          agentId,
          orgId,
          deletionAttemptId,
          nodeId,
        ),
      ).toBe("counter-unchanged");
      expect(await allocatedCount(nodeId)).toBe(0);
      expect(await ownership(agentId)).toBe(false);
    },
    PGLITE_TIMEOUT,
  );
});

describe("a deletion continuation never re-derives ownership from its own state", () => {
  test(
    "a deletion_pending row with NULL intent columns is not armed by a re-enqueue",
    async () => {
      if (!pgliteReady) return;
      // The #17249 shape: the row is already in a deletion state but carries no
      // intent columns. Under the narrow `deletion_started_at === null` test this
      // reads as a FRESH deletion, so ownership is re-derived from the row's own
      // `deletion_pending` status — which scores as still-counted — arming a
      // release for a slot the pre-ownership provider already decremented.
      const { agentId, orgId, userId } = await seedAgentViaService();
      const nodeId = uniq("node");
      await dbWrite
        .insert(dockerNodes)
        .values({ node_id: nodeId, hostname: `${nodeId}.test.invalid`, allocated_count: 2 });
      await dbWrite
        .update(agentSandboxes)
        .set({
          status: "deletion_pending",
          node_id: nodeId,
          container_name: uniq("container"),
          deletion_attempt_id: null,
          deletion_started_at: null,
          deletion_allocation_counted: null,
        })
        .where(eq(agentSandboxes.id, agentId));

      await new ProvisioningJobService().enqueueAgentDeleteOnce({
        agentId,
        organizationId: orgId,
        userId,
      });

      // Ownership must stay unrecorded: this generation cannot prove it owns a
      // slot, and guessing "true" is the double-free.
      expect(await ownership(agentId)).toBeNull();

      const attemptId = await deletionAttemptId(agentId);
      expect(
        await agentSandboxesRepository.tryReleaseDeletionAllocation(
          agentId,
          orgId,
          attemptId,
          nodeId,
        ),
      ).toBe("not-owned");
      expect(await allocatedCount(nodeId)).toBe(2);
    },
    PGLITE_TIMEOUT,
  );

  test("isDeletionContinuation covers the shapes the narrow test misses", () => {
    const fresh = { status: "running", deletion_attempt_id: null, deletion_started_at: null };
    expect(isDeletionContinuation(fresh)).toBe(false);

    // Each of these is a continuation the `deletion_started_at` test alone misses.
    for (const row of [
      { status: "deletion_pending", deletion_attempt_id: null, deletion_started_at: null },
      { status: "deletion_failed", deletion_attempt_id: null, deletion_started_at: null },
      { status: "running", deletion_attempt_id: crypto.randomUUID(), deletion_started_at: null },
      { status: "running", deletion_attempt_id: null, deletion_started_at: new Date() },
    ]) {
      expect(isDeletionContinuation(row)).toBe(true);
    }
  });
});

describe("releaseDeletionAllocationOnReap — absence proven by the orphan reaper", () => {
  test(
    "an abandoned deletion stops counting once its container is reaped",
    async () => {
      if (!pgliteReady) return;
      // The delete could not prove absence (bounded timeout, or the row went
      // deletion_failed), so it kept ownership and the slot stayed counted.
      // Without this release the slot would be held forever once
      // reEnqueueFailedDeletions hits its circuit breaker — the #15378 shape.
      const { agentId, nodeId } = await seedNodeWithTargetAndSibling({
        allocationCounted: true,
        status: "deletion_failed",
      });
      expect(await countAllocatedWorkloadsOnNodeWithDatabase(dbWrite, nodeId)).toBe(1);

      expect(await agentSandboxesRepository.releaseDeletionAllocationOnReap(agentId, nodeId)).toBe(
        "released",
      );
      expect(await allocatedCount(nodeId)).toBe(1);
      expect(await ownership(agentId)).toBe(false);
      expect(await countAllocatedWorkloadsOnNodeWithDatabase(dbWrite, nodeId)).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "absence proof clears stale network locators so recovery does not recapture a dead generation",
    async () => {
      if (!pgliteReady) return;
      const { agentId, nodeId } = await seedNodeWithTargetAndSibling({
        allocationCounted: true,
        status: "deletion_failed",
      });
      await dbWrite
        .update(agentSandboxes)
        .set({
          bridge_url: "http://100.64.0.10:3000",
          health_url: "http://100.64.0.10:3000/api/health",
        })
        .where(eq(agentSandboxes.id, agentId));

      expect(await agentSandboxesRepository.releaseDeletionAllocationOnReap(agentId, nodeId)).toBe(
        "released",
      );

      const [retained] = await dbWrite
        .select({
          bridgeUrl: agentSandboxes.bridge_url,
          healthUrl: agentSandboxes.health_url,
          containerName: agentSandboxes.container_name,
          nodeId: agentSandboxes.node_id,
          status: agentSandboxes.status,
        })
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, agentId));
      expect(retained).toMatchObject({
        bridgeUrl: null,
        healthUrl: null,
        nodeId,
        status: "deletion_failed",
      });
      expect(retained.containerName).not.toBeNull();
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a second reap of the same agent does not free the live sibling's slot",
    async () => {
      if (!pgliteReady) return;
      const { agentId, nodeId } = await seedNodeWithTargetAndSibling({
        allocationCounted: true,
        status: "deletion_failed",
      });

      await agentSandboxesRepository.releaseDeletionAllocationOnReap(agentId, nodeId);
      expect(await agentSandboxesRepository.releaseDeletionAllocationOnReap(agentId, nodeId)).toBe(
        "not-owned",
      );
      expect(await allocatedCount(nodeId)).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "reaping cannot release capacity on a node the row has since left",
    async () => {
      if (!pgliteReady) return;
      const { agentId, nodeId } = await seedNodeWithTargetAndSibling({
        allocationCounted: true,
        status: "deletion_failed",
      });
      const otherNodeId = uniq("node");
      await dbWrite.insert(dockerNodes).values({
        node_id: otherNodeId,
        hostname: `${otherNodeId}.test.invalid`,
        allocated_count: 2,
      });

      expect(
        await agentSandboxesRepository.releaseDeletionAllocationOnReap(agentId, otherNodeId),
      ).toBe("not-owned");
      expect(await allocatedCount(otherNodeId)).toBe(2);
      expect(await allocatedCount(nodeId)).toBe(2);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a row that never owned a slot is untouched by a reap",
    async () => {
      if (!pgliteReady) return;
      const { agentId, nodeId } = await seedNodeWithTargetAndSibling({
        allocationCounted: false,
        status: "deletion_failed",
      });

      expect(await agentSandboxesRepository.releaseDeletionAllocationOnReap(agentId, nodeId)).toBe(
        "not-owned",
      );
      expect(await allocatedCount(nodeId)).toBe(2);
    },
    PGLITE_TIMEOUT,
  );
});

describe("holdsCountedNodeSlot — ownership initialization from pre-delete state", () => {
  test("a placed, running row owns its slot", () => {
    expect(holdsCountedNodeSlot({ status: "running", node_id: "node-1" })).toBe(true);
  });

  test("suspended and sleeping rows already gave the slot back", () => {
    expect(holdsCountedNodeSlot({ status: "stopped", node_id: "node-1" })).toBe(false);
    expect(holdsCountedNodeSlot({ status: "sleeping", node_id: "node-1" })).toBe(false);
  });

  test("an unplaced row never had a slot", () => {
    expect(holdsCountedNodeSlot({ status: "running", node_id: null })).toBe(false);
    expect(holdsCountedNodeSlot({ status: "pending", node_id: null })).toBe(false);
  });

  test("a disconnected container still occupies its node", () => {
    expect(holdsCountedNodeSlot({ status: "disconnected", node_id: "node-1" })).toBe(true);
  });

  test("statuses the capacity recount treats as free are never owned here", () => {
    // `syncAllocatedCounts` recomputes allocated_count from
    // TERMINAL_SANDBOX_STATUSES. Any status it drops has already had its slot
    // reclaimed, so stamping ownership for one would release it a second time —
    // the double-free this issue closes. Derivation keeps the two in lockstep.
    for (const status of TERMINAL_SANDBOX_STATUSES) {
      expect(holdsCountedNodeSlot({ status, node_id: "node-1" })).toBe(false);
    }
  });
});

describe("workload reconciliation counts a deletion row exactly while it owns a slot", () => {
  test(
    "deletion_pending counts before release and stops counting after",
    async () => {
      if (!pgliteReady) return;
      const { agentId, orgId, nodeId, deletionAttemptId } = await seedNodeWithTargetAndSibling({
        allocationCounted: true,
        status: "deletion_pending",
      });

      expect(await countAllocatedWorkloadsOnNodeWithDatabase(dbWrite, nodeId)).toBe(1);

      await agentSandboxesRepository.tryReleaseDeletionAllocation(
        agentId,
        orgId,
        deletionAttemptId,
        nodeId,
      );

      // The row lingers in deletion_pending until the row delete commits, but it
      // no longer consumes capacity — a status-only rule kept counting it here.
      expect(await countAllocatedWorkloadsOnNodeWithDatabase(dbWrite, nodeId)).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "deletion_failed still counts while it owns a slot",
    async () => {
      if (!pgliteReady) return;
      const { nodeId } = await seedNodeWithTargetAndSibling({
        allocationCounted: true,
        status: "deletion_failed",
      });

      // deletion_failed is a TERMINAL_SANDBOX_STATUS, so the status-only rule
      // reported this node as free while its container was still placed.
      expect(await countAllocatedWorkloadsOnNodeWithDatabase(dbWrite, nodeId)).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "pre-migration NULL ownership keeps the original status-only behaviour",
    async () => {
      if (!pgliteReady) return;
      const pending = await seedNodeWithTargetAndSibling({
        allocationCounted: null,
        status: "deletion_pending",
      });
      const failed = await seedNodeWithTargetAndSibling({
        allocationCounted: null,
        status: "deletion_failed",
      });

      expect(await countAllocatedWorkloadsOnNodeWithDatabase(dbWrite, pending.nodeId)).toBe(1);
      expect(await countAllocatedWorkloadsOnNodeWithDatabase(dbWrite, failed.nodeId)).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a live row with no deletion intent is unaffected",
    async () => {
      if (!pgliteReady) return;
      const { nodeId } = await seedNodeWithTargetAndSibling({
        allocationCounted: null,
        status: "running",
        withDeletionIntent: false,
      });

      expect(await countAllocatedWorkloadsOnNodeWithDatabase(dbWrite, nodeId)).toBe(1);
    },
    PGLITE_TIMEOUT,
  );
});

describe("enqueueAgentDeleteOnce initializes ownership from the pre-delete state", () => {
  test(
    "an explicit state-loss acknowledgement is durable job authority",
    async () => {
      if (!pgliteReady) return;
      const { agentId, orgId, userId } = await seedAgentViaService();

      const enqueued = await new ProvisioningJobService().enqueueAgentDeleteOnce({
        agentId,
        organizationId: orgId,
        userId,
        authorization: "user_request",
        stateLossAcknowledged: true,
      });

      expect(enqueued.job.data).toMatchObject({
        agentId,
        organizationId: orgId,
        userId,
        authorization: "user_request",
        stateLossAcknowledged: true,
        stateLossAcknowledgedByUserId: userId,
      });
      expect(enqueued.job.data.stateLossAcknowledgedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a repeated delete monotonically upgrades the in-flight job with state-loss authority",
    async () => {
      if (!pgliteReady) return;
      const { agentId, orgId, userId } = await seedAgentViaService();
      const [acknowledgingUser] = await dbWrite
        .insert(users)
        .values({ steward_user_id: uniq("steward"), organization_id: orgId })
        .returning();
      const service = new ProvisioningJobService();

      const first = await service.enqueueAgentDeleteOnce({
        agentId,
        organizationId: orgId,
        userId,
        authorization: "user_request",
      });
      expect(first.created).toBe(true);
      expect(first.job.data.stateLossAcknowledged).toBeUndefined();

      const upgraded = await service.enqueueAgentDeleteOnce({
        agentId,
        organizationId: orgId,
        userId: acknowledgingUser.id,
        authorization: "user_request",
        stateLossAcknowledged: true,
      });
      expect(upgraded.created).toBe(false);
      expect(upgraded.job.id).toBe(first.job.id);
      expect(upgraded.job.data).toMatchObject({
        userId,
        stateLossAcknowledged: true,
        stateLossAcknowledgedByUserId: acknowledgingUser.id,
      });
      const acknowledgedAt = upgraded.job.data.stateLossAcknowledgedAt;
      expect(acknowledgedAt).toBeString();

      const reusedWithoutAuthority = await service.enqueueAgentDeleteOnce({
        agentId,
        organizationId: orgId,
        userId,
        authorization: "user_request",
      });
      expect(reusedWithoutAuthority.created).toBe(false);
      expect(reusedWithoutAuthority.job.data).toMatchObject({
        stateLossAcknowledged: true,
        stateLossAcknowledgedByUserId: acknowledgingUser.id,
        stateLossAcknowledgedAt: acknowledgedAt,
      });
    },
    PGLITE_TIMEOUT,
  );

  test(
    "an acknowledgement committed during capture requeues the stale attempt with its actual actor",
    async () => {
      if (!pgliteReady) return;
      const { agentId, orgId, userId } = await seedAgentViaService();
      const [acknowledgingUser] = await dbWrite
        .insert(users)
        .values({ steward_user_id: uniq("steward"), organization_id: orgId })
        .returning();
      const service = new ProvisioningJobService({
        executionOwnerId: crypto.randomUUID(),
        executionLeaseMs: 10_000,
        executionLeaseHeartbeatMs: 1_000,
      });
      await dbWrite
        .update(jobs)
        .set({ status: "completed", completed_at: new Date() })
        .where(and(eq(jobs.type, JOB_TYPES.AGENT_DELETE), eq(jobs.status, "pending")));
      const first = await service.enqueueAgentDeleteOnce({
        agentId,
        organizationId: orgId,
        userId,
        authorization: "user_request",
      });
      await dbWrite.update(jobs).set({ max_attempts: 1 }).where(eq(jobs.id, first.job.id));

      let enterCapture!: () => void;
      let releaseCapture!: () => void;
      const captureEntered = new Promise<void>((resolve) => {
        enterCapture = resolve;
      });
      const captureRelease = new Promise<void>((resolve) => {
        releaseCapture = resolve;
      });
      let executionCalls = 0;
      const deletionSpy = spyOn(elizaSandboxService, "executeDeletion").mockImplementation(
        async () => {
          executionCalls += 1;
          if (executionCalls === 1) {
            enterCapture();
            await captureRelease;
            return {
              success: false,
              containerStopped: false,
              rowDeleted: false,
              error: "pre-deletion capture refused after barrier",
            };
          }
          return { success: true, containerStopped: true, rowDeleted: true };
        },
      );

      try {
        const processing = service.processPendingJobs(1, {
          jobTypes: [JOB_TYPES.AGENT_DELETE],
        });
        await captureEntered;
        const upgraded = await service.enqueueAgentDeleteOnce({
          agentId,
          organizationId: orgId,
          userId: acknowledgingUser.id,
          authorization: "user_request",
          stateLossAcknowledged: true,
        });
        expect(upgraded.job.id).toBe(first.job.id);
        expect(upgraded.job.data).toMatchObject({
          userId,
          stateLossAcknowledged: true,
          stateLossAcknowledgedByUserId: acknowledgingUser.id,
        });
        releaseCapture();
        const firstPass = await processing;

        expect(firstPass).toMatchObject({
          succeeded: 0,
          retried: 1,
          failed: 0,
        });
        const [requeued] = await dbWrite.select().from(jobs).where(eq(jobs.id, first.job.id));
        expect(requeued).toMatchObject({ status: "pending", attempts: 0 });
        expect(requeued.data).toMatchObject({
          stateLossAcknowledged: true,
          stateLossAcknowledgedByUserId: acknowledgingUser.id,
        });
        expect(requeued.result).toMatchObject({
          stateLossAcknowledged: true,
          stateLossAcknowledgedByUserId: acknowledgingUser.id,
          error: "pre-deletion capture refused after barrier",
        });

        const secondPass = await service.processPendingJobs(1, {
          jobTypes: [JOB_TYPES.AGENT_DELETE],
        });
        expect(secondPass).toMatchObject({
          succeeded: 1,
          retried: 0,
          failed: 0,
        });
        const [completed] = await dbWrite.select().from(jobs).where(eq(jobs.id, first.job.id));
        expect(completed.status).toBe("completed");
        expect(completed.result).toMatchObject({
          stateLossAcknowledged: true,
          stateLossAcknowledgedByUserId: acknowledgingUser.id,
          rowDeleted: true,
        });
      } finally {
        releaseCapture();
        deletionSpy.mockRestore();
      }
    },
    PGLITE_TIMEOUT,
  );

  test(
    "an acknowledgement committed during successful capture is present in the completed result",
    async () => {
      if (!pgliteReady) return;
      const { agentId, orgId, userId } = await seedAgentViaService();
      const [acknowledgingUser] = await dbWrite
        .insert(users)
        .values({ steward_user_id: uniq("steward"), organization_id: orgId })
        .returning();
      const service = new ProvisioningJobService({
        executionOwnerId: crypto.randomUUID(),
        executionLeaseMs: 10_000,
        executionLeaseHeartbeatMs: 1_000,
      });
      await dbWrite
        .update(jobs)
        .set({ status: "completed", completed_at: new Date() })
        .where(and(eq(jobs.type, JOB_TYPES.AGENT_DELETE), eq(jobs.status, "pending")));
      const first = await service.enqueueAgentDeleteOnce({
        agentId,
        organizationId: orgId,
        userId,
        authorization: "user_request",
      });

      let enterCapture!: () => void;
      let releaseCapture!: () => void;
      const captureEntered = new Promise<void>((resolve) => {
        enterCapture = resolve;
      });
      const captureRelease = new Promise<void>((resolve) => {
        releaseCapture = resolve;
      });
      const deletionSpy = spyOn(elizaSandboxService, "executeDeletion").mockImplementation(
        async () => {
          enterCapture();
          await captureRelease;
          return { success: true, containerStopped: true, rowDeleted: true };
        },
      );

      try {
        const processing = service.processPendingJobs(1, {
          jobTypes: [JOB_TYPES.AGENT_DELETE],
        });
        await captureEntered;
        const upgraded = await service.enqueueAgentDeleteOnce({
          agentId,
          organizationId: orgId,
          userId: acknowledgingUser.id,
          authorization: "user_request",
          stateLossAcknowledged: true,
        });
        const acknowledgedAt = upgraded.job.data.stateLossAcknowledgedAt;
        expect(acknowledgedAt).toBeString();
        releaseCapture();

        expect(await processing).toMatchObject({
          succeeded: 1,
          retried: 0,
          failed: 0,
        });
        const [completed] = await dbWrite.select().from(jobs).where(eq(jobs.id, first.job.id));
        expect(completed).toMatchObject({ status: "completed", attempts: 0 });
        expect(completed.data).toMatchObject({
          userId,
          stateLossAcknowledged: true,
          stateLossAcknowledgedByUserId: acknowledgingUser.id,
          stateLossAcknowledgedAt: acknowledgedAt,
        });
        expect(completed.result).toMatchObject({
          stateLossAcknowledged: true,
          stateLossAcknowledgedByUserId: acknowledgingUser.id,
          stateLossAcknowledgedAt: acknowledgedAt,
          rowDeleted: true,
        });
      } finally {
        releaseCapture();
        deletionSpy.mockRestore();
      }
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a placed, running agent starts its deletion owning one slot; a re-enqueue keeps that answer",
    async () => {
      if (!pgliteReady) return;
      const { agentId, orgId, userId } = await seedAgentViaService();
      const nodeId = uniq("node");
      await dbWrite
        .insert(dockerNodes)
        .values({ node_id: nodeId, hostname: `${nodeId}.test.invalid`, allocated_count: 2 });
      await dbWrite
        .update(agentSandboxes)
        .set({ status: "running", node_id: nodeId, container_name: uniq("container") })
        .where(eq(agentSandboxes.id, agentId));

      await new ProvisioningJobService().enqueueAgentDeleteOnce({
        agentId,
        organizationId: orgId,
        userId,
        // #18573's admission guard refuses an unqualified delete of a running
        // dedicated agent; this first enqueue models an authorized user request.
        authorization: "user_request",
      });
      expect(await ownership(agentId)).toBe(true);

      // Release, then let a recovery sweep re-enqueue. Re-deriving ownership here
      // would read the row's own `deletion_pending` status as "still counted" and
      // free a slot on every sweep; inheriting keeps the released answer.
      const attemptId = await deletionAttemptId(agentId);
      await agentSandboxesRepository.tryReleaseDeletionAllocation(
        agentId,
        orgId,
        attemptId,
        nodeId,
      );
      expect(await allocatedCount(nodeId)).toBe(1);

      await new ProvisioningJobService().enqueueAgentDeleteOnce({
        agentId,
        organizationId: orgId,
        userId,
      });
      expect(await ownership(agentId)).toBe(false);
      expect(await allocatedCount(nodeId)).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a suspended agent starts its deletion owning nothing",
    async () => {
      if (!pgliteReady) return;
      const { agentId, orgId, userId } = await seedAgentViaService();
      const nodeId = uniq("node");
      await dbWrite
        .insert(dockerNodes)
        .values({ node_id: nodeId, hostname: `${nodeId}.test.invalid`, allocated_count: 2 });
      // Suspend already gave the slot back while keeping the locator.
      await dbWrite
        .update(agentSandboxes)
        .set({ status: "stopped", node_id: nodeId, container_name: uniq("container") })
        .where(eq(agentSandboxes.id, agentId));

      await new ProvisioningJobService().enqueueAgentDeleteOnce({
        agentId,
        organizationId: orgId,
        userId,
      });

      expect(await ownership(agentId)).toBe(false);
      const attemptId = await deletionAttemptId(agentId);
      await agentSandboxesRepository.tryReleaseDeletionAllocation(
        agentId,
        orgId,
        attemptId,
        nodeId,
      );
      expect(await allocatedCount(nodeId)).toBe(2);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "an unplaced (shared-tier) agent starts its deletion owning nothing",
    async () => {
      if (!pgliteReady) return;
      const { agentId, orgId, userId } = await seedAgentViaService();

      await new ProvisioningJobService().enqueueAgentDeleteOnce({
        agentId,
        organizationId: orgId,
        userId,
      });

      expect(await ownership(agentId)).toBe(false);
    },
    PGLITE_TIMEOUT,
  );
});

// Loud guard: PGlite is in-process (no network), so `pgliteReady` must be true.
// Without this a pushSchema failure would early-return every case above and a
// capacity-safety proof would masquerade as a vacuous green.
test("pglite schema applied — never a silent skip", () => {
  expect(pgliteReady).toBe(true);
});
