/**
 * Verifies the Wayland grim capture contract without requiring a compositor.
 * The argument assertions protect region coordinates and output-path ordering
 * at the native CLI boundary; real compositor acceptance remains device-backed.
 */
import { describe, expect, it } from "vitest";
import { waylandGrimArgs } from "./wayland-grim.js";

describe("Wayland grim capture arguments", () => {
  it("captures the full display to the requested file", () => {
    expect(waylandGrimArgs("/tmp/full.png")).toEqual([
      "-s",
      "1",
      "/tmp/full.png",
    ]);
  });

  it("preserves the requested region geometry", () => {
    expect(
      waylandGrimArgs("/tmp/region.png", {
        x: 12,
        y: 34,
        width: 800,
        height: 600,
      }),
    ).toEqual(["-s", "1", "-g", "12,34 800x600", "/tmp/region.png"]);
  });

  it("selects one compositor output without changing geometry", () => {
    expect(waylandGrimArgs("/tmp/output.png", undefined, "DP-1")).toEqual([
      "-s",
      "1",
      "-o",
      "DP-1",
      "/tmp/output.png",
    ]);
  });
});
