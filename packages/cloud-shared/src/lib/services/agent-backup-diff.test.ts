import { describe, expect, test } from "vitest";
import type { AgentBackupStateData } from "../../db/schemas/agent-sandboxes";
import {
  applyBackupDelta,
  type BackupChainNode,
  computeStateHash,
  diffBackupState,
  emptyBackupState,
  estimateDeltaBytes,
  estimateStateBytes,
  incrementalChainDepth,
  isEmptyDelta,
  planIncrementalBackup,
  reconstructFromChain,
  resolveBackupChain,
  selectPrunableBackupIds,
} from "./agent-backup-diff";

function state(overrides: Partial<AgentBackupStateData> = {}): AgentBackupStateData {
  return {
    memories: overrides.memories ?? [],
    config: overrides.config ?? {},
    workspaceFiles: overrides.workspaceFiles ?? {},
  };
}

const mem = (text: string, timestamp: number, role = "user") => ({ role, text, timestamp });

describe("diffBackupState / applyBackupDelta round-trip", () => {
  const cases: Array<{ name: string; base: AgentBackupStateData; next: AgentBackupStateData }> = [
    { name: "identity", base: emptyBackupState(), next: emptyBackupState() },
    {
      name: "file added",
      base: state({ workspaceFiles: { "a.txt": "1" } }),
      next: state({ workspaceFiles: { "a.txt": "1", "b.txt": "2" } }),
    },
    {
      name: "file changed",
      base: state({ workspaceFiles: { "a.txt": "1" } }),
      next: state({ workspaceFiles: { "a.txt": "changed" } }),
    },
    {
      name: "file removed",
      base: state({ workspaceFiles: { "a.txt": "1", "b.txt": "2" } }),
      next: state({ workspaceFiles: { "a.txt": "1" } }),
    },
    {
      name: "config added/changed/removed",
      base: state({ config: { keep: 1, change: "old", drop: true } }),
      next: state({ config: { keep: 1, change: "new", add: [1, 2] } }),
    },
    {
      name: "nested config value change",
      base: state({ config: { nested: { a: 1, b: 2 } } }),
      next: state({ config: { nested: { a: 1, b: 3 } } }),
    },
    {
      name: "memory append",
      base: state({ memories: [mem("hi", 1)] }),
      next: state({ memories: [mem("hi", 1), mem("there", 2, "assistant")] }),
    },
    {
      name: "memory rebase (prefix diverged)",
      base: state({ memories: [mem("a", 1), mem("b", 2)] }),
      next: state({ memories: [mem("a", 1), mem("B-rewritten", 2), mem("c", 3)] }),
    },
    {
      name: "memory truncation",
      base: state({ memories: [mem("a", 1), mem("b", 2), mem("c", 3)] }),
      next: state({ memories: [mem("a", 1)] }),
    },
    {
      name: "everything at once",
      base: state({
        memories: [mem("a", 1)],
        config: { x: 1, gone: 2 },
        workspaceFiles: { "keep.ts": "k", "old.ts": "o" },
      }),
      next: state({
        memories: [mem("a", 1), mem("b", 2)],
        config: { x: 2, fresh: true },
        workspaceFiles: { "keep.ts": "k", "new.ts": "n" },
      }),
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const delta = diffBackupState(c.base, c.next);
      expect(applyBackupDelta(c.base, delta)).toEqual(c.next);
    });
  }
});

describe("diff structure", () => {
  test("append uses base count + tail, not a rebase", () => {
    const base = state({ memories: [mem("a", 1), mem("b", 2)] });
    const next = state({ memories: [mem("a", 1), mem("b", 2), mem("c", 3)] });
    const delta = diffBackupState(base, next);
    expect(delta.memoriesBaseCount).toBe(2);
    expect(delta.memoriesAppended).toEqual([mem("c", 3)]);
  });

  test("rebase carries full log with base count 0", () => {
    const base = state({ memories: [mem("a", 1), mem("b", 2)] });
    const next = state({ memories: [mem("z", 9)] });
    const delta = diffBackupState(base, next);
    expect(delta.memoriesBaseCount).toBe(0);
    expect(delta.memoriesAppended).toEqual([mem("z", 9)]);
  });

  test("identity diff is empty", () => {
    const s = state({ config: { a: 1 }, workspaceFiles: { "f": "x" }, memories: [mem("a", 1)] });
    expect(isEmptyDelta(diffBackupState(s, s))).toBe(true);
  });

  test("key insertion order does not produce a spurious config diff", () => {
    const base = state({ config: { a: 1, b: 2 } });
    const next = state({ config: { b: 2, a: 1 } });
    expect(isEmptyDelta(diffBackupState(base, next))).toBe(true);
  });
});

describe("reconstructFromChain", () => {
  test("replays a base full backup + N incrementals exactly", () => {
    const v0 = state({ workspaceFiles: { "main.ts": "v0" }, config: { ver: 0 }, memories: [] });
    const v1 = state({
      workspaceFiles: { "main.ts": "v1", "added.ts": "x" },
      config: { ver: 1 },
      memories: [mem("first", 1)],
    });
    const v2 = state({
      workspaceFiles: { "main.ts": "v1", "added.ts": "x" },
      config: { ver: 2, flag: true },
      memories: [mem("first", 1), mem("second", 2)],
    });
    const v3 = state({
      workspaceFiles: { "main.ts": "v3" }, // added.ts removed
      config: { ver: 2, flag: true },
      memories: [mem("first", 1), mem("second", 2), mem("third", 3)],
    });

    const deltas = [diffBackupState(v0, v1), diffBackupState(v1, v2), diffBackupState(v2, v3)];
    expect(reconstructFromChain(v0, deltas)).toEqual(v3);
    // Partial chains reconstruct intermediate versions too.
    expect(reconstructFromChain(v0, deltas.slice(0, 1))).toEqual(v1);
    expect(reconstructFromChain(v0, deltas.slice(0, 2))).toEqual(v2);
  });

  test("empty chain returns the base", () => {
    const base = state({ config: { a: 1 } });
    expect(reconstructFromChain(base, [])).toEqual(base);
  });
});

describe("computeStateHash", () => {
  test("is stable across key ordering", () => {
    const a = state({ config: { a: 1, b: { c: 2, d: 3 } } });
    const b = state({ config: { b: { d: 3, c: 2 }, a: 1 } });
    expect(computeStateHash(a)).toBe(computeStateHash(b));
  });

  test("changes when content changes", () => {
    const a = state({ workspaceFiles: { "f": "1" } });
    const b = state({ workspaceFiles: { "f": "2" } });
    expect(computeStateHash(a)).not.toBe(computeStateHash(b));
  });
});

describe("planIncrementalBackup", () => {
  test("chooses incremental for a tiny change on a large base", () => {
    const big = "x".repeat(50_000);
    const base = state({ workspaceFiles: { "big.bin": big } });
    const next = state({ workspaceFiles: { "big.bin": big, "note.txt": "hi" } });
    const plan = planIncrementalBackup({ base, next, chainDepth: 1 });
    expect(plan.kind).toBe("incremental");
    if (plan.kind === "incremental") {
      expect(estimateDeltaBytes(plan.delta)).toBeLessThan(estimateStateBytes(next));
    }
  });

  test("chooses full when the change rewrites most of the state", () => {
    const base = state({ workspaceFiles: { "a": "x".repeat(1000) } });
    const next = state({ workspaceFiles: { "a": "y".repeat(1000), "b": "z".repeat(1000) } });
    expect(planIncrementalBackup({ base, next, chainDepth: 1 }).kind).toBe("full");
  });

  test("forces full once the chain is too deep", () => {
    const base = state({ workspaceFiles: { "a": "1" } });
    const next = state({ workspaceFiles: { "a": "1", "b": "2" } });
    expect(planIncrementalBackup({ base, next, chainDepth: 20, maxChainDepth: 20 }).kind).toBe(
      "full",
    );
  });
});

describe("backup chains", () => {
  // full(f0) <- inc(i1) <- inc(i2) ; plus a newer standalone full(f3)
  const nodes: BackupChainNode[] = [
    { id: "f0", backupKind: "full", parentBackupId: null, createdAtMs: 100 },
    { id: "i1", backupKind: "incremental", parentBackupId: "f0", createdAtMs: 200 },
    { id: "i2", backupKind: "incremental", parentBackupId: "i1", createdAtMs: 300 },
    { id: "f3", backupKind: "full", parentBackupId: null, createdAtMs: 400 },
  ];

  test("resolveBackupChain returns base→target oldest-first", () => {
    expect(resolveBackupChain(nodes, "i2")).toEqual(["f0", "i1", "i2"]);
    expect(resolveBackupChain(nodes, "f3")).toEqual(["f3"]);
    expect(resolveBackupChain(nodes, "f0")).toEqual(["f0"]);
  });

  test("incrementalChainDepth counts incrementals above the base", () => {
    expect(incrementalChainDepth(nodes, "i2")).toBe(2);
    expect(incrementalChainDepth(nodes, "f3")).toBe(0);
  });

  test("resolveBackupChain throws on a broken chain", () => {
    const broken: BackupChainNode[] = [
      { id: "x", backupKind: "incremental", parentBackupId: "missing", createdAtMs: 1 },
    ];
    expect(() => resolveBackupChain(broken, "x")).toThrow(/missing/);
  });

  test("resolveBackupChain throws on a cycle", () => {
    const cyclic: BackupChainNode[] = [
      { id: "a", backupKind: "incremental", parentBackupId: "b", createdAtMs: 1 },
      { id: "b", backupKind: "incremental", parentBackupId: "a", createdAtMs: 2 },
    ];
    expect(() => resolveBackupChain(cyclic, "a")).toThrow(/cycle/);
  });

  test("selectPrunableBackupIds keeps ancestors of a retained incremental", () => {
    // Chain-only set: f0 <- i1 <- i2. keep=1 retains the newest (i2), which
    // needs i1 + f0, so nothing is prunable even though keep=1.
    const chain: BackupChainNode[] = [
      { id: "f0", backupKind: "full", parentBackupId: null, createdAtMs: 100 },
      { id: "i1", backupKind: "incremental", parentBackupId: "f0", createdAtMs: 200 },
      { id: "i2", backupKind: "incremental", parentBackupId: "i1", createdAtMs: 300 },
    ];
    expect(selectPrunableBackupIds(chain, 1)).toEqual([]);
  });

  test("selectPrunableBackupIds prunes an old standalone full a retained chain doesn't need", () => {
    // f3 is the newest restore point; the i2/i1/f0 chain is independent of it.
    const prunable = selectPrunableBackupIds(nodes, 1).sort();
    expect(prunable).toEqual(["f0", "i1", "i2"]);
  });

  test("selectPrunableBackupIds never strands an incremental's base", () => {
    // keep=2: newest two are f3(400), i2(300). i2 needs i1 + f0 → all kept.
    const prunable = selectPrunableBackupIds(nodes, 2);
    expect(prunable).toEqual([]);
  });

  test("selectPrunableBackupIds returns nothing when under the keep count", () => {
    expect(selectPrunableBackupIds(nodes, 10)).toEqual([]);
  });
});
