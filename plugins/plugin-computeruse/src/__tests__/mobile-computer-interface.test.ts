/**
 * WS7 ↔ WS8 — MobileComputerInterface tests.
 *
 * Exercises the WS7 `ComputerInterface` port that adapts to Android via
 * `AndroidComputerUseBridge`. Pure JS — no Capacitor at runtime.
 *
 * What we cover:
 *   - leftClick / doubleClick / rightClick → dispatchGesture(tap)
 *   - dragTo / drag → dispatchGesture(swipe)
 *   - scroll → swipe with inverted sign convention
 *   - pressKey routes the supported `back`/`home`/`recents`/`notifications`
 *     into performGlobalAction; unsupported keys throw
 *   - hotkey + typeText explicitly throw (no consumer-build path)
 *   - screenshot drains captureFrame and decodes JPEG bytes
 *   - bridge ok:false propagates as a thrown Error
 *   - dispatch.ts converts those throws to ActionResult.driver_error
 *     (integration with the desktop dispatcher)
 */

import { describe, expect, it } from "vitest";
import {
  MobileComputerInterface,
  makeMobileComputerInterface,
} from "../mobile/mobile-computer-interface.js";
import { dispatch } from "../actor/dispatch.js";
import type {
  AndroidComputerUseBridge,
  GestureArgs,
} from "../mobile/android-bridge.js";
import type { DisplayDescriptor } from "../types.js";

interface BridgeCalls {
  gestures: GestureArgs[];
  globalActions: string[];
  capturedFrames: number;
}

function fakeDisplay(): DisplayDescriptor {
  return {
    id: 0,
    bounds: [0, 0, 1080, 1920],
    scaleFactor: 1,
    primary: true,
    name: "android-screen",
  };
}

function makeFakeBridge(opts: {
  gestureOk?: boolean;
  gestureError?: { code: "accessibility_unavailable" | "internal_error"; message: string };
  captureError?: { code: "capture_unavailable"; message: string };
  globalActionOk?: boolean;
}): { bridge: AndroidComputerUseBridge; calls: BridgeCalls } {
  const calls: BridgeCalls = {
    gestures: [],
    globalActions: [],
    capturedFrames: 0,
  };
  const stub = <T,>(code = "internal_error" as const): Promise<{ ok: false; code: typeof code; message: string } & { data?: T }> =>
    Promise.resolve({ ok: false, code, message: "stub" });
  const bridge = {
    startMediaProjection: () => stub(),
    stopMediaProjection: () => stub(),
    captureFrame: async () => {
      calls.capturedFrames += 1;
      if (opts.captureError) {
        return { ok: false as const, code: opts.captureError.code, message: opts.captureError.message };
      }
      return {
        ok: true as const,
        data: {
          jpegBase64: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"),
          width: 1080,
          height: 1920,
          timestampMs: 0,
        },
      };
    },
    getAccessibilityTree: () => stub(),
    dispatchGesture: async (g: GestureArgs) => {
      calls.gestures.push(g);
      if (opts.gestureError) {
        return { ok: false as const, code: opts.gestureError.code, message: opts.gestureError.message };
      }
      return { ok: true as const, data: { ok: opts.gestureOk ?? true } };
    },
    performGlobalAction: async ({ action }: { action: string }) => {
      calls.globalActions.push(action);
      return { ok: true as const, data: { ok: opts.globalActionOk ?? true } };
    },
    enumerateApps: () => stub(),
    getMemoryPressureSnapshot: () => stub(),
    dispatchMemoryPressure: () => stub(),
    startCamera: () => stub(),
    stopCamera: () => Promise.resolve({ ok: true as const, data: { ok: true } }),
    captureFrameCamera: () => stub(),
  } as unknown as AndroidComputerUseBridge;
  return { bridge, calls };
}

function makeIface(opts: Parameters<typeof makeFakeBridge>[0] = {}): {
  iface: MobileComputerInterface;
  calls: BridgeCalls;
} {
  const { bridge, calls } = makeFakeBridge(opts);
  const iface = new MobileComputerInterface({
    getBridge: () => bridge,
    getDisplay: () => fakeDisplay(),
  });
  return { iface, calls };
}

describe("MobileComputerInterface — gestures", () => {
  it("leftClick dispatches a tap with the local coords", async () => {
    const { iface, calls } = makeIface();
    await iface.leftClick({ displayId: 0, x: 540, y: 960 });
    expect(calls.gestures).toEqual([{ type: "tap", x: 540, y: 960 }]);
  });

  it("doubleClick dispatches two taps back-to-back", async () => {
    const { iface, calls } = makeIface();
    await iface.doubleClick({ displayId: 0, x: 100, y: 200 });
    expect(calls.gestures).toHaveLength(2);
    expect(calls.gestures[0]).toEqual({ type: "tap", x: 100, y: 200 });
    expect(calls.gestures[1]).toEqual({ type: "tap", x: 100, y: 200 });
  });

  it("rightClick falls back to a tap (Android has no right-click)", async () => {
    const { iface, calls } = makeIface();
    await iface.rightClick({ displayId: 0, x: 50, y: 60 });
    expect(calls.gestures).toEqual([{ type: "tap", x: 50, y: 60 }]);
  });

  it("dragTo uses cursorState start + new end → swipe", async () => {
    const cursorState = { current: { displayId: 0, x: 100, y: 200 } };
    const { bridge, calls } = makeFakeBridge({});
    const iface = new MobileComputerInterface({
      getBridge: () => bridge,
      getDisplay: () => fakeDisplay(),
      cursorState,
    });
    await iface.dragTo({ displayId: 0, x: 500, y: 800 });
    expect(calls.gestures).toHaveLength(1);
    const g = calls.gestures[0];
    expect(g?.type).toBe("swipe");
    if (g?.type === "swipe") {
      expect(g.x).toBe(100);
      expect(g.y).toBe(200);
      expect(g.x2).toBe(500);
      expect(g.y2).toBe(800);
      expect(g.durationMs).toBe(300);
    }
    expect(cursorState.current).toMatchObject({ displayId: 0, x: 500, y: 800 });
  });

  it("drag (full path) uses first + last points", async () => {
    const { iface, calls } = makeIface();
    await iface.drag({
      displayId: 0,
      path: [
        { x: 10, y: 10 },
        { x: 100, y: 200 },
        { x: 500, y: 800 },
      ],
    });
    expect(calls.gestures).toHaveLength(1);
    if (calls.gestures[0]?.type === "swipe") {
      expect(calls.gestures[0].x).toBe(10);
      expect(calls.gestures[0].y).toBe(10);
      expect(calls.gestures[0].x2).toBe(500);
      expect(calls.gestures[0].y2).toBe(800);
    }
  });

  it("drag rejects single-point paths", async () => {
    const { iface } = makeIface();
    await expect(
      iface.drag({ displayId: 0, path: [{ x: 1, y: 1 }] }),
    ).rejects.toThrow(/at least two points/);
  });

  it("scroll inverts sign — dy>0 (scroll down) = swipe UP", async () => {
    const { iface, calls } = makeIface();
    await iface.scroll({ displayId: 0, x: 540, y: 960, dx: 0, dy: 2 });
    expect(calls.gestures).toHaveLength(1);
    if (calls.gestures[0]?.type === "swipe") {
      expect(calls.gestures[0].x).toBe(540);
      expect(calls.gestures[0].y).toBe(960);
      // dy=2 -> endY = 960 - 2*200 = 560 (swipe upward)
      expect(calls.gestures[0].y2).toBe(560);
      expect(calls.gestures[0].x2).toBe(540);
    }
  });

  it("scroll dy<0 swipes DOWN (content scrolls up)", async () => {
    const { iface, calls } = makeIface();
    await iface.scroll({ displayId: 0, x: 540, y: 960, dx: 0, dy: -1 });
    expect(calls.gestures).toHaveLength(1);
    if (calls.gestures[0]?.type === "swipe") {
      // dy=-1 -> endY = 960 - (-1)*200 = 1160
      expect(calls.gestures[0].y2).toBe(1160);
    }
  });

  it("scroll clamps to display bounds", async () => {
    const { iface, calls } = makeIface();
    // Large dy that would land off-screen.
    await iface.scroll({ displayId: 0, x: 540, y: 1900, dx: 0, dy: 20 });
    if (calls.gestures[0]?.type === "swipe") {
      // 1900 - 20*200 = -2100 → clamped to 0
      expect(calls.gestures[0].y2).toBe(0);
    }
  });

  it("scroll dx=dy=0 is a no-op", async () => {
    const { iface, calls } = makeIface();
    await iface.scroll({ displayId: 0, x: 540, y: 960, dx: 0, dy: 0 });
    expect(calls.gestures).toHaveLength(0);
  });
});

describe("MobileComputerInterface — keyboard", () => {
  it("pressKey 'back' → performGlobalAction('back')", async () => {
    const { iface, calls } = makeIface();
    await iface.pressKey({ key: "back" });
    expect(calls.globalActions).toEqual(["back"]);
  });

  it("pressKey 'home' → performGlobalAction('home')", async () => {
    const { iface, calls } = makeIface();
    await iface.pressKey({ key: "home" });
    expect(calls.globalActions).toEqual(["home"]);
  });

  it("pressKey 'escape' aliases to 'back'", async () => {
    const { iface, calls } = makeIface();
    await iface.pressKey({ key: "escape" });
    expect(calls.globalActions).toEqual(["back"]);
  });

  it("pressKey on unsupported key throws", async () => {
    const { iface } = makeIface();
    await expect(iface.pressKey({ key: "Enter" })).rejects.toThrow(
      /no Android equivalent/,
    );
  });

  it("hotkey and typeText throw unconditionally", async () => {
    const { iface } = makeIface();
    await expect(iface.hotkey({ keys: ["ctrl", "s"] })).rejects.toThrow(/not supported/);
    await expect(iface.typeText({ text: "hi" })).rejects.toThrow(/not supported/);
  });
});

describe("MobileComputerInterface — screenshot", () => {
  it("decodes captureFrame JPEG and returns a ScreenshotResult", async () => {
    const { iface, calls } = makeIface();
    const shot = await iface.screenshot({});
    expect(calls.capturedFrames).toBe(1);
    expect(shot.displayId).toBe(0);
    expect(shot.bounds).toEqual([0, 0, 1080, 1920]);
    expect(shot.frame.subarray(0, 4)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  });

  it("propagates capture failure as a thrown Error", async () => {
    const { iface } = makeIface({
      captureError: { code: "capture_unavailable", message: "no frame" },
    });
    await expect(iface.screenshot({})).rejects.toThrow(/capture_unavailable/);
  });
});

describe("MobileComputerInterface — error propagation", () => {
  it("rejects unknown displayId on tap", async () => {
    const { iface } = makeIface();
    await expect(
      iface.leftClick({ displayId: 99, x: 10, y: 10 }),
    ).rejects.toThrow(/unknown Android displayId 99/);
  });

  it("rejects non-finite coords on tap", async () => {
    const { iface } = makeIface();
    await expect(
      iface.leftClick({ displayId: 0, x: Number.NaN, y: 0 }),
    ).rejects.toThrow(/non-finite coords/);
  });

  it("throws when bridge returns ok:false on dispatchGesture", async () => {
    const { iface } = makeIface({
      gestureError: { code: "accessibility_unavailable", message: "service off" },
    });
    await expect(
      iface.leftClick({ displayId: 0, x: 10, y: 10 }),
    ).rejects.toThrow(/accessibility_unavailable/);
  });

  it("throws when no bridge is registered", async () => {
    const iface = new MobileComputerInterface({ getBridge: () => null });
    await expect(
      iface.leftClick({ displayId: 0, x: 10, y: 10 }),
    ).rejects.toThrow(/bridge is not registered/);
  });
});

describe("MobileComputerInterface — coord helpers + metadata", () => {
  it("getScreenSize returns the display bounds w/h", () => {
    const { iface } = makeIface();
    expect(iface.getScreenSize({ displayId: 0 })).toEqual({ w: 1080, h: 1920 });
  });

  it("toScreenCoordinates round-trips with toScreenshotCoordinates", () => {
    const { iface } = makeIface();
    const s = iface.toScreenCoordinates({
      displayId: 0,
      imgX: 540,
      imgY: 960,
      imgW: 1080,
      imgH: 1920,
    });
    expect(s).toEqual({ x: 540, y: 960 });
    const back = iface.toScreenshotCoordinates({
      displayId: 0,
      x: s.x,
      y: s.y,
      imgW: 1080,
      imgH: 1920,
    });
    expect(back).toEqual({ imgX: 540, imgY: 960 });
  });

  it("getAccessibilityTree forwards from the scene accessor", () => {
    const scene = {
      timestamp: 1,
      displays: [fakeDisplay()],
      focused_window: null,
      apps: [],
      ocr: [],
      ax: [
        { id: "a0-1", role: "Button", bbox: [0, 0, 10, 10] as [number, number, number, number], actions: [], displayId: 0 },
      ],
      vlm_scene: null,
      vlm_elements: null,
    };
    const { bridge } = makeFakeBridge({});
    const iface = new MobileComputerInterface({
      getBridge: () => bridge,
      getDisplay: () => fakeDisplay(),
      getScene: () => scene,
    });
    expect(iface.getAccessibilityTree({})).toHaveLength(1);
    expect(iface.getAccessibilityTree({ displayId: 0 })).toHaveLength(1);
    expect(iface.getAccessibilityTree({ displayId: 1 })).toHaveLength(0);
  });
});

describe("MobileComputerInterface — global action override map", () => {
  it("custom globalActionMap takes precedence", async () => {
    const { bridge, calls } = makeFakeBridge({});
    const iface = new MobileComputerInterface({
      getBridge: () => bridge,
      getDisplay: () => fakeDisplay(),
      globalActionMap: new Map([["bksp", "back"]]),
    });
    await iface.pressKey({ key: "bksp" });
    expect(calls.globalActions).toEqual(["back"]);
    // The default `back` alias is replaced because the override map is the sole resolver
    await expect(iface.pressKey({ key: "back" })).rejects.toThrow(/no Android equivalent/);
  });
});

describe("MobileComputerInterface — integration with WS7 dispatch", () => {
  it("WS7 dispatch routes a click ProposedAction through the mobile bridge", async () => {
    const { iface, calls } = makeIface();
    const res = await dispatch(
      { kind: "click", displayId: 0, x: 540, y: 960, rationale: "tap save" },
      {
        interface: iface,
        listDisplays: () => [fakeDisplay()],
      },
    );
    expect(res.success).toBe(true);
    expect(calls.gestures).toEqual([{ type: "tap", x: 540, y: 960 }]);
  });

  it("WS7 dispatch wraps a mobile-bridge ok:false as driver_error", async () => {
    const { iface } = makeIface({
      gestureError: { code: "accessibility_unavailable", message: "service off" },
    });
    const res = await dispatch(
      { kind: "click", displayId: 0, x: 10, y: 10, rationale: "" },
      { interface: iface, listDisplays: () => [fakeDisplay()] },
    );
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe("driver_error");
    expect(res.error?.message).toContain("accessibility_unavailable");
  });

  it("WS7 dispatch on out-of-bounds tap still rejects before calling the bridge", async () => {
    const { iface, calls } = makeIface();
    const res = await dispatch(
      { kind: "click", displayId: 0, x: 9_000, y: 9_000, rationale: "" },
      { interface: iface, listDisplays: () => [fakeDisplay()] },
    );
    expect(res.error?.code).toBe("out_of_bounds");
    expect(calls.gestures).toHaveLength(0);
  });
});

describe("makeMobileComputerInterface factory", () => {
  it("returns a MobileComputerInterface instance", () => {
    const { bridge } = makeFakeBridge({});
    const iface = makeMobileComputerInterface({ getBridge: () => bridge });
    expect(iface).toBeInstanceOf(MobileComputerInterface);
  });
});
