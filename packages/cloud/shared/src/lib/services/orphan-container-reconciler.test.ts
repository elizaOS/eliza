/**
 * Covers Docker-list parsing and fail-closed ownership classification shared
 * by the agent and app orphan reconcilers.
 */

import { describe, expect, test } from "bun:test";
import {
  classifyContainersForReconciliation,
  computeOrphanContainersToReap,
  type LiveContainerRef,
  type NodeContainerRef,
  type OrphanReconcilerConfig,
  parseNodeContainerList,
} from "./orphan-container-reconciler";

const AGED_NOW_MS = 10 * 60_000;
const container = (name: string, id: string): NodeContainerRef => ({
  name,
  id,
  createdAtMs: 0,
});
const live = (key: string, status: string): LiveContainerRef => ({ key, status });

describe("parseNodeContainerList", () => {
  test("parses Docker timestamps by their numeric offsets", () => {
    const output = [
      "agent-utc|id-utc|2026-07-07 16:45:01 +0000 UTC",
      "agent-pacific|id-pacific|2026-07-07 09:45:01 -0700 PDT",
      "agent-india|id-india|2026-07-07 22:15:01.250 +0530 IST",
    ].join("\n");

    expect(parseNodeContainerList(output, "agent-")).toEqual([
      {
        name: "agent-utc",
        id: "id-utc",
        createdAtMs: Date.UTC(2026, 6, 7, 16, 45, 1),
      },
      {
        name: "agent-pacific",
        id: "id-pacific",
        createdAtMs: Date.UTC(2026, 6, 7, 16, 45, 1),
      },
      {
        name: "agent-india",
        id: "id-india",
        createdAtMs: Date.UTC(2026, 6, 7, 16, 45, 1, 250),
      },
    ]);
  });

  test("retains an entry without age when Docker emits an invalid timestamp", () => {
    expect(
      parseNodeContainerList("agent-live|id-live|2026-02-30 10:00:00 +0000 UTC", "agent-"),
    ).toEqual([{ name: "agent-live", id: "id-live" }]);
  });

  test("rejects substring matches and malformed listing rows", () => {
    const output = [
      "my-agent-live|wrong-prefix|2026-07-07 16:45:01 +0000 UTC",
      "agent-no-id||2026-07-07 16:45:01 +0000 UTC",
      "agent-extra|id-extra|2026-07-07 16:45:01 +0000 UTC|extra",
      "",
    ].join("\n");

    expect(parseNodeContainerList(output, "agent-")).toEqual([]);
  });
});

describe("shared diff with unique agent keys", () => {
  const diff: Pick<OrphanReconcilerConfig, "keyOf" | "terminalStatuses"> = {
    keyOf: (name) => (name.startsWith("k-") && name.length > 2 ? name.slice(2) : null),
    terminalStatuses: new Set(["stopped", "error"]),
  };

  const singleStatusReference = (status: string | undefined) => {
    if (status === undefined) return "no_db_row";
    return diff.terminalStatuses.has(status) ? "terminal_db_row" : null;
  };

  for (const status of [undefined, "running", "stopped", "error", "pending"] as const) {
    test(`status=${String(status)} → matches single-status check`, () => {
      const rows = status === undefined ? [] : [live("id1", status)];
      const orphans = computeOrphanContainersToReap(
        [container("k-id1", "c1")],
        rows,
        diff,
        undefined,
        AGED_NOW_MS,
      );
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
      undefined,
      AGED_NOW_MS,
    );
    expect(orphans.map((o) => `${o.key}:${o.reason}`).sort()).toEqual([
      "b:terminal_db_row",
      "c:no_db_row",
    ]);
  });
});

describe("shared diff with duplicate app keys", () => {
  const diff: Pick<OrphanReconcilerConfig, "keyOf" | "terminalStatuses"> = {
    keyOf: (name) => (name.startsWith("app-") && name.length > 4 ? name : null),
    terminalStatuses: new Set(["stopped", "failed", "deleted"]),
  };

  test("a non-terminal row among duplicates protects the key in either order", () => {
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

  test("reaps only when every duplicate row is terminal", () => {
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

describe("retention decision reasons", () => {
  const diff: Pick<OrphanReconcilerConfig, "keyOf" | "terminalStatuses"> = {
    keyOf: (name) => (name.startsWith("agent-") ? name.slice("agent-".length) : null),
    terminalStatuses: new Set(["stopped"]),
  };

  test("distinguishes unknown age, grace, live ownership, and unmanaged names", () => {
    const decisions = classifyContainersForReconciliation(
      [
        { name: "agent-unknown", id: "unknown" },
        { name: "agent-young", id: "young", createdAtMs: AGED_NOW_MS - 1_000 },
        container("agent-live", "live"),
        container("postgres", "postgres"),
      ],
      [live("live", "running")],
      diff,
      undefined,
      AGED_NOW_MS,
    );

    expect(decisions.map(({ id, action, reason }) => ({ id, action, reason }))).toEqual([
      { id: "unknown", action: "retain", reason: "no_db_row_age_unknown" },
      { id: "young", action: "retain", reason: "no_db_row_within_grace" },
      { id: "live", action: "retain", reason: "live_db_row" },
      { id: "postgres", action: "retain", reason: "unmanaged_name" },
    ]);
  });
});

describe("node-aware stale-twin classification", () => {
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
  const c = (id: string, containerAgeMs = 60 * 60_000): NodeContainerRef => ({
    name: `agent-${id}`,
    id: `docker-${id}`,
    createdAtMs: NOW - containerAgeMs,
  });

  test("reaps a stable container whose live row points at a different node", () => {
    const orphans = computeOrphanContainersToReap(
      [c("x")],
      [onNode("x", "running", "nodeB", 10 * 60_000)],
      cfg,
      "nodeA",
      NOW,
    );
    expect(orphans).toEqual([{ name: "agent-x", id: `docker-x`, key: "x", reason: "wrong_node" }]);
  });

  test("retains a fresh container while placement is in flight", () => {
    const orphans = computeOrphanContainersToReap(
      [c("x", 29_000)],
      [onNode("x", "running", "nodeB", 12 * 24 * 60 * 60_000)],
      cfg,
      "nodeA",
      NOW,
    );
    expect(orphans).toEqual([]);
  });

  test("retains a container with unknown age", () => {
    const orphans = computeOrphanContainersToReap(
      [{ name: "agent-x", id: "docker-x" }],
      [onNode("x", "running", "nodeB", 10 * 60_000)],
      cfg,
      "nodeA",
      NOW,
    );
    expect(orphans).toEqual([]);
  });

  test("retains the container on its canonical node", () => {
    const orphans = computeOrphanContainersToReap(
      [c("x")],
      [onNode("x", "running", "nodeA", 10 * 60_000)],
      cfg,
      "nodeA",
      NOW,
    );
    expect(orphans).toEqual([]);
  });

  test("retains a node mismatch within the row grace window", () => {
    const orphans = computeOrphanContainersToReap(
      [c("x")],
      [onNode("x", "running", "nodeB", 30_000)],
      cfg,
      "nodeA",
      NOW,
    );
    expect(orphans).toEqual([]);
  });

  test("retains a row whose placement evidence is incomplete", () => {
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

  test("retains when the caller omits node context", () => {
    const orphans = computeOrphanContainersToReap(
      [c("x")],
      [onNode("x", "running", "nodeB", 10 * 60_000)],
      cfg,
      undefined,
      NOW,
    );
    expect(orphans).toEqual([]);
  });

  test("retains a wrong-node container when node awareness is disabled", () => {
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
