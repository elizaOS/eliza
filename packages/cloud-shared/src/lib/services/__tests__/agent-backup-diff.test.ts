import { describe, expect, test } from "bun:test";
import type { AgentBackupStateData } from "../../../db/schemas/agent-sandboxes";
import {
  applyBackupDelta,
  computeStateHash,
  diffBackupState,
  emptyBackupState,
  isEmptyDelta,
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
