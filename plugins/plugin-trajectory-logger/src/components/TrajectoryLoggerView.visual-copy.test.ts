import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

// The unified tri-modal wrapper plus the legacy full-screen overlay both render
// visible copy; neither may carry raw arrow/bullet glyphs that break terminal
// width or read poorly across surfaces.
const sources = ["TrajectoryLoggerView.tsx", "TrajectoryLoggerAppView.tsx"].map(
  (file) => ({
    file,
    source: readFileSync(resolve(here, file), "utf8"),
  }),
);

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
