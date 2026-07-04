/**
 * Source-scanning guard (#8796) over every built-in `*View.tsx` in this folder:
 * asserts no raw check/cross glyphs appear in the source so status and
 * close/delete controls stay on Lucide icon components. Reads files from disk;
 * asserts on string content, not rendered output.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pagesRoot = resolve(import.meta.dirname);

function readPageSource(fileName: string): string {
  return readFileSync(resolve(pagesRoot, fileName), "utf8");
}

/** Every built-in view component file (the redesign targets). */
function listViewFiles(): string[] {
  return readdirSync(pagesRoot).filter(
    (name) => name.endsWith("View.tsx") && !name.endsWith(".test.tsx"),
  );
}

describe("shared view glyph cleanup", () => {
  it("keeps Config RPC mode selection on icon components instead of raw glyphs", () => {
    const source = readPageSource("ConfigPageView.tsx");

    expect(source).not.toContain("\\u2713");
    expect(source).not.toContain("✓");
  });

  it("keeps Triggers status and delete controls on icon components instead of raw glyphs", () => {
    const source = readPageSource("TriggersView.tsx");

    expect(source).not.toContain("✓");
    expect(source).not.toContain("✗");
    expect(source).not.toContain("×");
  });

  // #8796: extend the iconography guard across EVERY built-in view — no raw
  // check/cross glyphs anywhere; use Lucide icon components instead. (× is the
  // multiplication sign and is intentionally not banned globally; close/delete
  // controls use the X icon.)
  it.each(
    listViewFiles(),
  )("%s uses Lucide icons, not raw check/cross glyphs", (fileName) => {
    const source = readPageSource(fileName);
    expect(source, `${fileName} contains a raw ✓`).not.toContain("✓");
    expect(source, `${fileName} contains a raw ✗`).not.toContain("✗");
    expect(source, `${fileName} contains a raw ✘`).not.toContain("✘");
    expect(source, `${fileName} contains a raw ✕`).not.toContain("✕");
  });
});
