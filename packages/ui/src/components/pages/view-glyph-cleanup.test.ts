import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pagesRoot = resolve(import.meta.dirname);

function readPageSource(fileName: string): string {
  return readFileSync(resolve(pagesRoot, fileName), "utf8");
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
});
