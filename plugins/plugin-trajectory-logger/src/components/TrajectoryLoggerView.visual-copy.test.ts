import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "TrajectoryLoggerView.tsx"),
  "utf8",
);

describe("TrajectoryLoggerView visual copy", () => {
  it("uses plain separators instead of raw arrow or bullet glyphs", () => {
    expect(source).not.toContain(" → ");
    expect(source).not.toContain(" · ");
    expect(source).not.toContain("—");
  });
});
