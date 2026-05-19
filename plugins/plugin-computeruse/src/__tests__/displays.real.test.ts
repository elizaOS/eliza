/**
 * Real-host display-enumeration tests.
 *
 * - Linux/X11 path is exercised against `xrandr --listmonitors` on the live
 *   host when it's available. Otherwise the parser is still validated on
 *   curated fixtures.
 * - macOS / Windows paths are validated structurally against fixtures only.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  clampToDisplay,
  globalToLocal,
  localToGlobal,
  localToGlobalDefault,
} from "../platform/coords.js";
import {
  findDisplay,
  getPrimaryDisplay,
  listDisplays,
  parseDarwinDisplays,
  parseHyprlandMonitors,
  parseSwayOutputs,
  parseSystemProfilerDisplays,
  parseWindowsScreens,
  parseXrandrMonitors,
  refreshDisplays,
} from "../platform/displays.js";

function tryXrandr(): string | null {
  try {
    return execFileSync("xrandr", ["--listmonitors"], {
      timeout: 3000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

describe("displays — xrandr parser", () => {
  it("parses the canonical single-display layout", () => {
    const fixture = `Monitors: 1\n 0: +*eDP-1 2560/390x1600/240+0+0  eDP-1\n`;
    const parsed = parseXrandrMonitors(fixture);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: 0,
      bounds: [0, 0, 2560, 1600],
      scaleFactor: 1,
      primary: true,
      name: "eDP-1",
    });
  });

  it("parses a multi-display side-by-side layout", () => {
    const fixture = [
      "Monitors: 2",
      " 0: +*eDP-1 2560/390x1600/240+0+0  eDP-1",
      " 1: +HDMI-0 3840/600x2160/340+2560+0  HDMI-0",
      "",
    ].join("\n");
    const parsed = parseXrandrMonitors(fixture);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      id: 0,
      bounds: [0, 0, 2560, 1600],
      primary: true,
      name: "eDP-1",
    });
    expect(parsed[1]).toMatchObject({
      id: 1,
      bounds: [2560, 0, 3840, 2160],
      primary: false,
      name: "HDMI-0",
    });
  });

  it("handles a secondary-primary layout (no asterisk on first)", () => {
    const fixture = [
      "Monitors: 2",
      " 0: +HDMI-0 1920/600x1080/340+0+0  HDMI-0",
      " 1: +*eDP-1 2560/390x1600/240+1920+0  eDP-1",
      "",
    ].join("\n");
    const parsed = parseXrandrMonitors(fixture);
    expect(parsed).toHaveLength(2);
    expect(parsed.filter((d) => d.primary)).toHaveLength(1);
    expect(parsed.find((d) => d.primary)?.name).toBe("eDP-1");
  });

  it("handles negative origins (left-of-primary monitor)", () => {
    const fixture = [
      "Monitors: 2",
      " 0: +HDMI-0 1920/600x1080/340-1920+0  HDMI-0",
      " 1: +*eDP-1 2560/390x1600/240+0+0  eDP-1",
      "",
    ].join("\n");
    const parsed = parseXrandrMonitors(fixture);
    expect(parsed[0]?.bounds).toEqual([-1920, 0, 1920, 1080]);
    expect(parsed[1]?.bounds).toEqual([0, 0, 2560, 1600]);
  });

  it("ignores garbage and empty input", () => {
    expect(parseXrandrMonitors("")).toEqual([]);
    expect(parseXrandrMonitors("Monitors: 0\n")).toEqual([]);
    expect(parseXrandrMonitors("Not the expected format")).toEqual([]);
  });

  it("validates against the live host when xrandr is available", () => {
    const live = tryXrandr();
    if (!live) return;
    const parsed = parseXrandrMonitors(live);
    expect(parsed.length).toBeGreaterThan(0);
    expect(
      parsed.every((d) => Number.isFinite(d.bounds[2]) && d.bounds[2] > 0),
    ).toBe(true);
    expect(parsed.filter((d) => d.primary)).toHaveLength(1);
  });
});

describe("displays — Hyprland parser", () => {
  it("parses a single-monitor Hyprland JSON snapshot", () => {
    const fixture = JSON.stringify([
      {
        id: 0,
        name: "eDP-1",
        x: 0,
        y: 0,
        width: 2560,
        height: 1600,
        scale: 1.5,
        focused: true,
      },
    ]);
    const parsed = parseHyprlandMonitors(fixture);
    expect(parsed).toEqual([
      {
        id: 0,
        bounds: [0, 0, 2560, 1600],
        scaleFactor: 1.5,
        primary: true,
        name: "eDP-1",
      },
    ]);
  });

  it("parses a dual-monitor Hyprland snapshot", () => {
    const fixture = JSON.stringify([
      {
        id: 0,
        name: "eDP-1",
        x: 0,
        y: 0,
        width: 2560,
        height: 1600,
        scale: 1.5,
        focused: true,
      },
      {
        id: 1,
        name: "DP-2",
        x: 2560,
        y: 0,
        width: 3840,
        height: 2160,
        scale: 1,
        focused: false,
      },
    ]);
    const parsed = parseHyprlandMonitors(fixture);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.primary).toBe(true);
    expect(parsed[1]?.bounds).toEqual([2560, 0, 3840, 2160]);
  });

  it("rejects malformed JSON cleanly", () => {
    expect(parseHyprlandMonitors("not json")).toEqual([]);
    expect(parseHyprlandMonitors("{}")).toEqual([]);
  });
});

describe("displays — Sway parser", () => {
  it("parses sway get_outputs JSON", () => {
    const fixture = JSON.stringify([
      {
        name: "eDP-1",
        focused: true,
        rect: { x: 0, y: 0, width: 2560, height: 1600 },
        scale: 2,
      },
      {
        name: "HDMI-A-1",
        focused: false,
        rect: { x: 2560, y: 0, width: 1920, height: 1080 },
        scale: 1,
      },
    ]);
    const parsed = parseSwayOutputs(fixture);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.primary).toBe(true);
    expect(parsed[0]?.scaleFactor).toBe(2);
    expect(parsed[1]?.bounds).toEqual([2560, 0, 1920, 1080]);
  });
});

describe("displays — macOS system_profiler parser", () => {
  it("parses a single-display macOS report", () => {
    const fixture = JSON.stringify({
      SPDisplaysDataType: [
        {
          spdisplays_ndrvs: [
            {
              _name: "Built-in Retina Display",
              spdisplays_resolution: "1512 x 982",
              spdisplays_pixelresolution: "3024 x 1964",
              spdisplays_main: "spdisplays_yes",
            },
          ],
        },
      ],
    });
    const parsed = parseSystemProfilerDisplays(fixture);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: 0,
      bounds: [0, 0, 1512, 982],
      scaleFactor: 2,
      primary: true,
      name: "Built-in Retina Display",
    });
  });

  it("parses a dual-display retina + external 4K layout", () => {
    const fixture = JSON.stringify({
      SPDisplaysDataType: [
        {
          spdisplays_ndrvs: [
            {
              _name: "Built-in Retina Display",
              spdisplays_resolution: "1512 x 982",
              spdisplays_pixelresolution: "3024 x 1964",
              spdisplays_main: "spdisplays_yes",
            },
            {
              _name: "LG UltraFine",
              spdisplays_resolution: "3840 x 2160",
              spdisplays_pixelresolution: "3840 x 2160",
            },
          ],
        },
      ],
    });
    const parsed = parseSystemProfilerDisplays(fixture);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.scaleFactor).toBe(2);
    expect(parsed[1]?.scaleFactor).toBe(1);
    // Cursor-style layout: each display gets x offset by previous widths.
    expect(parsed[1]?.bounds[0]).toBe(1512);
  });
});

describe("displays — parseDarwinDisplays JXA round-trip", () => {
  it("parses a JXA-style JSON envelope", () => {
    const fixture = JSON.stringify([
      {
        id: 69733382,
        bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        pixelWidth: 5120,
        pixelHeight: 2880,
        primary: true,
        name: "main",
      },
    ]);
    const parsed = parseDarwinDisplays(fixture);
    expect(parsed[0]).toMatchObject({
      id: 69733382,
      bounds: [0, 0, 2560, 1440],
      scaleFactor: 2,
      primary: true,
      name: "main",
    });
  });
});

describe("displays — Windows PowerShell parser", () => {
  it("parses a single-display object (PowerShell collapses arrays of length 1)", () => {
    const fixture = JSON.stringify({
      DeviceName: "\\\\.\\DISPLAY1",
      Primary: true,
      Bounds: { X: 0, Y: 0, Width: 2560, Height: 1440 },
    });
    const parsed = parseWindowsScreens(fixture);
    expect(parsed).toEqual([
      {
        id: 0,
        bounds: [0, 0, 2560, 1440],
        scaleFactor: 1,
        primary: true,
        name: "\\\\.\\DISPLAY1",
      },
    ]);
  });

  it("parses a multi-display array", () => {
    const fixture = JSON.stringify([
      {
        DeviceName: "\\\\.\\DISPLAY1",
        Primary: true,
        Bounds: { X: 0, Y: 0, Width: 2560, Height: 1440 },
      },
      {
        DeviceName: "\\\\.\\DISPLAY2",
        Primary: false,
        Bounds: { X: 2560, Y: 0, Width: 1920, Height: 1080 },
      },
    ]);
    const parsed = parseWindowsScreens(fixture);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.primary).toBe(true);
    expect(parsed[1]?.bounds).toEqual([2560, 0, 1920, 1080]);
  });
});

describe("displays — live enumeration on this host", () => {
  it("returns at least one display from listDisplays()", () => {
    const displays = refreshDisplays();
    expect(displays.length).toBeGreaterThan(0);
    expect(displays.filter((d) => d.primary)).toHaveLength(1);
    expect(displays.every((d) => d.bounds[2] > 0 && d.bounds[3] > 0)).toBe(
      true,
    );
  });

  it("getPrimaryDisplay matches a listDisplays entry", () => {
    const primary = getPrimaryDisplay();
    const all = listDisplays();
    expect(all.some((d) => d.id === primary.id)).toBe(true);
    expect(primary.primary).toBe(true);
  });

  it("findDisplay returns null for unknown id", () => {
    expect(findDisplay(987654321)).toBeNull();
  });
});

describe("coords — translation", () => {
  it("localToGlobal adds display origin (logical coords)", () => {
    // Force fresh enumeration so listDisplays is current.
    const displays = refreshDisplays();
    const primary = displays.find((d) => d.primary)!;
    const result = localToGlobal({ displayId: primary.id, x: 100, y: 200 });
    expect(result.x).toBe(primary.bounds[0] + 100);
    expect(result.y).toBe(primary.bounds[1] + 200);
  });

  it("localToGlobalDefault falls back to primary on missing displayId", () => {
    const primary = getPrimaryDisplay();
    const result = localToGlobalDefault({ x: 10, y: 20 });
    expect(result.x).toBe(primary.bounds[0] + 10);
    expect(result.y).toBe(primary.bounds[1] + 20);
  });

  it("globalToLocal inverts localToGlobal for in-bounds points", () => {
    const primary = getPrimaryDisplay();
    const global = { x: primary.bounds[0] + 50, y: primary.bounds[1] + 60 };
    const local = globalToLocal(global);
    expect(local).not.toBeNull();
    expect(local?.displayId).toBe(primary.id);
    expect(local?.x).toBe(50);
    expect(local?.y).toBe(60);
  });

  it("globalToLocal returns null for points outside any display", () => {
    const result = globalToLocal({ x: -99999, y: -99999 });
    expect(result).toBeNull();
  });

  it("clampToDisplay clamps within bounds", () => {
    const primary = getPrimaryDisplay();
    const clamped = clampToDisplay({
      displayId: primary.id,
      x: 99999,
      y: -50,
    });
    expect(clamped.x).toBe(primary.bounds[2] - 1);
    expect(clamped.y).toBe(0);
  });

  it("rejects unknown displayId", () => {
    expect(() => localToGlobal({ displayId: 999_999_999, x: 0, y: 0 })).toThrow(
      /Unknown displayId/,
    );
  });
});
