/**
 * Verifies the Wayland grim capture contract without requiring a compositor.
 * The argument assertions protect region coordinates and output-path ordering
 * at the native CLI boundary; real compositor acceptance remains device-backed.
 */
import { describe, expect, it } from "vitest";
import { authoritativeWaylandOutputName } from "./capture.js";
import type { DisplayInfo } from "./displays.js";
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

  it("does not infer native output provenance from an XWayland name", () => {
    const xwaylandDisplay: DisplayInfo = {
      id: 0,
      bounds: [0, 0, 1920, 1080],
      scaleFactor: 1,
      primary: true,
      name: "XWAYLAND0",
    };
    expect(authoritativeWaylandOutputName(xwaylandDisplay)).toBeUndefined();
  });

  it("accepts only compositor-proven output names for scoped capture", () => {
    const compositorDisplay: DisplayInfo = {
      id: 0,
      bounds: [0, 0, 1920, 1080],
      scaleFactor: 1,
      primary: true,
      name: "DP-1",
      waylandOutput: true,
    };
    expect(authoritativeWaylandOutputName(compositorDisplay)).toBe("DP-1");
  });
});
