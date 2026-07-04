/**
 * Multi-monitor coordinate translation tests cover local display pixels,
 * OS-global pixels, macOS backing-store scaling, and display hit-testing.
 *
 * The input driver targets global coordinates, so this math is the boundary
 * between model/display-local actions and platform-level mouse dispatch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayInfo } from "./displays.js";

const DISPLAYS: DisplayInfo[] = [
  {
    id: 1,
    bounds: [0, 0, 1920, 1080],
    scaleFactor: 2,
    primary: true,
    name: "main",
  },
  {
    id: 2,
    bounds: [1920, 0, 1280, 720],
    scaleFactor: 1,
    primary: false,
    name: "ext",
  },
];

const platform = vi.hoisted(() => ({ value: "linux" as string }));

vi.mock("./displays.js", () => ({
  listDisplays: () => DISPLAYS,
  getPrimaryDisplay: () => DISPLAYS[0],
  findDisplay: (id: number) => DISPLAYS.find((d) => d.id === id) ?? null,
}));
vi.mock("./helpers.js", () => ({
  currentPlatform: () => platform.value,
}));

import {
  clampToDisplay,
  globalToLocal,
  localToGlobal,
  localToGlobalDefault,
} from "./coords.js";

beforeEach(() => {
  platform.value = "linux";
});

describe("localToGlobal", () => {
  it("offsets a local point by its display origin", () => {
    expect(localToGlobal({ displayId: 1, x: 100, y: 50 })).toEqual({
      x: 100,
      y: 50,
    });
    expect(localToGlobal({ displayId: 2, x: 10, y: 20 })).toEqual({
      x: 1930,
      y: 20,
    });
  });

  it("throws on an unknown displayId", () => {
    expect(() => localToGlobal({ displayId: 99, x: 0, y: 0 })).toThrow(
      /Unknown displayId 99/,
    );
  });

  it("divides backing-store coords by scaleFactor only on macOS", () => {
    platform.value = "darwin";
    expect(localToGlobal({ displayId: 1, x: 200, y: 100 }, "backing")).toEqual({
      x: 100,
      y: 50,
    });
    // Same call off macOS applies no scale division.
    platform.value = "win32";
    expect(localToGlobal({ displayId: 1, x: 200, y: 100 }, "backing")).toEqual({
      x: 200,
      y: 100,
    });
  });
});

describe("localToGlobalDefault", () => {
  it("falls back to the primary display when displayId is missing", () => {
    expect(localToGlobalDefault({ x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
    expect(localToGlobalDefault({ displayId: 2, x: 1, y: 1 })).toEqual({
      x: 1921,
      y: 1,
    });
  });
});

describe("globalToLocal", () => {
  it("maps a global point back to its containing display", () => {
    expect(globalToLocal({ x: 1930, y: 30 })).toEqual({
      displayId: 2,
      x: 10,
      y: 30,
    });
    expect(globalToLocal({ x: 50, y: 60 })).toEqual({
      displayId: 1,
      x: 50,
      y: 60,
    });
  });

  it("returns null for a point outside every display", () => {
    expect(globalToLocal({ x: 5000, y: 5000 })).toBeNull();
  });
});

describe("clampToDisplay", () => {
  it("clamps a local point into its display bounds", () => {
    expect(clampToDisplay({ displayId: 1, x: 5000, y: -10 })).toEqual({
      displayId: 1,
      x: 1919,
      y: 0,
    });
  });

  it("returns the point unchanged for an unknown display", () => {
    expect(clampToDisplay({ displayId: 99, x: 7, y: 8 })).toEqual({
      displayId: 99,
      x: 7,
      y: 8,
    });
  });
});
