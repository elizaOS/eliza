/**
 * Tests for the SHARED orphan-container reconciler — the single implementation
 * behind both the agent (`docker-node-workloads.ts`) and app
 * (`app-container-orphan-reconciler.ts`) paths.
 *
 * The per-path suites cover each path's wiring; this suite proves the shared
 * diff handles BOTH key modes correctly:
 *
 *   1. UNIQUE keys (agents): `agent_sandboxes.id` is a PRIMARY KEY, so each key
 *      maps to at most ONE row. The group-by-key `every-terminal` fold then
 *      reduces to a plain single-status check — identical to the previous
 *      per-agent last-write-wins `Map<id,status>`. This is the behavior-
 *      preservation proof: same inputs → same reaping decisions.
 *
 *   2. DUPLICATE keys (apps): `containers.name` has NO unique constraint, so one
 *      key maps to MANY rows. The #9307 fail-safe protects a live container that
 *      shares a key with stale terminal rows — a key is reaped ONLY when EVERY
 *      row is terminal, order-independently.
 */

import { describe, expect, test } from "bun:test";
import {
  computeOrphanContainersToReap,
  type LiveContainerRef,
  type NodeContainerRef,
  type OrphanReconcilerConfig,
} from "./orphan-container-reconciler";

const container = (name: string, id: string): NodeContainerRef => ({ name, id });
const live = (key: string, status: string): LiveContainerRef => ({ key, status });

describe("shared diff — UNIQUE-key mode (agent, group-by-key ≡ last-write-wins)", () => {
  // keyOf parses the id out of `k-<id>`; terminal vocab is arbitrary here.
  const diff: Pick<OrphanReconcilerConfig, "keyOf" | "terminalStatuses"> = {
    keyOf: (name) => (name.startsWith("k-") && name.length > 2 ? name.slice(2) : null),
    terminalStatuses: new Set(["stopped", "error"]),
  };

  // For a UNIQUE key there is at most one status. `every(terminal)` over a
  // singleton list `[s]` is exactly `terminal.has(s)`, and a missing key is
  // `no_db_row` either way. So for every single-row input the group-by-key fold
  // produces the SAME decision the old last-write-wins map would. We assert that
  // equivalence directly over the full decision table.
  const singleStatusReference = (status: string | undefined) => {
    if (status === undefined) return "no_db_row";
    return diff.terminalStatuses.has(status) ? "terminal_db_row" : null;
  };

  for (const status of [undefined, "running", "stopped", "error", "pending"] as const) {
    test(`status=${String(status)} → matches single-status check`, () => {
      const rows = status === undefined ? [] : [live("id1", status)];
      const orphans = computeOrphanContainersToReap([container("k-id1", "c1")], rows, diff);
      const expected = singleStatusReference(status);
      if (expected === null) {
        expect(orphans).toEqual([]);
      } else {
        expect(orphans).toEqual([{ name: "k-id1", id: "c1", key: "id1", reason: expected }]);
      }
    });
  }

  test("distinct unique keys are decided independently", () => {
    const orphans = computeOrphanContainersToReap(
      [container("k-a", "ca"), container("k-b", "cb"), container("k-c", "cc")],
      [live("a", "running"), live("b", "stopped")],
      diff,
    );
    // a=running → keep; b=stopped → reap; c=missing → reap.
    expect(orphans.map((o) => `${o.key}:${o.reason}`).sort()).toEqual([
      "b:terminal_db_row",
      "c:no_db_row",
    ]);
  });
});

describe("shared diff — DUPLICATE-key mode (app, #9307 every-terminal fail-safe)", () => {
  // keyOf is identity (the name IS the key), matching the app path.
  const diff: Pick<OrphanReconcilerConfig, "keyOf" | "terminalStatuses"> = {
    keyOf: (name) => (name.startsWith("app-") && name.length > 4 ? name : null),
    terminalStatuses: new Set(["stopped", "failed", "deleted"]),
  };

  test("ANY non-terminal row among duplicates protects the key (both orders)", () => {
    expect(
      computeOrphanContainersToReap(
        [container("app-dup", "c")],
        [live("app-dup", "running"), live("app-dup", "stopped")],
        diff,
      ),
    ).toEqual([]);
    expect(
      computeOrphanContainersToReap(
        [container("app-dup", "c")],
        [live("app-dup", "stopped"), live("app-dup", "running")],
        diff,
      ),
    ).toEqual([]);
  });

  test("reaps only when EVERY duplicate row is terminal", () => {
    const orphans = computeOrphanContainersToReap(
      [container("app-dead", "c")],
      [live("app-dead", "stopped"), live("app-dead", "failed"), live("app-dead", "deleted")],
      diff,
    );
    expect(orphans).toEqual([
      { name: "app-dead", id: "c", key: "app-dead", reason: "terminal_db_row" },
    ]);
  });
});

describe("node-aware diff (#15228 — reap the stale twin a re-provision left behind)", () => {
  // Agent config: node-aware, 5-min grace. keyOf parses `agent-<id>`.
  const cfg: Pick<
    OrphanReconcilerConfig,
    "keyOf" | "terminalStatuses" | "nodeAware" | "nodeMoveGraceMs"
  > = {
    keyOf: (name) => (name.startsWith("agent-") ? name.slice("agent-".length) : null),
    terminalStatuses: new Set(["stopped", "error"]),
    nodeAware: true,
    nodeMoveGraceMs: 5 * 60_000,
  };
  const NOW = 1_000_000_000_000;
  const onNode = (
    key: string,
    status: string,
    nodeId: string,
    ageMs: number,
  ): LiveContainerRef => ({
    key,
    status,
    nodeId,
    updatedAtMs: NOW - ageMs,
  });
  const c = (id: string): NodeContainerRef => ({ name: `agent-${id}`, id: `docker-${id}` });

  test("live row points at a DIFFERENT node, stable past grace → reap as wrong_node", () => {
    // container observed on nodeA; the agent's live row says it lives on nodeB.
    const orphans = computeOrphanContainersToReap(
      [c("x")],
      [onNode("x", "running", "nodeB", 10 * 60_000)],
      cfg,
      "nodeA",
      NOW,
    );
    expect(orphans).toEqual([{ name: "agent-x", id: "docker-x", key: "x", reason: "wrong_node" }]);
  });

  test("live row points at THIS node → keep (this is the canonical container)", () => {
    const orphans = computeOrphanContainersToReap(
      [c("x")],
      [onNode("x", "running", "nodeA", 10 * 60_000)],
      cfg,
      "nodeA",
      NOW,
    );
    expect(orphans).toEqual([]);
  });

  test("mismatch but WITHIN grace → keep (protects the mid-provision race)", () => {
    // row just moved to nodeB 30s ago; a container still on nodeA might be the
    // draining old one OR a race — do not reap until it is stably wrong.
    const orphans = computeOrphanContainersToReap(
      [c("x")],
      [onNode("x", "running", "nodeB", 30_000)],
      cfg,
      "nodeA",
      NOW,
    );
    expect(orphans).toEqual([]);
  });

  test("row missing nodeId → cannot prove elsewhere → keep", () => {
    const orphans = computeOrphanContainersToReap(
      [c("x")],
      [{ key: "x", status: "running" }],
      cfg,
      "nodeA",
      NOW,
    );
    expect(orphans).toEqual([]);
  });

  test("terminal row still wins over node logic (reap as terminal_db_row)", () => {
    const orphans = computeOrphanContainersToReap(
      [c("x")],
      [onNode("x", "error", "nodeB", 10 * 60_000)],
      cfg,
      "nodeA",
      NOW,
    );
    expect(orphans[0]?.reason).toBe("terminal_db_row");
  });

  test("no nodeId arg (non-node-aware call) → node logic inert, legacy behavior", () => {
    const orphans = computeOrphanContainersToReap(
      [c("x")],
      [onNode("x", "running", "nodeB", 10 * 60_000)],
      cfg,
      undefined,
      NOW,
    );
    expect(orphans).toEqual([]);
  });

  test("nodeAware off → a wrong-node container is NEVER reaped (apps semantics)", () => {
    const appsCfg = { ...cfg, nodeAware: false };
    const orphans = computeOrphanContainersToReap(
      [c("x")],
      [onNode("x", "running", "nodeB", 10 * 60_000)],
      appsCfg,
      "nodeA",
      NOW,
    );
    expect(orphans).toEqual([]);
  });
});
