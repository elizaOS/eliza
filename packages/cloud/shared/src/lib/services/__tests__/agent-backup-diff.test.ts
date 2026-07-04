// Exercises agent backup diff behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import type { AgentBackupStateData } from "../../../db/schemas/agent-sandboxes";
import {
  applyBackupDelta,
  type BackupChainNode,
  computeStateHash,
  diffBackupState,
  emptyBackupState,
  isEmptyDelta,
  reconstructFromChain,
  resolveBackupChain,
} from "../agent-backup-diff";

type Mem = AgentBackupStateData["memories"][number];
const mem = (id: string): Mem => ({ id }) as unknown as Mem;

function state(over: Partial<AgentBackupStateData> = {}): AgentBackupStateData {
  return { memories: [], config: {}, workspaceFiles: {}, ...over };
}

// The module's own doc promises this invariant "is the invariant the unit tests
// pin" — but none existed. Pin it. (#8434 launch-readiness: backup correctness.)
describe("agent-backup-diff round-trip invariant", () => {
  const cases: Array<[string, AgentBackupStateData, AgentBackupStateData]> = [
    ["empty → empty", emptyBackupState(), emptyBackupState()],
    [
      "empty → populated",
      emptyBackupState(),
      state({
        memories: [mem("a"), mem("b")],
        config: { k: 1 },
        workspaceFiles: { "f.txt": "hi" },
      }),
    ],
    [
      "files + config changed/removed",
      state({
        config: { a: 1, b: 2 },
        workspaceFiles: { x: "1", y: "2" },
      }),
      state({
        config: { a: 9, c: 3 },
        workspaceFiles: { x: "1!", z: "3" },
      }),
    ],
    [
      "memory append (common case)",
      state({ memories: [mem("a"), mem("b")] }),
      state({ memories: [mem("a"), mem("b"), mem("c")] }),
    ],
    [
      "memory rebase (prefix diverges)",
      state({ memories: [mem("a"), mem("b")] }),
      state({ memories: [mem("z")] }),
    ],
  ];

  for (const [name, base, next] of cases) {
    test(`apply(base, diff(base, next)) deep-equals next: ${name}`, () => {
      expect(applyBackupDelta(base, diffBackupState(base, next))).toEqual(next);
    });
  }
});

describe("agent-backup-diff helpers", () => {
  test("computeStateHash is key-order independent + content-sensitive", () => {
    expect(computeStateHash(state({ config: { x: 1, y: 2 } }))).toBe(
      computeStateHash(state({ config: { y: 2, x: 1 } })),
    );
    expect(computeStateHash(state({ config: { x: 1 } }))).not.toBe(
      computeStateHash(state({ config: { x: 2 } })),
    );
  });

  test("isEmptyDelta is true only for a no-op delta", () => {
    expect(isEmptyDelta(diffBackupState(emptyBackupState(), emptyBackupState()))).toBe(true);
    expect(isEmptyDelta(diffBackupState(emptyBackupState(), state({ config: { k: 1 } })))).toBe(
      false,
    );
  });

  test("emptyBackupState returns a fresh, non-shared object", () => {
    expect(emptyBackupState()).not.toBe(emptyBackupState());
    expect(emptyBackupState()).toEqual({
      memories: [],
      config: {},
      workspaceFiles: {},
    });
  });
});

describe("agent-backup-diff chain reconstruction (restore path)", () => {
  test("reconstructFromChain replays deltas to restore the final state", () => {
    const base = emptyBackupState();
    const s1 = state({ config: { a: 1 }, memories: [mem("x")] });
    const s2 = state({
      config: { a: 1, b: 2 },
      memories: [mem("x"), mem("y")],
      workspaceFiles: { "f.txt": "v" },
    });
    const deltas = [diffBackupState(base, s1), diffBackupState(s1, s2)];
    expect(reconstructFromChain(base, deltas)).toEqual(s2);
  });

  test("resolveBackupChain walks parents from the full backup to the target", () => {
    const nodes: BackupChainNode[] = [
      { id: "full", backupKind: "full", parentBackupId: null, createdAtMs: 1 },
      {
        id: "inc1",
        backupKind: "incremental",
        parentBackupId: "full",
        createdAtMs: 2,
      },
      {
        id: "inc2",
        backupKind: "incremental",
        parentBackupId: "inc1",
        createdAtMs: 3,
      },
    ];
    expect(resolveBackupChain(nodes, "inc2")).toEqual(["full", "inc1", "inc2"]);
    expect(resolveBackupChain(nodes, "full")).toEqual(["full"]);
  });

  test("resolveBackupChain throws on a broken chain (missing parent)", () => {
    const nodes: BackupChainNode[] = [
      {
        id: "inc1",
        backupKind: "incremental",
        parentBackupId: "missing",
        createdAtMs: 2,
      },
    ];
    expect(() => resolveBackupChain(nodes, "inc1")).toThrow();
  });
});
