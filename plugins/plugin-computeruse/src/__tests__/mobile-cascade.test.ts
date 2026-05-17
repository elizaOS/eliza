/**
 * WS7 ↔ WS8 — Mobile cascade integration.
 *
 * Drives the full agent loop on a stubbed Android bridge:
 *   Scene (parsed from Kotlin AX JSON)
 *     → MobileScreenCaptureSource.captureAllDisplays() (JPEG bytes)
 *     → Brain (stubbed)
 *     → Cascade (`ScreenSeekeR`)
 *     → dispatch → MobileComputerInterface.leftClick
 *     → AndroidComputerUseBridge.dispatchGesture(tap)
 *
 * Also covers the WS1 ↔ WS2 ↔ WS7 memory-pressure path: when the bridge
 * dispatches a `critical` pressure level mid-cascade, the test verifies the
 * pressure listener fires (which the WS1 MemoryArbiter wires to model
 * eviction) and that the next Brain call goes back through the model
 * (loaded again from the runtime side).
 */

import { describe, expect, it } from "vitest";
import {
  type ComputerUseAgentReport,
  runComputerUseAgentLoop,
} from "../actions/use-computer-agent.js";
import { OcrCoordinateGroundingActor } from "../actor/actor.js";
import { Brain } from "../actor/brain.js";
import { Cascade } from "../actor/cascade.js";
import { dispatch } from "../actor/dispatch.js";
import type {
  AndroidComputerUseBridge,
  AndroidPressureLevel,
  CapturedScreenFrame,
  GestureArgs,
} from "../mobile/android-bridge.js";
import { parseAndroidAxTree } from "../mobile/android-scene.js";
import { MobileComputerInterface } from "../mobile/mobile-computer-interface.js";
import {
  ANDROID_LOGICAL_DISPLAY_ID,
  MobileScreenCaptureSource,
} from "../mobile/mobile-screen-capture.js";
import type { Scene } from "../scene/scene-types.js";
import type { ComputerUseService } from "../services/computer-use-service.js";
import type { DisplayDescriptor } from "../types.js";

type PressureListener = (level: AndroidPressureLevel, freeMb?: number) => void;

interface FakeAndroidBridgeOpts {
  axTreeJson?: string;
  frame?: CapturedScreenFrame;
  onGesture?: (g: GestureArgs) => void;
  onMemoryPressure?: PressureListener;
}

function defaultFrame(): CapturedScreenFrame {
  return {
    jpegBase64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xaa, 0xbb]).toString(
      "base64",
    ),
    width: 1080,
    height: 1920,
    timestampMs: 0,
  };
}

const DEFAULT_AX_JSON = JSON.stringify([
  {
    id: "1",
    role: "android.widget.Button",
    label: "Save",
    bbox: { x: 200, y: 400, w: 200, h: 80 },
    actions: ["click", "focus"],
  },
]);

function makeFakeBridge(opts: FakeAndroidBridgeOpts = {}): {
  bridge: AndroidComputerUseBridge;
  taps: GestureArgs[];
  pressureEvents: Array<{ level: AndroidPressureLevel; freeMb?: number }>;
} {
  const taps: GestureArgs[] = [];
  const pressureEvents: Array<{
    level: AndroidPressureLevel;
    freeMb?: number;
  }> = [];
  const ax = opts.axTreeJson ?? DEFAULT_AX_JSON;
  const frame = opts.frame ?? defaultFrame();
  const stub = <T>(code = "internal_error" as const) =>
    Promise.resolve({ ok: false as const, code, message: "stub" }) as Promise<
      { ok: false; code: typeof code; message: string } & { data?: T }
    >;
  const bridge = {
    startMediaProjection: () => stub(),
    stopMediaProjection: () => stub(),
    captureFrame: async () => ({ ok: true as const, data: frame }),
    getAccessibilityTree: async () => ({
      ok: true as const,
      data: { nodes: ax },
    }),
    dispatchGesture: async (g: GestureArgs) => {
      taps.push(g);
      opts.onGesture?.(g);
      return { ok: true as const, data: { ok: true } };
    },
    performGlobalAction: async () => ({
      ok: true as const,
      data: { ok: true },
    }),
    setText: async () => ({ ok: true as const, data: { ok: true } }),
    enumerateApps: () => stub(),
    getMemoryPressureSnapshot: () => stub(),
    dispatchMemoryPressure: async ({
      level,
      freeMb,
    }: {
      level: AndroidPressureLevel;
      freeMb?: number;
    }) => {
      const event = { level, freeMb };
      pressureEvents.push(event);
      opts.onMemoryPressure?.(level, freeMb);
      return { ok: true as const, data: { ok: true } };
    },
    startCamera: () => stub(),
    stopCamera: () =>
      Promise.resolve({ ok: true as const, data: { ok: true } }),
    captureFrameCamera: () => stub(),
  } as unknown as AndroidComputerUseBridge;
  return { bridge, taps, pressureEvents };
}

function androidDisplay(): DisplayDescriptor {
  return {
    id: ANDROID_LOGICAL_DISPLAY_ID,
    bounds: [0, 0, 1080, 1920],
    scaleFactor: 1,
    primary: true,
    name: "android-screen",
  };
}

function buildScene(axJson: string = DEFAULT_AX_JSON): Scene {
  const ax = parseAndroidAxTree(axJson, ANDROID_LOGICAL_DISPLAY_ID);
  return {
    timestamp: Date.now(),
    displays: [androidDisplay()],
    focused_window: {
      app: "com.example.app",
      pid: null,
      bounds: [0, 0, 1080, 1920],
      title: "Example",
      displayId: ANDROID_LOGICAL_DISPLAY_ID,
    },
    apps: [],
    ocr: [],
    ax,
    vlm_scene: null,
    vlm_elements: null,
  };
}

function fakeService(scene: Scene): ComputerUseService {
  return {
    getCurrentScene: () => scene,
    refreshScene: async () => scene,
    getDisplays: () => [androidDisplay()],
  } as unknown as ComputerUseService;
}

describe("Mobile cascade — end-to-end scene → brain → dispatch → tap", () => {
  it("Brain `ref:a0-1` resolves to the AX node center and fires a tap", async () => {
    const { bridge, taps } = makeFakeBridge();
    const scene = buildScene();
    const capture = new MobileScreenCaptureSource({ getBridge: () => bridge });
    const computer = new MobileComputerInterface({
      getBridge: () => bridge,
      getDisplay: () => androidDisplay(),
      getScene: () => scene,
    });
    const actor = new OcrCoordinateGroundingActor(() => scene);
    const brain = new Brain(null, {
      invokeModel: async () =>
        JSON.stringify({
          scene_summary: "Save button visible",
          target_display_id: ANDROID_LOGICAL_DISPLAY_ID,
          roi: [],
          proposed_action: {
            kind: "click",
            ref: "a0-1",
            rationale: "tap save",
          },
        }),
    });
    const cascade = new Cascade({ brain, actor });
    const captures = new Map();
    for (const c of await capture.captureAllDisplays())
      captures.set(c.display.id, c);
    const cascadeResult = await cascade.run({
      scene,
      goal: "save the document",
      captures,
    });
    expect(cascadeResult.proposed.kind).toBe("click");
    // bbox [200, 400, 200, 80] → center (300, 440)
    expect(cascadeResult.proposed.x).toBe(300);
    expect(cascadeResult.proposed.y).toBe(440);
    const dispatched = await dispatch(cascadeResult.proposed, {
      interface: computer,
      listDisplays: () => [androidDisplay()],
    });
    expect(dispatched.success).toBe(true);
    expect(taps).toEqual([{ type: "tap", x: 300, y: 440 }]);
  });

  it("runComputerUseAgentLoop walks scene→cascade→tap on the Android stack", async () => {
    const { bridge, taps } = makeFakeBridge();
    const scene = buildScene();
    const capture = new MobileScreenCaptureSource({ getBridge: () => bridge });
    const computer = new MobileComputerInterface({
      getBridge: () => bridge,
      getDisplay: () => androidDisplay(),
      getScene: () => scene,
    });
    let step = 0;
    const brain = new Brain(null, {
      invokeModel: async () => {
        step += 1;
        if (step === 1) {
          return JSON.stringify({
            scene_summary: "Save button visible",
            target_display_id: ANDROID_LOGICAL_DISPLAY_ID,
            roi: [],
            proposed_action: {
              kind: "click",
              ref: "a0-1",
              rationale: "tap save",
            },
          });
        }
        return JSON.stringify({
          scene_summary: "saved",
          target_display_id: ANDROID_LOGICAL_DISPLAY_ID,
          roi: [],
          proposed_action: { kind: "finish", rationale: "done" },
        });
      },
    });
    const report: ComputerUseAgentReport = await runComputerUseAgentLoop(
      null,
      { goal: "save the document", maxSteps: 5 },
      fakeService(scene),
      {
        brain,
        computerInterface: computer,
        captureAll: () => capture.captureAllDisplays(),
      },
    );
    expect(report.reason).toBe("finish");
    expect(report.finished).toBe(true);
    expect(report.steps.length).toBe(2);
    expect(report.steps[0]?.actionKind).toBe("click");
    expect(report.steps[1]?.actionKind).toBe("finish");
    expect(taps).toHaveLength(1);
    expect(taps[0]?.type).toBe("tap");
  });

  it("propagates a tap-failed bridge result as `reason: error`", async () => {
    const baseScene = buildScene();
    const failingBridge: AndroidComputerUseBridge = {
      ...makeFakeBridge().bridge,
      dispatchGesture: async () => ({
        ok: false,
        code: "accessibility_unavailable",
        message: "service off",
      }),
    } as AndroidComputerUseBridge;
    const capture = new MobileScreenCaptureSource({
      getBridge: () => failingBridge,
    });
    const computer = new MobileComputerInterface({
      getBridge: () => failingBridge,
      getDisplay: () => androidDisplay(),
      getScene: () => baseScene,
    });
    const brain = new Brain(null, {
      invokeModel: async () =>
        JSON.stringify({
          scene_summary: "S",
          target_display_id: ANDROID_LOGICAL_DISPLAY_ID,
          roi: [],
          proposed_action: {
            kind: "click",
            ref: "a0-1",
            rationale: "tap save",
          },
        }),
    });
    const report = await runComputerUseAgentLoop(
      null,
      { goal: "save", maxSteps: 2 },
      fakeService(baseScene),
      {
        brain,
        computerInterface: computer,
        captureAll: () => capture.captureAllDisplays(),
      },
    );
    expect(report.reason).toBe("error");
    expect(report.error).toMatch(/accessibility_unavailable/);
  });
});

describe("Mobile cascade — onTrimMemory → arbiter eviction → Brain reload", () => {
  it("dispatches `critical` pressure mid-cascade; Brain is re-invoked on the next call", async () => {
    let pressureListener: PressureListener | null = null;
    const { bridge } = makeFakeBridge({
      onMemoryPressure: (level, freeMb) => pressureListener?.(level, freeMb),
    });
    const scene = buildScene();
    const capture = new MobileScreenCaptureSource({ getBridge: () => bridge });
    const computer = new MobileComputerInterface({
      getBridge: () => bridge,
      getDisplay: () => androidDisplay(),
      getScene: () => scene,
    });

    // Track Brain calls + arbiter eviction effects.
    const brainCallTimes: number[] = [];
    let visionDescribeLoaded = true; // simulates the resident vision-describe model
    const evictionLog: Array<{ at: number; reason: string }> = [];

    // Stand-in arbiter: when pressure fires `critical`, evict vision-describe
    // and mark the next inference as a cold-load.
    pressureListener = (level) => {
      if (level === "critical" && visionDescribeLoaded) {
        visionDescribeLoaded = false;
        evictionLog.push({ at: Date.now(), reason: "memory-critical" });
      }
    };

    let pressureTriggered = false;
    const brain = new Brain(null, {
      invokeModel: async () => {
        brainCallTimes.push(Date.now());
        // After the first model call, simulate the system firing a memory
        // trim event from the bridge → JS layer.
        if (!pressureTriggered) {
          pressureTriggered = true;
          await bridge.dispatchMemoryPressure({
            level: "critical",
            freeMb: 32,
          });
        }
        // If the vision-describe model was evicted, the next Brain call
        // must reload it before responding — we model that as a Promise
        // delay so the order is observable.
        if (!visionDescribeLoaded) {
          await new Promise((r) => setTimeout(r, 1));
          visionDescribeLoaded = true; // re-loaded for this call
        }
        return JSON.stringify({
          scene_summary: "S",
          target_display_id: ANDROID_LOGICAL_DISPLAY_ID,
          roi: [],
          proposed_action: { kind: "wait", rationale: "wait" },
        });
      },
    });

    const cascade = new Cascade({ brain });
    const captures = new Map();
    for (const c of await capture.captureAllDisplays())
      captures.set(c.display.id, c);
    // First run: triggers the trim event after the model call.
    await cascade.run({ scene, goal: "g", captures });
    // Second run: must re-invoke the Brain (reload path).
    await cascade.run({ scene, goal: "g", captures });
    expect(brainCallTimes).toHaveLength(2);
    expect(evictionLog).toHaveLength(1);
    expect(evictionLog[0]?.reason).toBe("memory-critical");
    expect(visionDescribeLoaded).toBe(true);
  });

  it("dispatchMemoryPressure with `nominal` level does not trigger eviction", async () => {
    let evicted = 0;
    const { bridge } = makeFakeBridge({
      onMemoryPressure: (level) => {
        if (level === "critical") evicted += 1;
      },
    });
    await bridge.dispatchMemoryPressure({ level: "nominal", freeMb: 2048 });
    expect(evicted).toBe(0);
    await bridge.dispatchMemoryPressure({ level: "critical" });
    expect(evicted).toBe(1);
  });
});
