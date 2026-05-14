/**
 * WS7 — ComputerInterface tests.
 *
 * Validates:
 *   - `toScreenCoordinates` / `toScreenshotCoordinates` round-trip cleanly
 *     for the image-space ↔ display-local mapping the VLM cascade relies on.
 *   - The thin-facade `DefaultComputerInterface` delegates each primitive
 *     (click / drag / scroll / type / hotkey / key) through the injected
 *     driver overrides — proving the cascade can swap in a fake driver for
 *     deterministic tests without touching the real platform layer.
 *   - Unknown display ids throw; the dispatcher relies on that contract.
 */

import { describe, expect, it } from "vitest";
import {
  DefaultComputerInterface,
  makeComputerInterface,
  type ComputerInterfaceDeps,
} from "../actor/computer-interface.js";
import type { DisplayDescriptor } from "../types.js";

function fakeDisplays(): DisplayDescriptor[] {
  return [
    {
      id: 0,
      bounds: [0, 0, 1920, 1080],
      scaleFactor: 1,
      primary: true,
      name: "fake-1",
    },
    {
      id: 1,
      bounds: [1920, 0, 2560, 1440],
      scaleFactor: 1,
      primary: false,
      name: "fake-2",
    },
  ];
}

function makeIface(extra: Partial<ComputerInterfaceDeps> = {}): {
  iface: DefaultComputerInterface;
  calls: Record<string, unknown[][]>;
} {
  const calls: Record<string, unknown[][]> = {
    click: [],
    doubleClick: [],
    rightClick: [],
    mouseMove: [],
    drag: [],
    scroll: [],
    type: [],
    keyPress: [],
    keyCombo: [],
  };
  const iface = new DefaultComputerInterface({
    listDisplays: () => fakeDisplays(),
    driver: {
      click: async (x, y) => {
        calls.click!.push([x, y]);
      },
      doubleClick: async (x, y) => {
        calls.doubleClick!.push([x, y]);
      },
      rightClick: async (x, y) => {
        calls.rightClick!.push([x, y]);
      },
      mouseMove: async (x, y) => {
        calls.mouseMove!.push([x, y]);
      },
      drag: async (x1, y1, x2, y2) => {
        calls.drag!.push([x1, y1, x2, y2]);
      },
      scroll: async (x, y, dir, amt) => {
        calls.scroll!.push([x, y, dir, amt]);
      },
      type: async (t) => {
        calls.type!.push([t]);
      },
      keyPress: async (k) => {
        calls.keyPress!.push([k]);
      },
      keyCombo: async (c) => {
        calls.keyCombo!.push([c]);
      },
    },
    ...extra,
  });
  return { iface, calls };
}

describe("DefaultComputerInterface — coord conversions", () => {
  it("round-trips toScreenCoordinates → toScreenshotCoordinates", () => {
    const { iface } = makeIface();
    // Image-space 640x360 represents the 1920x1080 display.
    const screen = iface.toScreenCoordinates({
      displayId: 0,
      imgX: 320,
      imgY: 180,
      imgW: 640,
      imgH: 360,
    });
    // 320/640 * 1920 = 960; 180/360 * 1080 = 540.
    expect(screen).toEqual({ x: 960, y: 540 });
    const back = iface.toScreenshotCoordinates({
      displayId: 0,
      x: screen.x,
      y: screen.y,
      imgW: 640,
      imgH: 360,
    });
    expect(back).toEqual({ imgX: 320, imgY: 180 });
  });

  it("handles non-unity image dimensions for both directions", () => {
    const { iface } = makeIface();
    // Asymmetric image — 800x600 against the 2560x1440 second display.
    const a = iface.toScreenCoordinates({
      displayId: 1,
      imgX: 400,
      imgY: 300,
      imgW: 800,
      imgH: 600,
    });
    // 400/800 * 2560 = 1280; 300/600 * 1440 = 720.
    expect(a).toEqual({ x: 1280, y: 720 });
    const b = iface.toScreenshotCoordinates({
      displayId: 1,
      x: 1280,
      y: 720,
      imgW: 800,
      imgH: 600,
    });
    expect(b).toEqual({ imgX: 400, imgY: 300 });
  });

  it("rejects zero image dimensions", () => {
    const { iface } = makeIface();
    expect(() =>
      iface.toScreenCoordinates({ displayId: 0, imgX: 1, imgY: 1, imgW: 0, imgH: 100 }),
    ).toThrow(/positive image dimensions/);
  });

  it("throws on unknown display id for coord conversions", () => {
    const { iface } = makeIface();
    expect(() =>
      iface.toScreenCoordinates({ displayId: 99, imgX: 1, imgY: 1, imgW: 100, imgH: 100 }),
    ).toThrow(/unknown displayId/);
  });
});

describe("DefaultComputerInterface — driver delegation", () => {
  it("leftClick / doubleClick / rightClick route through injected driver", async () => {
    // The driver-delegation path goes through the central
    // `localToGlobal` (coords.ts), which uses the live OS-level
    // `findDisplay`, not the injected `listDisplays`. Drive only against
    // display 0 (the host's primary) here; the global-translation math is
    // exercised in `coords` tests.
    const { iface, calls } = makeIface();
    await iface.leftClick({ displayId: 0, x: 100, y: 200 });
    await iface.doubleClick({ displayId: 0, x: 300, y: 400 });
    await iface.rightClick({ displayId: 0, x: 50, y: 60 });
    expect(calls.click).toHaveLength(1);
    expect(calls.doubleClick).toHaveLength(1);
    expect(calls.rightClick).toHaveLength(1);
    // Each entry is [globalX, globalY]; on this host primary origin is 0,0,
    // so the local coords pass through unchanged.
    expect(calls.click[0]?.[0]).toBe(100);
    expect(calls.click[0]?.[1]).toBe(200);
  });

  it("typeText routes through injected driver.type", async () => {
    const { iface, calls } = makeIface();
    await iface.typeText({ text: "hello world" });
    expect(calls.type).toEqual([["hello world"]]);
  });

  it("hotkey joins keys with + and routes through driver.keyCombo", async () => {
    const { iface, calls } = makeIface();
    await iface.hotkey({ keys: ["ctrl", "shift", "p"] });
    expect(calls.keyCombo).toEqual([["ctrl+shift+p"]]);
  });

  it("pressKey routes through driver.keyPress", async () => {
    const { iface, calls } = makeIface();
    await iface.pressKey({ key: "Enter" });
    expect(calls.keyPress).toEqual([["Enter"]]);
  });

  it("scroll splits vertical + horizontal deltas into driver calls", async () => {
    const { iface, calls } = makeIface();
    await iface.scroll({ displayId: 0, x: 100, y: 100, dx: 3, dy: -2 });
    // dy first (up 2), then dx (right 3).
    expect(calls.scroll).toEqual([
      [100, 100, "up", 2],
      [100, 100, "right", 3],
    ]);
  });

  it("drag routes start + end through driver.drag", async () => {
    const { iface, calls } = makeIface();
    await iface.drag({
      displayId: 0,
      path: [
        { x: 10, y: 10 },
        { x: 100, y: 100 },
      ],
    });
    expect(calls.drag).toEqual([[10, 10, 100, 100]]);
  });

  it("drag fails on cross-display dragTo", async () => {
    // Drag-across-displays check fires before the coord translation.
    // Mutate cursorState to a synthetic non-zero display so we can hit it
    // without needing a real second display on the host.
    const cursorState = { current: { displayId: 0, x: 5, y: 5 } };
    const { iface } = makeIface({ cursorState });
    cursorState.current = { displayId: 7, x: 5, y: 5 };
    await expect(
      iface.dragTo({ displayId: 0, x: 5, y: 5 }),
    ).rejects.toThrow(/across displays/);
  });

  it("drag rejects single-point paths", async () => {
    const { iface } = makeIface();
    await expect(
      iface.drag({ displayId: 0, path: [{ x: 1, y: 1 }] }),
    ).rejects.toThrow(/at least two points/);
  });

  it("rejects unknown displayId on click", async () => {
    const { iface } = makeIface();
    await expect(
      iface.leftClick({ displayId: 99, x: 0, y: 0 }),
    ).rejects.toThrow(/unknown displayId 99/);
  });

  it("rejects non-finite coords on click", async () => {
    const { iface } = makeIface();
    await expect(
      iface.leftClick({ displayId: 0, x: Number.NaN, y: 0 }),
    ).rejects.toThrow(/non-finite coords/);
  });

  it("getScreenSize returns the display's logical bounds", () => {
    const { iface } = makeIface();
    expect(iface.getScreenSize({ displayId: 0 })).toEqual({ w: 1920, h: 1080 });
    expect(iface.getScreenSize({ displayId: 1 })).toEqual({ w: 2560, h: 1440 });
  });

  it("getCursorPosition tracks the last successful movement", async () => {
    const { iface } = makeIface();
    await iface.moveCursor({ displayId: 0, x: 42, y: 84 });
    expect(iface.getCursorPosition()).toMatchObject({ displayId: 0, x: 42, y: 84 });
  });

  it("hotkey requires at least one key", async () => {
    const { iface } = makeIface();
    await expect(iface.hotkey({ keys: [] })).rejects.toThrow(/at least one key/);
  });

  it("getAccessibilityTree returns the current scene's AX nodes, filterable by display", () => {
    const { iface } = makeIface({
      getScene: () => ({
        timestamp: 0,
        displays: fakeDisplays(),
        focused_window: null,
        apps: [],
        ocr: [],
        ax: [
          { id: "a0-1", role: "button", bbox: [0, 0, 10, 10], actions: [], displayId: 0 },
          { id: "a1-1", role: "button", bbox: [0, 0, 10, 10], actions: [], displayId: 1 },
        ],
        vlm_scene: null,
        vlm_elements: null,
      }),
    });
    expect(iface.getAccessibilityTree({})).toHaveLength(2);
    expect(iface.getAccessibilityTree({ displayId: 0 })).toHaveLength(1);
    expect(iface.getAccessibilityTree({ displayId: 0 })[0]?.id).toBe("a0-1");
  });
});

describe("makeComputerInterface factory", () => {
  it("returns a DefaultComputerInterface instance", () => {
    const iface = makeComputerInterface({ listDisplays: () => fakeDisplays() });
    expect(iface).toBeInstanceOf(DefaultComputerInterface);
  });
});
