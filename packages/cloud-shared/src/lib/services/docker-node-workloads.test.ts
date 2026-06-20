/**
 * Tests for the orphan-container reconciler's pure diff logic and its
 * SSH-orchestration loop. The diff (`computeOrphanContainersToReap`) is the
 * load-bearing safety property: a container is reaped ONLY when its agent id
 * has no live DB row (or a terminal one), and never when the name does not
 * match the managed `agent-<id>` pattern. The orchestration test pins the
 * "never reap on an unreachable node" invariant (SSH listing returned null →
 * skip, not reap).
 */

import { describe, expect, mock, test } from "bun:test";
import {
  agentIdFromContainerName,
  computeOrphanContainersToReap,
  type LiveSandboxRef,
  type NodeContainerRef,
  type OrphanReconcilerNode,
  reconcileOrphanContainers,
} from "./docker-node-workloads";

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

describe("computeOrphanContainersToReap", () => {
  const live = (id: string, status: string): LiveSandboxRef => ({ id, status });
  const container = (name: string, id: string): NodeContainerRef => ({ name, id });

  test("reaps a container whose agent id has NO db row", () => {
    const orphans = computeOrphanContainersToReap([container("agent-gone", "c1")], []);
    expect(orphans).toEqual([
      { name: "agent-gone", id: "c1", agentId: "gone", reason: "no_db_row" },
    ]);
  });

  test("reaps a container whose db row is in a terminal state", () => {
    const orphans = computeOrphanContainersToReap(
      [container("agent-dead", "c2")],
      [live("dead", "stopped")],
    );
    expect(orphans).toEqual([
      { name: "agent-dead", id: "c2", agentId: "dead", reason: "terminal_db_row" },
    ]);
  });

  test("treats error / sleeping / deletion_failed rows as terminal", () => {
    for (const status of ["error", "sleeping", "deletion_failed"]) {
      const orphans = computeOrphanContainersToReap(
        [container("agent-x", "cx")],
        [live("x", status)],
      );
      expect(orphans).toHaveLength(1);
      expect(orphans[0]?.reason).toBe("terminal_db_row");
    }
  });

  test("does NOT reap a container with a live (running) db row", () => {
    const orphans = computeOrphanContainersToReap(
      [container("agent-live", "c3")],
      [live("live", "running")],
    );
    expect(orphans).toEqual([]);
  });

  test("does NOT reap a row in deletion_pending (delete job owns teardown)", () => {
    const orphans = computeOrphanContainersToReap(
      [container("agent-deleting", "c4")],
      [live("deleting", "deletion_pending")],
    );
    expect(orphans).toEqual([]);
  });

  test("does NOT reap provisioning / pending / disconnected rows", () => {
    for (const status of ["provisioning", "pending", "disconnected"]) {
      const orphans = computeOrphanContainersToReap(
        [container("agent-x", "cx")],
        [live("x", status)],
      );
      expect(orphans).toEqual([]);
    }
  });

  test("ignores containers that do not match the agent- pattern", () => {
    const orphans = computeOrphanContainersToReap(
      [container("postgres", "p1"), container("redis", "r1")],
      [],
    );
    expect(orphans).toEqual([]);
  });

  test("mixed fleet: reaps only the orphans, leaves live + non-agent alone", () => {
    const orphans = computeOrphanContainersToReap(
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

describe("reconcileOrphanContainers (orchestration)", () => {
  function makeNode(overrides: Partial<OrphanReconcilerNode> = {}): OrphanReconcilerNode {
    return {
      node_id: "node-1",
      hostname: "host-1",
      status: "healthy",
      listAgentContainers: mock(async () => [] as NodeContainerRef[]),
      removeContainer: mock(async () => {}),
      ...overrides,
    };
  }

  test("force-removes every orphan on a healthy node", async () => {
    const removeContainer = mock(async () => {});
    const node = makeNode({
      listAgentContainers: mock(async () => [
        { name: "agent-orphan", id: "c-orph" },
        { name: "agent-live", id: "c-live" },
      ]),
      removeContainer,
    });
    const loadLive = mock(async () => [{ id: "live", status: "running" }]);

    const result = await reconcileOrphanContainers([node], loadLive);

    expect(removeContainer).toHaveBeenCalledTimes(1);
    expect(removeContainer).toHaveBeenCalledWith("c-orph");
    expect(result).toEqual({
      nodesScanned: 1,
      nodesSkipped: 0,
      reaped: 1,
      reapFailed: 0,
    });
  });

  test("SKIPS a node whose container listing failed — never reaps on a blind node", async () => {
    const removeContainer = mock(async () => {});
    const node = makeNode({
      listAgentContainers: mock(async () => null),
      removeContainer,
    });

    const result = await reconcileOrphanContainers([node], async () => []);

    expect(removeContainer).not.toHaveBeenCalled();
    expect(result).toEqual({
      nodesScanned: 0,
      nodesSkipped: 1,
      reaped: 0,
      reapFailed: 0,
    });
  });

  test("SKIPS a non-healthy node (defensive: caller should pre-filter)", async () => {
    const listAgentContainers = mock(async () => [] as NodeContainerRef[]);
    const node = makeNode({ status: "offline", listAgentContainers });

    const result = await reconcileOrphanContainers([node], async () => []);

    expect(listAgentContainers).not.toHaveBeenCalled();
    expect(result.nodesSkipped).toBe(1);
    expect(result.nodesScanned).toBe(0);
  });

  test("counts a failed removal as reapFailed without aborting the rest", async () => {
    const node = makeNode({
      listAgentContainers: mock(async () => [
        { name: "agent-a", id: "ca" },
        { name: "agent-b", id: "cb" },
      ]),
      removeContainer: mock(async (id: string) => {
        if (id === "ca") throw new Error("ssh broke");
      }),
    });

    const result = await reconcileOrphanContainers([node], async () => []);

    expect(result).toEqual({
      nodesScanned: 1,
      nodesSkipped: 0,
      reaped: 1,
      reapFailed: 1,
    });
  });

  test("does not query the DB when a node has no agent- containers", async () => {
    const loadLive = mock(async () => [] as LiveSandboxRef[]);
    const node = makeNode({
      listAgentContainers: mock(async () => [{ name: "redis", id: "r" }]),
    });

    await reconcileOrphanContainers([node], loadLive);

    expect(loadLive).not.toHaveBeenCalled();
  });
});
