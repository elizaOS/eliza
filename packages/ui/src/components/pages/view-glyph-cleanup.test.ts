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

    expect(source).toContain("Check");
    expect(source).not.toContain("\\u2713");
    expect(source).not.toContain("✓");
  });

  it("keeps Heartbeats status and delete controls on icon components instead of raw glyphs", () => {
    const source = readPageSource("HeartbeatsView.tsx");

    expect(source).toContain("CheckCircle2");
    expect(source).toContain("XCircle");
    expect(source).toContain("DeleteTemplate");
    expect(source).not.toContain("✓");
    expect(source).not.toContain("✗");
    expect(source).not.toContain("×");
  });

  // #8796: extend the iconography guard across EVERY built-in view — no raw
  // check/cross glyphs anywhere; use Lucide icon components instead. (× is the
  // multiplication sign and is intentionally not banned globally; close/delete
  // controls use the X icon, asserted per-view above.)
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
