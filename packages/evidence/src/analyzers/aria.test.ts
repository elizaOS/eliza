// tree.aria pure operations on handwritten Playwright ariaSnapshot YAML:
// normalize is order/whitespace-stable, diff surfaces structural add/remove/
// change, and prune drops by depth and role. The analyzer reads a captured
// snapshot file and reports node count + normalized form.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ariaTreeAnalyzer,
  diffAriaSnapshots,
  normalizeAriaSnapshot,
  parseAriaSnapshot,
  pruneAriaSnapshot,
} from "./aria.ts";
import { makeTmpDir } from "./test-fixtures.ts";
import type { AnalyzerContext } from "./types.ts";

const dir = makeTmpDir();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SNAPSHOT_A = `- main:
  - heading "Dashboard" [level=1]
  - list:
    - listitem "Chat"
    - listitem "Settings"
  - button "Sign out"`;

// Same UI, different incidental sibling ordering + trailing whitespace.
const SNAPSHOT_A_REORDERED = `- main:
  - button "Sign out"
  - list:
    - listitem "Settings"
    - listitem "Chat"
  - heading "Dashboard" [level=1]`;

// A real structural change: Settings item removed, a new banner added.
const SNAPSHOT_B = `- main:
  - banner "Beta"
  - heading "Dashboard" [level=1]
  - list:
    - listitem "Chat"
  - button "Sign out"`;

describe("parseAriaSnapshot", () => {
  it("parses roles, names, attributes, and nesting", () => {
    const tree = parseAriaSnapshot(SNAPSHOT_A);
    expect(tree).toHaveLength(1);
    expect(tree[0].role).toBe("main");
    const heading = tree[0].children[0];
    expect(heading.role).toBe("heading");
    expect(heading.name).toBe("Dashboard");
    expect(heading.attributes).toContain("[level=1]");
    const list = tree[0].children[1];
    expect(list.children.map((c) => c.name)).toEqual(["Chat", "Settings"]);
  });
});

describe("normalizeAriaSnapshot", () => {
  it("is stable across incidental reordering and whitespace", () => {
    expect(normalizeAriaSnapshot(SNAPSHOT_A)).toBe(
      normalizeAriaSnapshot(SNAPSHOT_A_REORDERED),
    );
  });
  it("differs for a genuinely different tree", () => {
    expect(normalizeAriaSnapshot(SNAPSHOT_A)).not.toBe(
      normalizeAriaSnapshot(SNAPSHOT_B),
    );
  });
});

describe("diffAriaSnapshots", () => {
  it("reports the removed listitem and the added banner", () => {
    const diffs = diffAriaSnapshots(SNAPSHOT_A, SNAPSHOT_B);
    const kinds = diffs.map((d) => d.kind);
    expect(kinds).toContain("added");
    expect(kinds).toContain("removed");
    expect(diffs.some((d) => d.detail.includes("Settings"))).toBe(true);
    expect(diffs.some((d) => d.detail.includes("Beta"))).toBe(true);
  });
  it("reports no diff for the same tree", () => {
    expect(diffAriaSnapshots(SNAPSHOT_A, SNAPSHOT_A)).toEqual([]);
  });
});

describe("pruneAriaSnapshot", () => {
  it("cuts below maxDepth", () => {
    const pruned = pruneAriaSnapshot(SNAPSHOT_A, { maxDepth: 1 });
    // The list's children (depth 2) are cut; the list itself (depth 1) remains.
    expect(pruned).toContain("list");
    expect(pruned).not.toContain("Chat");
  });
  it("drops nodes by role", () => {
    const pruned = pruneAriaSnapshot(SNAPSHOT_A, { dropRoles: ["button"] });
    expect(pruned).not.toContain("Sign out");
    expect(pruned).toContain("heading");
  });
});

describe("ariaTreeAnalyzer", () => {
  it("reads a snapshot file and reports node count + normalized form", async () => {
    const file = join(dir, "tree.yaml");
    writeFileSync(file, SNAPSHOT_A);
    const ctx: AnalyzerContext = { tier: "cpu" };
    const result = await ariaTreeAnalyzer.analyze(
      {
        entry: {
          path: "html-trees/dashboard.yaml",
          sha256: "0".repeat(64),
          bytes: 0,
          kind: "html-tree",
          source: "test",
          producedBy: "test",
          createdAt: new Date().toISOString(),
        },
        absolutePath: file,
      },
      ctx,
    );
    expect(result.status).toBe("ran");
    if (result.status !== "ran") return;
    const data = result.data as { nodes: number; normalized: string };
    // main + heading + list + 2 listitems + button = 6.
    expect(data.nodes).toBe(6);
    expect(data.normalized).toBe(normalizeAriaSnapshot(SNAPSHOT_A));
  });
});
