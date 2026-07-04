/**
 * Source-level regression guard: reads the view file's text and asserts its
 * visible copy carries no raw glyphs that break terminal width or read poorly
 * across surfaces. No render — a static read of the component source.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

// The unified tri-modal wrapper renders visible copy; it may not carry raw
// arrow/bullet glyphs that break terminal width or read poorly across surfaces.
const sources = ["TrajectoryLoggerView.tsx"].map((file) => ({
  file,
  source: readFileSync(resolve(here, file), "utf8"),
}));

describe("TrajectoryLogger visual copy", () => {
  it.each(
    sources,
  )("uses plain separators instead of raw arrow or bullet glyphs ($file)", ({
    source,
  }) => {
    expect(source).not.toContain(" → ");
    expect(source).not.toContain(" · ");
    expect(source).not.toContain("—");
  });
});
