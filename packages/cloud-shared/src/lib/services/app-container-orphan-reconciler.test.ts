/**
 * Tests for the orphan APP-container reconciler's pure diff logic and its
 * SSH-orchestration loop, mirroring `docker-node-workloads.test.ts` for the
 * apps (`containers` table) variant.
 *
 * The diff (`computeOrphanAppContainersToReap`) is the load-bearing safety
 * property: an `app-<slug>` container is reaped ONLY when its NAME has no live
 * `containers` row (or a terminal one), and NEVER when the name does not match
 * the managed `app-` pattern. The orchestration test pins the "never reap on an
 * unreachable node" invariant (SSH listing returned null → skip, not reap) and
 * the reap-by-id invariant (the rm targets the immutable container id, not the
 * name).
 */

import { describe, expect, mock, test } from "bun:test";
import {
  type AppOrphanReconcilerNode,
  computeOrphanAppContainersToReap,
  isAppContainerName,
  type LiveAppContainerRef,
  type NodeAppContainerRef,
  reconcileOrphanAppContainers,
} from "./app-container-orphan-reconciler";

describe("isAppContainerName", () => {
  test("accepts an app-<slug> name", () => {
    expect(isAppContainerName("app-abc123def456")).toBe(true);
  });

  test("rejects names without the app- prefix", () => {
    expect(isAppContainerName("postgres")).toBe(false);
    expect(isAppContainerName("agent-abc")).toBe(false);
    // substring match elsewhere in the name must NOT count
    expect(isAppContainerName("my-app-x")).toBe(false);
  });

  test("rejects a bare prefix with no slug", () => {
    expect(isAppContainerName("app-")).toBe(false);
  });
});

describe("computeOrphanAppContainersToReap", () => {
  const live = (name: string, status: string): LiveAppContainerRef => ({ name, status });
  const container = (name: string, id: string): NodeAppContainerRef => ({ name, id });

  test("reaps a container whose name has NO db row", () => {
    const orphans = computeOrphanAppContainersToReap([container("app-gone", "c1")], []);
    expect(orphans).toEqual([{ name: "app-gone", id: "c1", reason: "no_db_row" }]);
  });

  test("reaps a container whose db row is in a terminal state (stopped/failed/deleted)", () => {
    for (const status of ["stopped", "failed", "deleted"]) {
      const orphans = computeOrphanAppContainersToReap(
        [container("app-dead", "c2")],
        [live("app-dead", status)],
      );
      expect(orphans).toEqual([{ name: "app-dead", id: "c2", reason: "terminal_db_row" }]);
    }
  });

  test("does NOT reap a container with a live (running) db row", () => {
    const orphans = computeOrphanAppContainersToReap(
      [container("app-live", "c3")],
      [live("app-live", "running")],
    );
    expect(orphans).toEqual([]);
  });

  test("does NOT reap deploying / building / pending rows", () => {
    for (const status of ["deploying", "building", "pending"]) {
      const orphans = computeOrphanAppContainersToReap(
        [container("app-x", "cx")],
        [live("app-x", status)],
      );
      expect(orphans).toEqual([]);
    }
  });

  test("does NOT reap a row in 'deleting' (delete job owns teardown)", () => {
    const orphans = computeOrphanAppContainersToReap(
      [container("app-deleting", "c4")],
      [live("app-deleting", "deleting")],
    );
    expect(orphans).toEqual([]);
  });

  test("ignores containers that do not match the app- pattern", () => {
    const orphans = computeOrphanAppContainersToReap(
      [container("postgres", "p1"), container("agent-abc", "a1"), container("redis", "r1")],
      [],
    );
    expect(orphans).toEqual([]);
  });

  test("mixed fleet: reaps only the orphans, leaves live + non-app alone", () => {
    const orphans = computeOrphanAppContainersToReap(
      [
        container("app-running", "c-run"),
        container("app-orphan", "c-orph"),
        container("app-stopped", "c-stop"),
        container("agent-foo", "c-agent"),
        container("nginx", "c-nginx"),
      ],
      [live("app-running", "running"), live("app-stopped", "stopped")],
    );
    expect(orphans.map((o) => o.id).sort()).toEqual(["c-orph", "c-stop"]);
  });
});

describe("reconcileOrphanAppContainers (orchestration)", () => {
  function makeNode(overrides: Partial<AppOrphanReconcilerNode> = {}): AppOrphanReconcilerNode {
    return {
      node_id: "node-1",
      hostname: "host-1",
      status: "healthy",
      listAppContainers: mock(async () => [] as NodeAppContainerRef[]),
      removeContainer: mock(async () => {}),
      ...overrides,
    };
  }

  test("force-removes every orphan on a healthy node — BY ID, not name", async () => {
    const removeContainer = mock(async () => {});
    const node = makeNode({
      listAppContainers: mock(async () => [
        { name: "app-orphan", id: "c-orph" },
        { name: "app-live", id: "c-live" },
      ]),
      removeContainer,
    });
    const loadLive = mock(async () => [{ name: "app-live", status: "running" }]);

    const result = await reconcileOrphanAppContainers([node], loadLive);

    expect(removeContainer).toHaveBeenCalledTimes(1);
    // reap-by-id invariant: the rm target is the immutable container id, NOT the name.
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
      listAppContainers: mock(async () => null),
      removeContainer,
    });

    const result = await reconcileOrphanAppContainers([node], async () => []);

    expect(removeContainer).not.toHaveBeenCalled();
    expect(result).toEqual({
      nodesScanned: 0,
      nodesSkipped: 1,
      reaped: 0,
      reapFailed: 0,
    });
  });

  test("SKIPS a non-healthy node (defensive: caller should pre-filter)", async () => {
    const listAppContainers = mock(async () => [] as NodeAppContainerRef[]);
    const node = makeNode({ status: "offline", listAppContainers });

    const result = await reconcileOrphanAppContainers([node], async () => []);

    expect(listAppContainers).not.toHaveBeenCalled();
    expect(result.nodesSkipped).toBe(1);
    expect(result.nodesScanned).toBe(0);
  });

  test("counts a failed removal as reapFailed without aborting the rest", async () => {
    const node = makeNode({
      listAppContainers: mock(async () => [
        { name: "app-a", id: "ca" },
        { name: "app-b", id: "cb" },
      ]),
      removeContainer: mock(async (id: string) => {
        if (id === "ca") throw new Error("ssh broke");
      }),
    });

    const result = await reconcileOrphanAppContainers([node], async () => []);

    expect(result).toEqual({
      nodesScanned: 1,
      nodesSkipped: 0,
      reaped: 1,
      reapFailed: 1,
    });
  });

  test("does not query the DB when a node has no app- containers", async () => {
    const loadLive = mock(async () => [] as LiveAppContainerRef[]);
    const node = makeNode({
      listAppContainers: mock(async () => [{ name: "agent-foo", id: "a" }]),
    });

    await reconcileOrphanAppContainers([node], loadLive);

    expect(loadLive).not.toHaveBeenCalled();
  });
});
