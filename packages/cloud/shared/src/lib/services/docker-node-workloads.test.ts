/**
 * Covers the agent-specific name, status, placement, and orchestration rules
 * supplied to the shared Docker orphan reconciler.
 */

import { describe, expect, mock, spyOn, test } from "bun:test";
import { logger } from "../utils/logger";
import { agentIdFromContainerName } from "./docker-node-workloads";
import {
  computeOrphanContainersToReap,
  type LiveContainerRef,
  type NodeContainerRef,
  type OrphanReconcilerConfig,
  type OrphanReconcilerNode,
  reconcileOrphanContainers,
} from "./orphan-container-reconciler";

const AGENT_DIFF: Pick<OrphanReconcilerConfig, "keyOf" | "terminalStatuses"> = {
  keyOf: agentIdFromContainerName,
  terminalStatuses: new Set(["stopped", "error", "sleeping", "deletion_failed"]),
};

describe("agentIdFromContainerName", () => {
  test("extracts the id from an agent-<id> name", () => {
    expect(agentIdFromContainerName("agent-abc-123")).toBe("abc-123");
  });

  test("returns null for names without the agent- prefix", () => {
    expect(agentIdFromContainerName("postgres")).toBeNull();
    expect(agentIdFromContainerName("my-agent-x")).toBeNull();
  });

  test("returns null for a bare prefix with no id", () => {
    expect(agentIdFromContainerName("agent-")).toBeNull();
  });
});

describe("computeOrphanContainersToReap (agent diff)", () => {
  const live = (key: string, status: string): LiveContainerRef => ({ key, status });
  const NOW_MS = 10 * 60_000;
  const container = (name: string, id: string): NodeContainerRef => ({
    name,
    id,
    createdAtMs: 0,
  });
  const compute = (containers: readonly NodeContainerRef[], rows: readonly LiveContainerRef[]) =>
    computeOrphanContainersToReap(containers, rows, AGENT_DIFF, undefined, NOW_MS);

  test("reaps a container whose agent id has no database row", () => {
    const orphans = compute([container("agent-gone", "c1")], []);
    expect(orphans).toEqual([{ name: "agent-gone", id: "c1", key: "gone", reason: "no_db_row" }]);
  });

  test("retains a young container without a database row during the grace window", () => {
    const young: NodeContainerRef = {
      name: "agent-gone",
      id: "c1",
      createdAtMs: NOW_MS - 1_000,
    };
    expect(computeOrphanContainersToReap([young], [], AGENT_DIFF, undefined, NOW_MS)).toEqual([]);
  });

  test("retains a rowless container when Docker did not provide its age", () => {
    const unknownAge: NodeContainerRef = { name: "agent-gone", id: "c1" };
    expect(computeOrphanContainersToReap([unknownAge], [], AGENT_DIFF, undefined, NOW_MS)).toEqual(
      [],
    );
  });

  test("retains a rowless container when no classification clock is available", () => {
    expect(computeOrphanContainersToReap([container("agent-gone", "c1")], [], AGENT_DIFF)).toEqual(
      [],
    );
  });

  test("reaps a container whose db row is in a terminal state", () => {
    const orphans = compute([container("agent-dead", "c2")], [live("dead", "stopped")]);
    expect(orphans).toEqual([
      { name: "agent-dead", id: "c2", key: "dead", reason: "terminal_db_row" },
    ]);
  });

  test("treats error / sleeping / deletion_failed rows as terminal", () => {
    for (const status of ["error", "sleeping", "deletion_failed"]) {
      const orphans = compute([container("agent-x", "cx")], [live("x", status)]);
      expect(orphans).toHaveLength(1);
      expect(orphans[0]?.reason).toBe("terminal_db_row");
    }
  });

  test("retains a container with a live database row", () => {
    const orphans = compute([container("agent-live", "c3")], [live("live", "running")]);
    expect(orphans).toEqual([]);
  });

  test("keeps both primary and replacement placements owned by one sandbox row", () => {
    const rows: LiveContainerRef[] = [
      { key: "same", status: "running", nodeId: "node-old", updatedAtMs: 1 },
      {
        key: "same",
        status: "replacement_cleanup_owned",
        nodeId: "node-new",
        updatedAtMs: 1,
      },
    ];
    const config = { ...AGENT_DIFF, nodeAware: true, nodeMoveGraceMs: 1 };

    expect(
      computeOrphanContainersToReap(
        [{ ...container("agent-same", "old"), createdAtMs: 1 }],
        rows,
        config,
        "node-old",
        10,
      ),
    ).toEqual([]);
    expect(
      computeOrphanContainersToReap(
        [{ ...container("agent-same", "new"), createdAtMs: 1 }],
        rows,
        config,
        "node-new",
        10,
      ),
    ).toEqual([]);
    expect(
      computeOrphanContainersToReap(
        [{ ...container("agent-same", "ghost"), createdAtMs: 1 }],
        rows,
        config,
        "node-third",
        10,
      ),
    ).toEqual([{ name: "agent-same", id: "ghost", key: "same", reason: "wrong_node" }]);
  });

  test("retains deletion_pending while the delete job owns teardown", () => {
    const orphans = compute(
      [container("agent-deleting", "c4")],
      [live("deleting", "deletion_pending")],
    );
    expect(orphans).toEqual([]);
  });

  test("retains provisioning, pending, and disconnected rows", () => {
    for (const status of ["provisioning", "pending", "disconnected"]) {
      const orphans = compute([container("agent-x", "cx")], [live("x", status)]);
      expect(orphans).toEqual([]);
    }
  });

  test("ignores containers that do not match the agent- pattern", () => {
    const orphans = compute([container("postgres", "p1"), container("redis", "r1")], []);
    expect(orphans).toEqual([]);
  });

  test("mixed fleet: reaps only the orphans, leaves live + non-agent alone", () => {
    const orphans = compute(
      [
        container("agent-running", "c-run"),
        container("agent-orphan", "c-orph"),
        container("agent-stopped", "c-stop"),
        container("nginx", "c-nginx"),
      ],
      [live("running", "running"), live("stopped", "stopped")],
    );
    expect(orphans.map((o) => o.id).sort()).toEqual(["c-orph", "c-stop"]);
  });
});

describe("reconcileOrphanContainers (agent orchestration)", () => {
  function makeConfig(
    loadStatuses: OrphanReconcilerConfig["loadStatuses"],
  ): OrphanReconcilerConfig {
    return {
      prefix: "agent-",
      keyOf: AGENT_DIFF.keyOf,
      terminalStatuses: AGENT_DIFF.terminalStatuses,
      loadStatuses,
      logScope: "orphan-reconciler",
    };
  }

  function makeNode(overrides: Partial<OrphanReconcilerNode> = {}): OrphanReconcilerNode {
    return {
      node_id: "node-1",
      hostname: "host-1",
      status: "healthy",
      listContainers: mock(async () => [] as NodeContainerRef[]),
      removeContainer: mock(async () => {}),
      ...overrides,
    };
  }

  test("force-removes every orphan on a healthy node", async () => {
    const removeContainer = mock(async () => {});
    const node = makeNode({
      listContainers: mock(async () => [
        { name: "agent-orphan", id: "c-orph", createdAtMs: 0 },
        { name: "agent-live", id: "c-live", createdAtMs: 0 },
      ]),
      removeContainer,
    });
    const loadLive = mock(async () => [{ key: "live", status: "running" }]);

    const result = await reconcileOrphanContainers([node], makeConfig(loadLive));

    expect(removeContainer).toHaveBeenCalledTimes(1);
    expect(removeContainer).toHaveBeenCalledWith("c-orph");
    expect(result).toEqual({ nodesScanned: 1, nodesSkipped: 0, reaped: 1, reapFailed: 0 });
  });

  test("logs structured retain and reap decisions", async () => {
    const debugLog = spyOn(logger, "debug").mockImplementation(() => {});
    const infoLog = spyOn(logger, "info").mockImplementation(() => {});
    const node = makeNode({
      listContainers: mock(async () => [
        { name: "agent-live", id: "c-live", createdAtMs: 0 },
        { name: "agent-stopped", id: "c-stopped", createdAtMs: 0 },
      ]),
    });

    try {
      await reconcileOrphanContainers(
        [node],
        makeConfig(async () => [
          { key: "live", status: "running" },
          { key: "stopped", status: "stopped" },
        ]),
      );

      expect(debugLog).toHaveBeenCalledWith(
        "[orphan-reconciler] Retained container",
        expect.objectContaining({
          containerId: "c-live",
          decision: "retain",
          reason: "live_db_row",
        }),
      );
      expect(infoLog).toHaveBeenCalledWith(
        "[orphan-reconciler] Reaped orphan container",
        expect.objectContaining({
          containerId: "c-stopped",
          decision: "reap",
          reason: "terminal_db_row",
        }),
      );
    } finally {
      debugLog.mockRestore();
      infoLog.mockRestore();
    }
  });

  test("skips a node whose container listing failed", async () => {
    const removeContainer = mock(async () => {});
    const node = makeNode({ listContainers: mock(async () => null), removeContainer });

    const result = await reconcileOrphanContainers(
      [node],
      makeConfig(async () => []),
    );

    expect(removeContainer).not.toHaveBeenCalled();
    expect(result).toEqual({ nodesScanned: 0, nodesSkipped: 1, reaped: 0, reapFailed: 0 });
  });

  test("skips a non-healthy node before listing containers", async () => {
    const listContainers = mock(async () => [] as NodeContainerRef[]);
    const node = makeNode({ status: "offline", listContainers });

    const result = await reconcileOrphanContainers(
      [node],
      makeConfig(async () => []),
    );

    expect(listContainers).not.toHaveBeenCalled();
    expect(result.nodesSkipped).toBe(1);
    expect(result.nodesScanned).toBe(0);
  });

  test("counts a failed removal as reapFailed without aborting the rest", async () => {
    const node = makeNode({
      listContainers: mock(async () => [
        { name: "agent-a", id: "ca", createdAtMs: 0 },
        { name: "agent-b", id: "cb", createdAtMs: 0 },
      ]),
      removeContainer: mock(async (id: string) => {
        if (id === "ca") throw new Error("ssh broke");
      }),
    });

    const result = await reconcileOrphanContainers(
      [node],
      makeConfig(async () => []),
    );

    expect(result).toEqual({ nodesScanned: 1, nodesSkipped: 0, reaped: 1, reapFailed: 1 });
  });

  test("does not query the DB when a node has no agent- containers", async () => {
    const loadLive = mock(async () => [] as LiveContainerRef[]);
    const node = makeNode({ listContainers: mock(async () => [{ name: "redis", id: "r" }]) });

    await reconcileOrphanContainers([node], makeConfig(loadLive));

    expect(loadLive).not.toHaveBeenCalled();
  });
});
