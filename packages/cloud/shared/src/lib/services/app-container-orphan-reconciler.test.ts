/**
 * Tests for the APP orphan-container reconciler. The diff and orchestration
 * loop now live in the shared `orphan-container-reconciler.ts`; this suite pins
 * the APP-specific wiring: the `appContainerKeyOf` keyOf (the diff key IS the
 * container name), the app terminal-status vocab, and the fail-safe
 * group-by-key diff (#9307) that protects a live app sharing an `app-<slug>`
 * name with stale stopped/failed rows. The orchestration tests pin the "never
 * reap on an unreachable node" and "reap by immutable id, not name" invariants.
 */

import { describe, expect, mock, test } from "bun:test";
import { appContainerKeyOf } from "./app-container-orphan-reconciler";
import {
  computeOrphanContainersToReap,
  type LiveContainerRef,
  type NodeContainerRef,
  type OrphanReconcilerConfig,
  type OrphanReconcilerNode,
  reconcileOrphanContainers,
} from "./orphan-container-reconciler";

/** The app reconciler's pure-diff deltas (matches the production config). */
const APP_DIFF: Pick<OrphanReconcilerConfig, "keyOf" | "terminalStatuses"> = {
  keyOf: appContainerKeyOf,
  terminalStatuses: new Set(["stopped", "failed", "deleted"]),
};

describe("appContainerKeyOf", () => {
  test("accepts an app-<slug> name and returns the name as the key", () => {
    expect(appContainerKeyOf("app-abc123def456")).toBe("app-abc123def456");
  });

  test("rejects names without the app- prefix", () => {
    expect(appContainerKeyOf("postgres")).toBeNull();
    expect(appContainerKeyOf("agent-abc")).toBeNull();
    // substring match elsewhere in the name must NOT count
    expect(appContainerKeyOf("my-app-x")).toBeNull();
  });

  test("rejects a bare prefix with no slug", () => {
    expect(appContainerKeyOf("app-")).toBeNull();
    expect(appContainerKeyOf("app-db-")).toBeNull();
  });

  test("maps a DB ambassador to its owning app container row", () => {
    expect(appContainerKeyOf("app-db-abc123def456")).toBe("app-abc123def456");
  });
});

describe("computeOrphanContainersToReap (app diff)", () => {
  const live = (key: string, status: string): LiveContainerRef => ({ key, status });
  const container = (name: string, id: string): NodeContainerRef => ({ name, id });
  const compute = (containers: readonly NodeContainerRef[], rows: readonly LiveContainerRef[]) =>
    computeOrphanContainersToReap(containers, rows, APP_DIFF);

  test("reaps a container whose name has NO db row", () => {
    const orphans = compute([container("app-gone", "c1")], []);
    expect(orphans).toEqual([{ name: "app-gone", id: "c1", key: "app-gone", reason: "no_db_row" }]);
  });

  test("reaps a container whose db row is in a terminal state (stopped/failed/deleted)", () => {
    for (const status of ["stopped", "failed", "deleted"]) {
      const orphans = compute([container("app-dead", "c2")], [live("app-dead", status)]);
      expect(orphans).toEqual([
        { name: "app-dead", id: "c2", key: "app-dead", reason: "terminal_db_row" },
      ]);
    }
  });

  test("does NOT reap a container with a live (running) db row", () => {
    const orphans = compute([container("app-live", "c3")], [live("app-live", "running")]);
    expect(orphans).toEqual([]);
  });

  test("keeps a running app and its DB ambassador from the same live row", () => {
    const orphans = compute(
      [container("app-live", "app-id"), container("app-db-live", "ambassador-id")],
      [live("app-live", "running")],
    );
    expect(orphans).toEqual([]);
  });

  test("reaps a terminal app and its DB ambassador", () => {
    const orphans = compute(
      [container("app-dead", "app-id"), container("app-db-dead", "ambassador-id")],
      [live("app-dead", "deleted")],
    );
    expect(orphans).toEqual([
      {
        name: "app-dead",
        id: "app-id",
        key: "app-dead",
        reason: "terminal_db_row",
      },
      {
        name: "app-db-dead",
        id: "ambassador-id",
        key: "app-dead",
        reason: "terminal_db_row",
      },
    ]);
  });

  test("does NOT reap deploying, building, pending, or cleanup-required rows", () => {
    for (const status of ["deploying", "building", "pending", "cleanup_required"]) {
      const orphans = compute([container("app-x", "cx")], [live("app-x", status)]);
      expect(orphans).toEqual([]);
    }
  });

  test("does NOT reap a row in 'deleting' (delete job owns teardown)", () => {
    const orphans = compute([container("app-deleting", "c4")], [live("app-deleting", "deleting")]);
    expect(orphans).toEqual([]);
  });

  test("ignores containers that do not match the app- pattern", () => {
    const orphans = compute(
      [container("postgres", "p1"), container("agent-abc", "a1"), container("redis", "r1")],
      [],
    );
    expect(orphans).toEqual([]);
  });

  test("mixed fleet: reaps only the orphans, leaves live + non-app alone", () => {
    const orphans = compute(
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

  // REGRESSION (#9307): `containers.name` has NO unique constraint, so one
  // `app-<slug>` name maps to MANY rows (one per deploy) — routinely a mix like
  // `[running, stopped]`. Collapsing to a single status per name (last-write-wins
  // over an unordered `WHERE name IN (...)`) could pick the terminal row and
  // `docker rm -f` a LIVE customer app. The diff must be FAIL-SAFE: if ANY row
  // for a name is non-terminal, the live container is NEVER reaped — and the
  // outcome must not depend on row order (no ORDER BY in the query).
  test("does NOT reap a name with a running AND a stopped row — running order", () => {
    const orphans = compute(
      [container("app-dup", "c-live")],
      [live("app-dup", "running"), live("app-dup", "stopped")],
    );
    expect(orphans).toEqual([]);
  });

  test("does NOT reap a name with a stopped AND a running row — reversed order", () => {
    // Same rows, opposite iteration order: a last-write-wins map would collapse
    // to 'running' here and to 'stopped' above, making reaping order-dependent.
    const orphans = compute(
      [container("app-dup", "c-live")],
      [live("app-dup", "stopped"), live("app-dup", "running")],
    );
    expect(orphans).toEqual([]);
  });

  test("does NOT reap when ANY of several rows is non-terminal (running last)", () => {
    const orphans = compute(
      [container("app-dup", "c-live")],
      [
        live("app-dup", "failed"),
        live("app-dup", "stopped"),
        live("app-dup", "deleted"),
        live("app-dup", "running"),
      ],
    );
    expect(orphans).toEqual([]);
  });

  test("reaps a name when EVERY row is terminal (multiple terminal rows)", () => {
    const orphans = compute(
      [container("app-dead", "c-dead")],
      [live("app-dead", "stopped"), live("app-dead", "failed"), live("app-dead", "deleted")],
    );
    expect(orphans).toEqual([
      { name: "app-dead", id: "c-dead", key: "app-dead", reason: "terminal_db_row" },
    ]);
  });

  test("reaps a name with NO rows as no_db_row", () => {
    const orphans = compute([container("app-gone", "c-gone")], []);
    expect(orphans).toEqual([
      { name: "app-gone", id: "c-gone", key: "app-gone", reason: "no_db_row" },
    ]);
  });
});

describe("reconcileOrphanContainers (app orchestration)", () => {
  function makeConfig(
    loadStatuses: OrphanReconcilerConfig["loadStatuses"],
  ): OrphanReconcilerConfig {
    return {
      prefix: "app-",
      keyOf: APP_DIFF.keyOf,
      terminalStatuses: APP_DIFF.terminalStatuses,
      loadStatuses,
      logScope: "app-orphan-reconciler",
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

  test("force-removes every orphan on a healthy node — BY ID, not name", async () => {
    const removeContainer = mock(async () => {});
    const node = makeNode({
      listContainers: mock(async () => [
        { name: "app-orphan", id: "c-orph" },
        { name: "app-live", id: "c-live" },
      ]),
      removeContainer,
    });
    const loadLive = mock(async () => [{ key: "app-live", status: "running" }]);

    const result = await reconcileOrphanContainers([node], makeConfig(loadLive));

    expect(removeContainer).toHaveBeenCalledTimes(1);
    // reap-by-id invariant: the rm target is the immutable container id, NOT the name.
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
        { name: "app-a", id: "ca" },
        { name: "app-b", id: "cb" },
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

  test("does not query the DB when a node has no app- containers", async () => {
    const loadLive = mock(async () => [] as LiveContainerRef[]);
    const node = makeNode({ listContainers: mock(async () => [{ name: "agent-foo", id: "a" }]) });

    await reconcileOrphanContainers([node], makeConfig(loadLive));

    expect(loadLive).not.toHaveBeenCalled();
  });
});
