/**
 * WS9 cross-review — IosComputerInterface.
 *
 * Validates:
 *   1. screenshot drains a frame from `replayKitForegroundDrain`.
 *   2. input-bearing methods throw with a "use invokeAppIntent" message.
 *   3. invokeAppIntent forwards to `bridge.appIntentInvoke`.
 *   4. metadata helpers (coord conversion, getScreenSize) work without a bridge call.
 *   5. AccessibilityTree comes from the scene accessor (own-app AX only).
 */

import { describe, expect, it } from "vitest";
import type {
  IntentInvocationRequest,
  IosBridgeResult,
  IosComputerUseBridge,
} from "../mobile/ios-bridge.js";
import {
  IOS_LOGICAL_DISPLAY_ID,
  IosComputerInterface,
  makeIosComputerInterface,
} from "../mobile/ios-computer-interface.js";
import type { Scene } from "../scene/scene-types.js";

function stubBridge(
  overrides: Partial<IosComputerUseBridge> = {},
): IosComputerUseBridge {
  const generic = <T>(): Promise<IosBridgeResult<T>> =>
    Promise.resolve({ ok: false, code: "internal_error", message: "stub" });
  return {
    probe: () =>
      Promise.resolve({
        ok: true,
        data: {
          platform: "ios",
          osVersion: "26.1",
          capabilities: {
            replayKitForeground: true,
            broadcastExtension: false,
            visionOcr: true,
            appIntents: true,
            accessibilityRead: true,
            foundationModel: true,
          },
        },
      }),
    replayKitForegroundStart: generic,
    replayKitForegroundStop: generic,
    replayKitForegroundDrain: () =>
      Promise.resolve({
        ok: true,
        data: {
          frames: [
            {
              timestampNs: 1,
              width: 1170,
              height: 2532,
              jpegBase64: Buffer.from([0xff, 0xd8, 0xff]).toString("base64"),
            },
          ],
        },
      }),
    broadcastExtensionHandshake: generic,
    visionOcr: generic,
    appIntentList: () => Promise.resolve({ ok: true, data: { intents: [] } }),
    appIntentInvoke: (req: IntentInvocationRequest) =>
      Promise.resolve({
        ok: true,
        data: {
          intentId: req.intentId,
          success: true,
          response: { echo: req.parameters },
          elapsedMs: 12,
        },
      }),
    accessibilitySnapshot: generic,
    foundationModelGenerate: generic,
    memoryPressureProbe: generic,
    ...overrides,
  };
}

describe("IosComputerInterface — screenshot", () => {
  it("drains the first frame from replayKitForegroundDrain", async () => {
    const bridge = stubBridge();
    const iface = new IosComputerInterface({
      getBridge: () => bridge,
      getReplayKitSessionId: () => "rk-session-1",
    });
    const shot = await iface.screenshot();
    expect(shot.displayId).toBe(IOS_LOGICAL_DISPLAY_ID);
    expect(shot.bounds).toEqual([0, 0, 1170, 2532]);
    expect(shot.scaleFactor).toBe(1);
    expect(shot.frame[0]).toBe(0xff);
    expect(shot.frame[1]).toBe(0xd8);
  });

  it("throws when no ReplayKit session is active", async () => {
    const bridge = stubBridge();
    const iface = new IosComputerInterface({
      getBridge: () => bridge,
      getReplayKitSessionId: () => null,
    });
    await expect(iface.screenshot()).rejects.toThrow(
      /requires an active ReplayKit session/,
    );
  });

  it("throws when the bridge returns no frames", async () => {
    const bridge = stubBridge({
      replayKitForegroundDrain: () =>
        Promise.resolve({ ok: true, data: { frames: [] } }),
    });
    const iface = new IosComputerInterface({
      getBridge: () => bridge,
      getReplayKitSessionId: () => "rk-session-1",
    });
    await expect(iface.screenshot()).rejects.toThrow(/returned no frames/);
  });

  it("surfaces bridge errors with code + message", async () => {
    const bridge = stubBridge({
      replayKitForegroundDrain: () =>
        Promise.resolve({
          ok: false,
          code: "extension_died",
          message: "iOS-26 beta regression",
        }),
    });
    const iface = new IosComputerInterface({
      getBridge: () => bridge,
      getReplayKitSessionId: () => "rk-session-1",
    });
    await expect(iface.screenshot()).rejects.toThrow(/extension_died.*iOS-26/);
  });
});

describe("IosComputerInterface — input refused with redirect", () => {
  const cases: ReadonlyArray<
    readonly [string, (i: IosComputerInterface) => Promise<unknown>]
  > = [
    ["leftClick", (i) => i.leftClick({ displayId: 0, x: 10, y: 20 })],
    ["rightClick", (i) => i.rightClick({ displayId: 0, x: 10, y: 20 })],
    ["doubleClick", (i) => i.doubleClick({ displayId: 0, x: 10, y: 20 })],
    ["dragTo", (i) => i.dragTo({ displayId: 0, x: 10, y: 20 })],
    [
      "drag",
      (i) =>
        i.drag({
          displayId: 0,
          path: [
            { x: 0, y: 0 },
            { x: 100, y: 100 },
          ],
        }),
    ],
    ["scroll", (i) => i.scroll({ displayId: 0, x: 10, y: 20, dx: 0, dy: 1 })],
    ["scrollUp", (i) => i.scrollUp({ displayId: 0, clicks: 1 })],
    ["typeText", (i) => i.typeText({ text: "hi" })],
    ["pressKey", (i) => i.pressKey({ key: "a" })],
    ["hotkey", (i) => i.hotkey({ keys: ["cmd", "a"] })],
  ];
  for (const [name, fn] of cases) {
    it(`${name} throws with "not supported on iOS" message`, async () => {
      const iface = new IosComputerInterface({ getBridge: () => stubBridge() });
      // Pointer-input refusal redirects to App Intents; keyboard-input
      // refusal points at "keyboards are app-local only". Either message
      // is a valid refusal — both point the caller at IOS_CONSTRAINTS.md.
      await expect(fn(iface)).rejects.toThrow(
        /not supported on iOS.*IOS_CONSTRAINTS\.md/i,
      );
    });
  }
});

describe("IosComputerInterface — invokeAppIntent", () => {
  it("forwards intent id and parameters to the bridge", async () => {
    let received: IntentInvocationRequest | null = null;
    const bridge = stubBridge({
      appIntentInvoke: (req) => {
        received = req;
        return Promise.resolve({
          ok: true,
          data: {
            intentId: req.intentId,
            success: true,
            elapsedMs: 5,
          },
        });
      },
    });
    const iface = new IosComputerInterface({ getBridge: () => bridge });
    const result = await iface.invokeAppIntent({
      intentId: "com.apple.mobilenotes.create-note",
      parameters: { body: "hello", title: "test" },
    });
    expect(result.success).toBe(true);
    expect(result.intentId).toBe("com.apple.mobilenotes.create-note");
    expect(received).not.toBeNull();
    expect(received!.parameters).toEqual({ body: "hello", title: "test" });
  });

  it("throws with structured code + message on bridge failure", async () => {
    const bridge = stubBridge({
      appIntentInvoke: () =>
        Promise.resolve({
          ok: false,
          code: "intent_not_found",
          message: "no such intent on this device",
        }),
    });
    const iface = new IosComputerInterface({ getBridge: () => bridge });
    await expect(
      iface.invokeAppIntent({
        intentId: "com.unknown.app.do-thing",
        parameters: {},
      }),
    ).rejects.toThrow(/intent_not_found.*no such intent/);
  });

  it("throws when the bridge is not registered", async () => {
    const iface = new IosComputerInterface({ getBridge: () => null });
    await expect(
      iface.invokeAppIntent({ intentId: "x", parameters: {} }),
    ).rejects.toThrow(/bridge is not registered/);
  });
});

describe("IosComputerInterface — metadata + AX", () => {
  it("getScreenSize returns the display bounds without a bridge call", () => {
    const iface = new IosComputerInterface({
      getBridge: () => null,
      getDisplay: () => ({
        id: IOS_LOGICAL_DISPLAY_ID,
        bounds: [0, 0, 1290, 2796],
        scaleFactor: 3,
        primary: true,
        name: "iphone-15-pro-max",
      }),
    });
    expect(iface.getScreenSize({ displayId: IOS_LOGICAL_DISPLAY_ID })).toEqual({
      w: 1290,
      h: 2796,
    });
  });

  it("toScreenCoordinates scales from image space into display space", () => {
    const iface = new IosComputerInterface({
      getBridge: () => null,
      getDisplay: () => ({
        id: IOS_LOGICAL_DISPLAY_ID,
        bounds: [0, 0, 1000, 2000],
        scaleFactor: 1,
        primary: true,
        name: "fake",
      }),
    });
    const p = iface.toScreenCoordinates({
      displayId: IOS_LOGICAL_DISPLAY_ID,
      imgX: 100,
      imgY: 200,
      imgW: 500,
      imgH: 1000,
    });
    expect(p).toEqual({ x: 200, y: 400 });
  });

  it("getAccessibilityTree returns scene AX scoped to the iOS display", () => {
    const scene: Scene = {
      timestamp: 1,
      displays: [
        {
          id: IOS_LOGICAL_DISPLAY_ID,
          bounds: [0, 0, 1170, 2532],
          scaleFactor: 1,
          primary: true,
          name: "ios",
        },
      ],
      focused_window: null,
      apps: [],
      ocr: [],
      ax: [
        {
          id: "a1",
          role: "button",
          label: "OK",
          bbox: [0, 0, 100, 40],
          displayId: IOS_LOGICAL_DISPLAY_ID,
        },
        {
          id: "a2",
          role: "label",
          label: "Other",
          bbox: [0, 0, 100, 40],
          displayId: 99,
        },
      ],
      vlm_scene: null,
      vlm_elements: null,
    };
    const iface = new IosComputerInterface({
      getBridge: () => null,
      getScene: () => scene,
    });
    const allNodes = iface.getAccessibilityTree({});
    expect(allNodes).toHaveLength(2);
    const onlyIos = iface.getAccessibilityTree({
      displayId: IOS_LOGICAL_DISPLAY_ID,
    });
    expect(onlyIos).toHaveLength(1);
    expect(onlyIos[0]!.label).toBe("OK");
  });

  it("rejects unknown displayId", () => {
    const iface = new IosComputerInterface({ getBridge: () => null });
    expect(() =>
      iface.toScreenCoordinates({
        displayId: 99,
        imgX: 0,
        imgY: 0,
        imgW: 100,
        imgH: 100,
      }),
    ).toThrow(/unknown iOS displayId 99/);
  });
});

describe("makeIosComputerInterface factory", () => {
  it("returns an IosComputerInterface instance", () => {
    const iface = makeIosComputerInterface({ getBridge: () => stubBridge() });
    expect(iface).toBeInstanceOf(IosComputerInterface);
  });
});
