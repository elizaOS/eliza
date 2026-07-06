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

  it("parses a named container line (role + name + trailing colon)", () => {
    const tree = parseAriaSnapshot(
      `- navigation "Main":\n  - link "Home"\n  - link "Docs"`,
    );
    expect(tree).toHaveLength(1);
    expect(tree[0].role).toBe("navigation");
    expect(tree[0].name).toBe("Main");
    expect(tree[0].children.map((c) => c.name)).toEqual(["Home", "Docs"]);
  });

  it("parses a named container with attributes before the colon", () => {
    const tree = parseAriaSnapshot(
      `- list "Items" [ref=s1]:\n  - listitem "One"`,
    );
    expect(tree[0].role).toBe("list");
    expect(tree[0].name).toBe("Items");
    expect(tree[0].attributes).toEqual(["[ref=s1]"]);
    expect(tree[0].children).toHaveLength(1);
  });

  it("parses inline text leaves verbatim", () => {
    const tree = parseAriaSnapshot(`- text: Signed in as Ada [beta]`);
    expect(tree).toHaveLength(1);
    expect(tree[0].role).toBe("text");
    // Text content is raw: brackets/quotes inside it are not attributes.
    expect(tree[0].name).toBe("Signed in as Ada [beta]");
    expect(tree[0].attributes).toEqual([]);
  });

  it("wraps `role: inline content` as a text child, equal to the indented form", () => {
    const inline = parseAriaSnapshot(`- listitem: Chat`);
    expect(inline[0].role).toBe("listitem");
    expect(inline[0].children).toEqual([
      { role: "text", name: "Chat", attributes: [], children: [] },
    ]);
    expect(normalizeAriaSnapshot(`- listitem: Chat`)).toBe(
      normalizeAriaSnapshot(`- listitem:\n  - text: Chat`),
    );
  });

  it("does not mistake a colon inside a quoted name for a container marker", () => {
    const tree = parseAriaSnapshot(`- button "Save: draft"`);
    expect(tree[0].role).toBe("button");
    expect(tree[0].name).toBe("Save: draft");
    expect(tree[0].children).toEqual([]);
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
  it("is idempotent over named containers and text leaves", () => {
    const snapshot = `- banner:
  - navigation "Main":
    - link "Home"
- main:
  - heading "Welcome" [level=1]
  - text: Signed in as Ada
  - paragraph: Inline paragraph copy`;
    const once = normalizeAriaSnapshot(snapshot);
    expect(normalizeAriaSnapshot(once)).toBe(once);
    // Nothing was silently dropped or mangled on the way through.
    expect(once).toContain('- navigation "Main"');
    expect(once).toContain("- text: Signed in as Ada");
    expect(once).toContain("- text: Inline paragraph copy");
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
