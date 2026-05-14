/**
 * WS7 ↔ WS9 — `IosComputerInterface` adapts the WS7 `ComputerInterface`
 * port to the iOS Capacitor `ComputerUse` plugin.
 *
 * iOS is fundamentally NOT a click-and-keyboard surface for third-party
 * apps. The only sanctioned UI driver is App Intents (Shortcuts-style
 * invocations). The mapping below reflects that — cascade dispatch
 * primitives that exist on Android (tap / swipe / type) throw a clear
 * "use invokeAppIntent" message on iOS.
 *
 * What *is* supported:
 *
 *   screenshot()             → drain one frame from `replayKitForegroundDrain`
 *                              (caller is responsible for having started a
 *                              session via `replayKitForegroundStart`).
 *   getScreenSize, coord     → metadata, no bridge call.
 *   getAccessibilityTree()   → scene-provided tree from WS6; iOS itself
 *                              cannot read cross-app AX, so this is
 *                              own-app only (`accessibilitySnapshot`).
 *   invokeAppIntent(...)     → the canonical iOS "action" — planner picks
 *                              an intent id + parameters, this method calls
 *                              `bridge.appIntentInvoke(...)`.
 *
 * What is NOT supported (and throws with a redirect message):
 *
 *   leftClick / rightClick / doubleClick / dragTo / drag / mouseDown /
 *   mouseUp / keyDown / keyUp / typeText / pressKey / hotkey / scroll
 *
 * The cascade detects iOS via the platform-capabilities probe and is
 * expected to plan in terms of `invokeAppIntent`, not synthetic taps. The
 * `IosComputerInterface.invokeAppIntent` accessor surfaces that contract
 * cleanly so callers don't have to reach into the raw Capacitor bridge.
 */

import { logger } from "@elizaos/core";
import type {
  ComputerInterface,
  CursorPosition,
  DisplayPoint,
  DragPath,
  MouseButton,
  ScreenshotResult,
  ScrollDelta,
} from "../actor/computer-interface.js";
import type { Scene, SceneAxNode } from "../scene/scene-types.js";
import type { DisplayDescriptor } from "../types.js";
import type {
  IntentInvocationRequest,
  IntentInvocationResult,
  IosBridgeResult,
  IosComputerUseBridge,
  ReplayKitForegroundFrame,
} from "./ios-bridge.js";

/**
 * Stable logical display id for the iOS phone screen. Mirrors the
 * Android convention (`ANDROID_LOGICAL_DISPLAY_ID = 0`) so the cascade
 * doesn't branch on platform for display selection — there's exactly
 * one logical display on iOS.
 */
export const IOS_LOGICAL_DISPLAY_ID = 0 as const;

/** Default physical bounds when the bridge hasn't reported a frame yet. */
const IOS_FALLBACK_BOUNDS: readonly [number, number, number, number] = [
  0, 0, 393, 852, // iPhone 15 logical points; the cascade re-derives from frames.
];

export interface IosComputerInterfaceDeps {
  /** Capacitor plugin handle (null when off-platform). */
  getBridge: () => IosComputerUseBridge | null;
  /** Latest scene accessor — used for `getAccessibilityTree`. */
  getScene?: () => Scene | null;
  /**
   * Active ReplayKit session id. The arbiter / scene-builder owns the
   * session lifecycle (start before cascade tick, stop when idle); this
   * interface only drains frames from it.
   */
  getReplayKitSessionId?: () => string | null;
  /** Display descriptor; iOS has exactly one logical display. */
  getDisplay?: () => DisplayDescriptor;
  /** Internal cursor-position state, mostly for tests. */
  cursorState?: { current: CursorPosition };
  /** Override JPEG decode (defaults to base64 → Buffer). */
  decodeJpeg?: (b64: string) => Buffer;
}

/**
 * iOS adapter implementing the WS7 `ComputerInterface`. All input-bearing
 * methods throw with a "use invokeAppIntent" redirect; metadata + the
 * screenshot path are functional.
 */
export class IosComputerInterface implements ComputerInterface {
  private readonly deps: IosComputerInterfaceDeps;
  private readonly cursorState: { current: CursorPosition };

  constructor(deps: IosComputerInterfaceDeps) {
    this.deps = deps;
    this.cursorState =
      deps.cursorState ?? {
        current: { displayId: IOS_LOGICAL_DISPLAY_ID, x: 0, y: 0 },
      };
  }

  // ── Screenshot ─────────────────────────────────────────────────────────────

  async screenshot(opts: { displayId?: number } = {}): Promise<ScreenshotResult> {
    this.requireDisplayId(opts.displayId);
    const bridge = this.requireBridge();
    const sessionId = this.deps.getReplayKitSessionId?.();
    if (!sessionId) {
      throw new Error(
        "[computeruse/ios] screenshot requires an active ReplayKit session — call replayKitForegroundStart first via the WS6 scene-capture orchestrator.",
      );
    }
    const result = unwrap(
      await bridge.replayKitForegroundDrain({ sessionId, max: 1 }),
      "replayKitForegroundDrain",
    );
    const frame: ReplayKitForegroundFrame | undefined = result.frames[0];
    if (!frame) {
      throw new Error(
        "[computeruse/ios] replayKitForegroundDrain returned no frames — caller must back off and retry next tick.",
      );
    }
    const decoded = (this.deps.decodeJpeg ?? defaultDecodeJpeg)(frame.jpegBase64);
    return {
      displayId: IOS_LOGICAL_DISPLAY_ID,
      frame: decoded,
      scaleFactor: 1,
      bounds: [0, 0, frame.width, frame.height],
    };
  }

  // ── Input-bearing primitives — all throw with a redirect to App Intents ──

  async mouseDown(point: DisplayPoint & { button?: MouseButton }): Promise<void> {
    this.refuseInput("mouseDown", point);
  }

  async mouseUp(point: DisplayPoint & { button?: MouseButton }): Promise<void> {
    this.refuseInput("mouseUp", point);
  }

  async leftClick(point: DisplayPoint): Promise<void> {
    this.refuseInput("leftClick", point);
  }

  async rightClick(point: DisplayPoint): Promise<void> {
    this.refuseInput("rightClick", point);
  }

  async doubleClick(point: DisplayPoint): Promise<void> {
    this.refuseInput("doubleClick", point);
  }

  async moveCursor(point: DisplayPoint): Promise<void> {
    // No-op (no cursor on iOS); we still update the tracker so downstream
    // metadata reads stay consistent with the planner's intent.
    this.requireDisplayId(point.displayId);
    this.requireFiniteCoords(point);
    this.cursorState.current = { ...point };
  }

  async dragTo(point: DisplayPoint): Promise<void> {
    this.refuseInput("dragTo", point);
  }

  async drag(path: DragPath): Promise<void> {
    this.refuseInput("drag", { displayId: path.displayId, x: 0, y: 0 });
  }

  async keyDown(args: { key: string }): Promise<void> {
    this.refuseKeyboard("keyDown", args.key);
  }

  async keyUp(args: { key: string }): Promise<void> {
    this.refuseKeyboard("keyUp", args.key);
  }

  async typeText(args: { text: string }): Promise<void> {
    this.refuseKeyboard("typeText", args.text.slice(0, 16));
  }

  async pressKey(args: { key: string }): Promise<void> {
    this.refuseKeyboard("pressKey", args.key);
  }

  async hotkey(args: { keys: string[] }): Promise<void> {
    this.refuseKeyboard("hotkey", args.keys.join("+"));
  }

  async scroll(delta: ScrollDelta): Promise<void> {
    this.refuseInput("scroll", {
      displayId: delta.displayId,
      x: delta.x,
      y: delta.y,
    });
  }

  async scrollUp(args: { displayId: number; clicks: number }): Promise<void> {
    this.refuseInput("scrollUp", { displayId: args.displayId, x: 0, y: 0 });
  }

  async scrollDown(args: { displayId: number; clicks: number }): Promise<void> {
    this.refuseInput("scrollDown", { displayId: args.displayId, x: 0, y: 0 });
  }

  // ── Metadata (no bridge call) ──────────────────────────────────────────────

  getScreenSize(_args: { displayId: number }): { w: number; h: number } {
    const display = this.getDisplay();
    return { w: display.bounds[2], h: display.bounds[3] };
  }

  getCursorPosition(): CursorPosition {
    return { ...this.cursorState.current };
  }

  toScreenCoordinates(args: {
    displayId: number;
    imgX: number;
    imgY: number;
    imgW: number;
    imgH: number;
  }): { x: number; y: number } {
    this.requireDisplayId(args.displayId);
    if (args.imgW <= 0 || args.imgH <= 0) {
      throw new Error(
        "[computeruse/ios] toScreenCoordinates requires positive image dimensions",
      );
    }
    const display = this.getDisplay();
    const sx = display.bounds[2] / args.imgW;
    const sy = display.bounds[3] / args.imgH;
    return {
      x: Math.round(args.imgX * sx),
      y: Math.round(args.imgY * sy),
    };
  }

  toScreenshotCoordinates(args: {
    displayId: number;
    x: number;
    y: number;
    imgW: number;
    imgH: number;
  }): { imgX: number; imgY: number } {
    this.requireDisplayId(args.displayId);
    const display = this.getDisplay();
    if (display.bounds[2] <= 0 || display.bounds[3] <= 0) {
      throw new Error(
        "[computeruse/ios] toScreenshotCoordinates: display has zero bounds",
      );
    }
    const sx = args.imgW / display.bounds[2];
    const sy = args.imgH / display.bounds[3];
    return {
      imgX: Math.round(args.x * sx),
      imgY: Math.round(args.y * sy),
    };
  }

  getAccessibilityTree(args: { displayId?: number }): SceneAxNode[] {
    const scene = this.deps.getScene?.() ?? null;
    if (!scene) return [];
    if (args.displayId === undefined) return scene.ax;
    return scene.ax.filter((n) => n.displayId === args.displayId);
  }

  // ── iOS-only: App Intent invocation (the sanctioned UI driver) ─────────────

  /**
   * Invoke an AppIntent through the bridge. This is the iOS-only addition
   * to the WS7 surface — it does not exist on Android/desktop because
   * those platforms have direct input. Cascade planners that detect iOS
   * via the platform-capabilities probe should plan in `invokeAppIntent`
   * terms (intent id + parameters) instead of `leftClick`.
   */
  async invokeAppIntent(
    request: IntentInvocationRequest,
  ): Promise<IntentInvocationResult> {
    const bridge = this.requireBridge();
    const result = await bridge.appIntentInvoke(request);
    if (!result.ok) {
      const err = result as { ok: false; code: string; message: string };
      throw new Error(
        `[computeruse/ios] appIntentInvoke(${request.intentId}) failed: ${err.code} — ${err.message}`,
      );
    }
    return result.data;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private refuseInput(method: string, point: DisplayPoint): never {
    logger.warn(
      `[computeruse/ios] ${method}(${point.x},${point.y}) refused — iOS has no third-party input dispatch. Plan in App Intents and call invokeAppIntent instead.`,
    );
    throw new Error(
      `[computeruse/ios] ${method} is not supported on iOS — use invokeAppIntent(intentId, parameters). See plugin-computeruse/docs/IOS_CONSTRAINTS.md.`,
    );
  }

  private refuseKeyboard(method: string, key: string): never {
    logger.warn(
      `[computeruse/ios] ${method}("${key}") refused — iOS has no third-party key dispatch.`,
    );
    throw new Error(
      `[computeruse/ios] ${method} is not supported on iOS — keyboards are app-local only. See plugin-computeruse/docs/IOS_CONSTRAINTS.md.`,
    );
  }

  private requireBridge(): IosComputerUseBridge {
    const bridge = this.deps.getBridge();
    if (!bridge) {
      throw new Error(
        "[computeruse/ios] Capacitor ComputerUse bridge is not registered (running off-platform?)",
      );
    }
    return bridge;
  }

  private requireDisplayId(id: number | undefined): void {
    const effective = id ?? IOS_LOGICAL_DISPLAY_ID;
    if (effective !== IOS_LOGICAL_DISPLAY_ID) {
      throw new Error(
        `[computeruse/ios] unknown iOS displayId ${effective}; only ${IOS_LOGICAL_DISPLAY_ID} is supported`,
      );
    }
  }

  private requireFiniteCoords(p: DisplayPoint): void {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new Error(
        `[computeruse/ios] non-finite coords (${p.x}, ${p.y})`,
      );
    }
  }

  private getDisplay(): DisplayDescriptor {
    if (this.deps.getDisplay) return this.deps.getDisplay();
    return {
      id: IOS_LOGICAL_DISPLAY_ID,
      bounds: [...IOS_FALLBACK_BOUNDS] as [number, number, number, number],
      scaleFactor: 1,
      primary: true,
      name: "ios-screen",
    };
  }
}

/** Convenience factory mirroring the Android side. */
export function makeIosComputerInterface(
  deps: IosComputerInterfaceDeps,
): IosComputerInterface {
  return new IosComputerInterface(deps);
}

function unwrap<T>(result: IosBridgeResult<T>, label: string): T {
  if (result.ok) return result.data;
  // Narrow to the failure arm explicitly — see ocr-provider.ts for the
  // strict-mode rationale.
  const failure = result as Extract<typeof result, { ok: false }>;
  throw new Error(
    `[computeruse/ios] ${label} failed: ${failure.code} — ${failure.message}`,
  );
}

function defaultDecodeJpeg(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}
