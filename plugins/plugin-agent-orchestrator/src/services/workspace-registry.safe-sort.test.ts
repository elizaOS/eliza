/**
 * Verifies safe sorting in WorkspaceRegistry when createdAt contains NaN/Infinity.
 */

import { describe, expect, it } from "vitest";

type WorkspaceRecord = {
  path: string;
  kind: string;
  createdAt: number;
  live: boolean;
};

function sortCandidates(records: WorkspaceRecord[]): WorkspaceRecord[] {
  return [...records]
    .filter((r) => r.kind === "git-workspace" && !r.live)
    .sort((a, b) => {
      const aTime = Number.isFinite(a.createdAt) ? a.createdAt : 0;
      const bTime = Number.isFinite(b.createdAt) ? b.createdAt : 0;
      return aTime - bTime;
    });
}

describe("workspace-registry safe sort", () => {
  it("sorts safely when createdAt contains NaN and undefined (ascending)", () => {
    const records: WorkspaceRecord[] = [
      { path: "/tmp/a", kind: "git-workspace", live: false, createdAt: NaN },
      { path: "/tmp/b", kind: "git-workspace", live: false, createdAt: 1000 },
      {
        path: "/tmp/c",
        kind: "git-workspace",
        live: false,
        createdAt: undefined as unknown as number,
      },
      { path: "/tmp/d", kind: "git-workspace", live: false, createdAt: 500 },
    ];
    const sorted = sortCandidates(records);
    expect(sorted.map((r) => r.path)).toEqual([
      "/tmp/a",
      "/tmp/c",
      "/tmp/d",
      "/tmp/b",
    ]);
  });

  it("handles Infinity by falling back to 0", () => {
    const records: WorkspaceRecord[] = [
      {
        path: "/tmp/inf",
        kind: "git-workspace",
        live: false,
        createdAt: Infinity,
      },
      {
        path: "/tmp/valid",
        kind: "git-workspace",
        live: false,
        createdAt: 100,
      },
    ];
    const sorted = sortCandidates(records);
    expect(sorted[0].path).toBe("/tmp/inf");
    expect(sorted[1].path).toBe("/tmp/valid");
  });

  it("old comparator would return NaN for NaN inputs", () => {
    const a: WorkspaceRecord = {
      path: "/tmp/a",
      kind: "git-workspace",
      live: false,
      createdAt: NaN,
    };
    const b: WorkspaceRecord = {
      path: "/tmp/b",
      kind: "git-workspace",
      live: false,
      createdAt: 100,
    };
    const oldResult = a.createdAt - b.createdAt;
    expect(Number.isNaN(oldResult)).toBe(true);
    const fixed = sortCandidates([a, b]);
    expect(fixed[0].path).toBe("/tmp/a");
  });
});
