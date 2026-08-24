/**
 * Tests for appearance-primitives.helpers — selectableTileClass.
 */
import { describe, expect, it } from "vitest";
import { selectableTileClass } from "./appearance-primitives.helpers.ts";

describe("appearance-primitives.helpers", () => {
  it("returns active classes when active", () => {
    const cls = selectableTileClass(true);
    expect(cls).toContain("border-accent");
    expect(cls).toContain("bg-accent/8");
  });

  it("returns resting classes when inactive", () => {
    const cls = selectableTileClass(false);
    expect(cls).toContain("border-border/50");
    expect(cls).toContain("hover:border-accent/40");
  });

  it("always contains base layout", () => {
    expect(selectableTileClass(true)).toContain("relative flex");
    expect(selectableTileClass(false)).toContain("relative flex");
  });

  it("active and inactive differ", () => {
    expect(selectableTileClass(true)).not.toBe(selectableTileClass(false));
  });
});
