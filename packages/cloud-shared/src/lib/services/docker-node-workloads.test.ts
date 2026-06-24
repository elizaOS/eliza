/**
 * Tests for the AGENT orphan-container reconciler. The diff and orchestration
 * loop now live in the shared `orphan-container-reconciler.ts`; this suite pins
 * the AGENT-specific wiring: the `agentIdFromContainerName` keyOf (parse the id
 * out of `agent-<id>`), the agent terminal-status vocab, and that the shared
 * diff reaps an agent container ONLY when its id has no live DB row (or a
 * terminal one) and NEVER when the name does not match the managed pattern. The
 * orchestration test pins the "never reap on an unreachable node" invariant
 * (SSH listing returned null → skip, not reap).
 *
 * Because `agent_sandboxes.id` is a PRIMARY KEY, each agent id maps to AT MOST
 * one DB row, so the shared group-by-key `every-terminal` diff reduces to a
 * plain single-status check here — identical reaping decisions to the previous
 * per-agent `Map<id,status>` last-write-wins implementation.
 */

import { describe, expect, mock, test } from "bun:test";
import { agentIdFromContainerName } from "./docker-node-workloads";
import {
  computeOrphanContainersToReap,
  type LiveContainerRef,
  type NodeContainerRef,
  type OrphanReconcilerConfig,
  type OrphanReconcilerNode,
  reconcileOrphanContainers,
} from "./orphan-container-reconciler";

/** The agent reconciler's pure-diff deltas (matches the production config). */
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
  const container = (name: string, id: string): NodeContainerRef => ({ name, id });
  const compute = (containers: readonly NodeContainerRef[], rows: readonly LiveContainerRef[]) =>
    computeOrphanContainersToReap(containers, rows, AGENT_DIFF);

  test("reaps a container whose agent id has NO db row", () => {
    const orphans = compute([container("agent-gone", "c1")], []);
    expect(orphans).toEqual([{ name: "agent-gone", id: "c1", key: "gone", reason: "no_db_row" }]);
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

  test("does NOT reap a container with a live (running) db row", () => {
    const orphans = compute([container("agent-live", "c3")], [live("live", "running")]);
    expect(orphans).toEqual([]);
  });

  test("does NOT reap a row in deletion_pending (delete job owns teardown)", () => {
    const orphans = compute(
      [container("agent-deleting", "c4")],
      [live("deleting", "deletion_pending")],
    );
    expect(orphans).toEqual([]);
  });

  test("does NOT reap provisioning / pending / disconnected rows", () => {
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
        { name: "agent-orphan", id: "c-orph" },
        { name: "agent-live", id: "c-live" },
      ]),
      removeContainer,
    });
    const loadLive = mock(async () => [{ key: "live", status: "running" }]);

    const result = await reconcileOrphanContainers([node], makeConfig(loadLive));

    expect(removeContainer).toHaveBeenCalledTimes(1);
    expect(removeContainer).toHaveBeenCalledWith("c-orph");
    expect(result).toEqual({ nodesScanned: 1, nodesSkipped: 0, reaped: 1, reapFailed: 0 });
  });

  test("SKIPS a node whose container listing failed — never reaps on a blind node", async () => {
    const removeContainer = mock(async () => {});
    const node = makeNode({ listContainers: mock(async () => null), removeContainer });

    const result = await reconcileOrphanContainers(
      [node],
      makeConfig(async () => []),
    );

    expect(removeContainer).not.toHaveBeenCalled();
    expect(result).toEqual({ nodesScanned: 0, nodesSkipped: 1, reaped: 0, reapFailed: 0 });
  });

  test("SKIPS a non-healthy node (defensive: caller should pre-filter)", async () => {
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
        { name: "agent-a", id: "ca" },
        { name: "agent-b", id: "cb" },
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
