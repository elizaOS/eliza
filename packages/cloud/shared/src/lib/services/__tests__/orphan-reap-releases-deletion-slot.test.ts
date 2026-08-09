/**
 * The orphan reaper hands back the node slot of the deletion it just proved
 * absent (#17185).
 *
 * A delete that cannot prove the container is gone — a bounded-timeout abandon,
 * or a `deletion_failed` row — deliberately keeps its slot counted. Reaping is
 * the only step that supplies that proof, so it is where the slot is released.
 * Without it, an abandoned deletion holds a slot forever once
 * `reEnqueueFailedDeletions` trips its circuit breaker, permanently shrinking
 * the node and inflating the autoscaler's demand signal (#15378).
 *
 * The load-bearing assumption is an identity spanning two modules: the reaper's
 * `orphan.key` must be an `agent_sandboxes.id`, because `onReaped` feeds it to a
 * CAS keyed on that column. If `keyOf` ever returned a container name or a
 * prefixed id, the CAS would match no row, return false, and the leak would come
 * back silently — the warn only fires *after* a successful claim, so nothing
 * would go red.
 *
 * Drives the REAL `AGENT_ORPHAN_RECONCILER_CONFIG` through the REAL
 * `reconcileOrphanContainers` with a scripted node, so the production `keyOf`
 * and `onReaped` are the ones under test. The repository call is spied rather
 * than hit: what is being pinned is the identity handed across the seam, and the
 * CAS itself already has database coverage in
 * `deletion-allocation-ownership.test.ts`.
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";

const PRIOR_SKIP_ENSURE = process.env.SKIP_AGENT_SANDBOX_ENSURE;
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { AGENT_ORPHAN_RECONCILER_CONFIG } from "../docker-node-workloads";
import {
  type NodeContainerRef,
  type OrphanReconcilerNode,
  reconcileOrphanContainers,
} from "../orphan-container-reconciler";

const NODE_ID = "node-reap-1";
/**
 * Old enough to clear the rowless grace window. A container whose age is unknown
 * or recent is deliberately never reaped: mid-provision it exists before its row
 * commits, so reaping it would kill live work.
 */
const OLD_ENOUGH_MS = 1;
/** A uuid, so a container-name/prefix leak is unmistakable in the assertion. */
const AGENT_ID = "3f1c6b2e-9a44-4d21-8b77-0e5a91c4d2f8";

function nodeWith(containers: NodeContainerRef[]): OrphanReconcilerNode & { removed: string[] } {
  const removed: string[] = [];
  return {
    node_id: NODE_ID,
    hostname: "reap.test.invalid",
    status: "healthy",
    listContainers: async () => containers,
    removeContainer: async (id: string) => {
      removed.push(id);
    },
    removed,
  };
}

describe("orphan reap releases the deletion generation's slot", () => {
  test("keyOf yields the agent id the release CAS is keyed on", () => {
    // The whole seam in one line: whatever the reaper derives from a container
    // name is what reaches a CAS matching `agent_sandboxes.id`.
    expect(AGENT_ORPHAN_RECONCILER_CONFIG.keyOf(`agent-${AGENT_ID}`)).toBe(AGENT_ID);
    expect(AGENT_ORPHAN_RECONCILER_CONFIG.keyOf("unrelated-container")).toBeNull();
  });

  test("a reaped orphan releases exactly that agent's slot on that node", async () => {
    const release = spyOn(agentSandboxesRepository, "releaseDeletionAllocationOnReap")
      // The DB-level behaviour is covered elsewhere; here we assert the call.
      .mockResolvedValue(true);
    try {
      // No live row for this key, so the container is a genuine orphan.
      const node = nodeWith([
        { id: "container-abc", name: `agent-${AGENT_ID}`, createdAtMs: OLD_ENOUGH_MS },
      ]);

      const result = await reconcileOrphanContainers([node], {
        ...AGENT_ORPHAN_RECONCILER_CONFIG,
        loadStatuses: async () => [],
        // The rowless grace window protects the create-before-row-commit race;
        // zero it so the sweep reaps on this pass instead of deferring.
        rowlessGraceMs: 0,
      });

      expect(result.reaped).toBe(1);
      expect(node.removed).toEqual(["container-abc"]);
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(AGENT_ID, NODE_ID);
    } finally {
      release.mockRestore();
    }
  });

  test("a retained container never releases a slot the deletion still owns", async () => {
    const release = spyOn(
      agentSandboxesRepository,
      "releaseDeletionAllocationOnReap",
    ).mockResolvedValue(true);
    try {
      // A live row on this node: the reaper must retain, so the deletion keeps
      // its slot and the release must not fire.
      const node = nodeWith([
        { id: "container-abc", name: `agent-${AGENT_ID}`, createdAtMs: OLD_ENOUGH_MS },
      ]);

      const result = await reconcileOrphanContainers([node], {
        ...AGENT_ORPHAN_RECONCILER_CONFIG,
        loadStatuses: async () => [
          {
            key: AGENT_ID,
            containerName: `agent-${AGENT_ID}`,
            status: "running",
            nodeId: NODE_ID,
            updatedAt: new Date(),
          },
        ],
        rowlessGraceMs: 0,
      });

      expect(result.reaped).toBe(0);
      expect(node.removed).toEqual([]);
      expect(release).not.toHaveBeenCalled();
    } finally {
      release.mockRestore();
    }
  });

  test("a failed release never aborts the sweep", async () => {
    const release = spyOn(
      agentSandboxesRepository,
      "releaseDeletionAllocationOnReap",
    ).mockRejectedValue(new Error("transient database failure"));
    try {
      const node = nodeWith([
        { id: "container-abc", name: `agent-${AGENT_ID}`, createdAtMs: OLD_ENOUGH_MS },
        {
          id: "container-def",
          name: "agent-11111111-2222-4333-8444-555555555555",
          createdAtMs: OLD_ENOUGH_MS,
        },
      ]);

      const result = await reconcileOrphanContainers([node], {
        ...AGENT_ORPHAN_RECONCILER_CONFIG,
        loadStatuses: async () => [],
        rowlessGraceMs: 0,
      });

      // Both containers are still reaped: the bookkeeping is best-effort by
      // contract, and the next sweep retries it against an idempotent CAS.
      expect(result.reaped).toBe(2);
      expect(node.removed).toEqual(["container-abc", "container-def"]);
    } finally {
      release.mockRestore();
    }
  });
});

// bun shares one process across files without --isolate, so an unrestored env
// override here would silently disable the ensure guard for whatever suite runs
// next. Restore exactly what was there before.
afterAll(() => {
  if (PRIOR_SKIP_ENSURE === undefined) delete process.env.SKIP_AGENT_SANDBOX_ENSURE;
  else process.env.SKIP_AGENT_SANDBOX_ENSURE = PRIOR_SKIP_ENSURE;
});
