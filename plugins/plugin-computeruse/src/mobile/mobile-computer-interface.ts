/**
 * WS7 ↔ WS8 — `MobileComputerInterface` adapts the WS7 `ComputerInterface`
 * port to the Android `AndroidComputerUseBridge` so the cascade + dispatcher
 * run unchanged on mobile.
 *
 * Mapping (display-local pixel coords → Android screen-pixel gestures):
 *
 *   leftClick({x, y})          → dispatchGesture({type:"tap", x, y})
 *   doubleClick({x, y})        → dispatchGesture(tap) twice (no native double-tap)
 *   rightClick({x, y})         → dispatchGesture(tap) [no right-click on Android;
 *                                cascade should prefer longClick semantics via
 *                                the AX node's `longClick` action]
 *   dragTo({x, y}) / drag(path)→ dispatchGesture({type:"swipe", x1,y1,x2,y2})
 *   scroll({x, y, dx, dy})     → dispatchGesture(swipe) anchored at (x, y),
 *                                direction inverted (scrolling DOWN visually
 *                                means swiping UP physically)
 *   pressKey({key:"back"})     → performGlobalAction("back")
 *   pressKey({key:"home"})     → performGlobalAction("home")
 *   hotkey                     → not supported on Android; throws
 *   typeText                   → setText({text}) against the focused editable
 *                                AccessibilityNodeInfo.
 *
 * `getScreenSize`, `getCursorPosition`, and the coord-conversion helpers
 * keep their desktop behavior — they're metadata calls, not input.
 *
 * Errors:
 *   Every method that calls the bridge propagates `ok:false` as a thrown
 *   `Error` whose message carries the `code` + `message`. The WS7 dispatcher
 *   maps that to `ActionResult.error.driver_error`, exactly like desktop.
 */

import { logger } from "@elizaos/core";
import type { Scene, SceneAxNode } from "../scene/scene-types.js";
import type { DisplayDescriptor } from "../types.js";
import type {
  AndroidBridgeResult,
  AndroidComputerUseBridge,
  GestureArgs,
} from "./android-bridge.js";
import type {
  ComputerInterface,
  CursorPosition,
  DisplayPoint,
  DragPath,
  MouseButton,
  ScreenshotResult,
  ScrollDelta,
} from "../actor/computer-interface.js";
import { ANDROID_LOGICAL_DISPLAY_ID } from "./mobile-screen-capture.js";

const SCROLL_PIXELS_PER_CLICK = 200;
const DEFAULT_SWIPE_DURATION_MS = 300;

export interface MobileComputerInterfaceDeps {
  /** Capacitor plugin handle (null when off-platform). */
  getBridge: () => AndroidComputerUseBridge | null;
  /** Latest scene accessor — used for `getAccessibilityTree`. */
  getScene?: () => Scene | null;
  /** Display descriptor; mobile devices have exactly one. */
  getDisplay?: () => DisplayDescriptor;
  /** Internal cursor-position state, mostly for tests. */
  cursorState?: { current: CursorPosition };
  /**
   * Override fetched screenshot bytes. Defaults to a one-shot
   * `bridge.captureFrame()` so the cascade's pull contract just works.
   */
  decodeJpeg?: (b64: string) => Buffer;
  /**
   * Map a WS7 key name (`"back"`, `"home"`, `"recents"`, `"notifications"`)
   * to an Android `performGlobalAction` invocation. Other keys throw —
   * Android has no equivalent of arbitrary keystrokes from a non-system app.
   */
  globalActionMap?: ReadonlyMap<string, "back" | "home" | "recents" | "notifications">;
}

export class MobileComputerInterface implements ComputerInterface {
  private readonly deps: MobileComputerInterfaceDeps;
  private readonly cursorState: { current: CursorPosition };

  constructor(deps: MobileComputerInterfaceDeps) {
    this.deps = deps;
    this.cursorState =
      deps.cursorState ?? {
        current: { displayId: ANDROID_LOGICAL_DISPLAY_ID, x: 0, y: 0 },
      };
  }

  // ── Screenshot ──────────────────────────────────────────────────────────────

  async screenshot(opts: { displayId?: number } = {}): Promise<ScreenshotResult> {
    this.requireDisplayId(opts.displayId);
    const bridge = this.requireBridge();
    const result = unwrap(await bridge.captureFrame(), "captureFrame");
    const decoded = (this.deps.decodeJpeg ?? defaultDecodeJpeg)(result.jpegBase64);
    return {
      displayId: ANDROID_LOGICAL_DISPLAY_ID,
      frame: decoded,
      scaleFactor: 1,
      bounds: [0, 0, result.width, result.height],
    };
  }

  // ── Mouse-style primitives (mapped to AccessibilityGestureDescription) ─────

  async mouseDown(point: DisplayPoint & { button?: MouseButton }): Promise<void> {
    // Android has no notion of a held-down pointer that survives an API call.
    // For Brain-issued primitives we fold to a synthetic moveCursor — the
    // higher-level cascade should prefer leftClick / drag.
    this.moveTracker(point);
  }

  async mouseUp(point: DisplayPoint & { button?: MouseButton }): Promise<void> {
    this.moveTracker(point);
  }

  async leftClick(point: DisplayPoint): Promise<void> {
    await this.dispatchTap(point);
  }

  async rightClick(point: DisplayPoint): Promise<void> {
    logger.warn(
      "[computeruse/mobile] rightClick has no native Android equivalent; falling back to tap. Use the AX node's longClick action explicitly when possible.",
    );
    await this.dispatchTap(point);
  }

  async doubleClick(point: DisplayPoint): Promise<void> {
    // Android does not expose a "double tap" gesture; we issue two taps
    // back-to-back. The interval is short enough that most apps treat it as
    // a real double-tap, but it isn't strictly guaranteed.
    await this.dispatchTap(point);
    await this.dispatchTap(point);
  }

  async moveCursor(point: DisplayPoint): Promise<void> {
    // No on-screen cursor. We track the position so `dragTo` can compute a
    // start point, but no gesture fires.
    this.moveTracker(point);
  }

  async dragTo(point: DisplayPoint): Promise<void> {
    const start = this.cursorState.current;
    if (start.displayId !== point.displayId) {
      throw new Error(
        `[computeruse/mobile] drag across displays not supported (${start.displayId} -> ${point.displayId})`,
      );
    }
    await this.dispatchSwipe(
      { displayId: point.displayId, x: start.x, y: start.y },
      point,
    );
    this.cursorState.current = { ...point };
  }

  async drag(path: DragPath): Promise<void> {
    if (path.path.length < 2) {
      throw new Error(
        "[computeruse/mobile] drag path requires at least two points",
      );
    }
    const start = path.path[0]!;
    const end = path.path[path.path.length - 1]!;
    await this.dispatchSwipe(
      { displayId: path.displayId, x: start.x, y: start.y },
      { displayId: path.displayId, x: end.x, y: end.y },
    );
    this.cursorState.current = { displayId: path.displayId, x: end.x, y: end.y };
  }

  // ── Keyboard / global actions ───────────────────────────────────────────────

  async keyDown(args: { key: string }): Promise<void> {
    // Android has no down/up split for the buttons we route here; collapse
    // into a single pressKey call.
    await this.pressKey(args);
  }

  async keyUp(_args: { key: string }): Promise<void> {
    /* paired with keyDown via globalAction — no-op. */
  }

  async typeText(args: { text: string }): Promise<void> {
    const bridge = this.requireBridge();
    const result = unwrap(await bridge.setText({ text: args.text }), "setText");
    if (!result.ok) {
      throw new Error(
        "[computeruse/mobile] setText failed: no focused editable accessibility node",
      );
    }
  }

  async pressKey(args: { key: string }): Promise<void> {
    const action = this.resolveGlobalAction(args.key);
    if (!action) {
      throw new Error(
        `[computeruse/mobile] pressKey "${args.key}" has no Android equivalent; only back/home/recents/notifications are supported`,
      );
    }
    const bridge = this.requireBridge();
    unwrap(await bridge.performGlobalAction({ action }), `performGlobalAction(${action})`);
  }

  async hotkey(_args: { keys: string[] }): Promise<void> {
    throw new Error(
      "[computeruse/mobile] hotkey is not supported on Android (no system-app keymap API in the consumer build)",
    );
  }

  // ── Scroll (mapped to a swipe gesture) ─────────────────────────────────────

  async scroll(delta: ScrollDelta): Promise<void> {
    // The cascade calls scroll with `dy>0` meaning "content should scroll
    // down" — i.e. the user is reading more content. On a touchscreen that
    // is a physical swipe UPWARD. We invert sign here so the planner output
    // matches the desktop semantics.
    const display = this.getDisplay();
    const startX = delta.x;
    const startY = delta.y;
    const endX = clamp(
      startX - delta.dx * SCROLL_PIXELS_PER_CLICK,
      0,
      display.bounds[2] - 1,
    );
    const endY = clamp(
      startY - delta.dy * SCROLL_PIXELS_PER_CLICK,
      0,
      display.bounds[3] - 1,
    );
    if (endX === startX && endY === startY) return; // dx=dy=0 → no-op
    const bridge = this.requireBridge();
    const args: GestureArgs = {
      type: "swipe",
      x: startX,
      y: startY,
      x2: endX,
      y2: endY,
      durationMs: DEFAULT_SWIPE_DURATION_MS,
    };
    unwrap(await bridge.dispatchGesture(args), "scroll/swipe");
  }

  async scrollUp(args: { displayId: number; clicks: number }): Promise<void> {
    const display = this.getDisplay();
    const cx = Math.round(display.bounds[2] / 2);
    const cy = Math.round(display.bounds[3] / 2);
    await this.scroll({ displayId: args.displayId, x: cx, y: cy, dx: 0, dy: -Math.abs(args.clicks) });
  }

  async scrollDown(args: { displayId: number; clicks: number }): Promise<void> {
    const display = this.getDisplay();
    const cx = Math.round(display.bounds[2] / 2);
    const cy = Math.round(display.bounds[3] / 2);
    await this.scroll({ displayId: args.displayId, x: cx, y: cy, dx: 0, dy: Math.abs(args.clicks) });
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
        "[computeruse/mobile] toScreenCoordinates requires positive image dimensions",
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
        "[computeruse/mobile] toScreenshotCoordinates: display has zero bounds",
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

  // ── Internals ──────────────────────────────────────────────────────────────

  private async dispatchTap(point: DisplayPoint): Promise<void> {
    this.requireDisplayId(point.displayId);
    this.requireFiniteCoords(point);
    const bridge = this.requireBridge();
    const args: GestureArgs = { type: "tap", x: point.x, y: point.y };
    unwrap(await bridge.dispatchGesture(args), "tap");
    this.cursorState.current = { ...point };
  }

  private async dispatchSwipe(from: DisplayPoint, to: DisplayPoint): Promise<void> {
    this.requireDisplayId(from.displayId);
    this.requireDisplayId(to.displayId);
    this.requireFiniteCoords(from);
    this.requireFiniteCoords(to);
    const bridge = this.requireBridge();
    const args: GestureArgs = {
      type: "swipe",
      x: from.x,
      y: from.y,
      x2: to.x,
      y2: to.y,
      durationMs: DEFAULT_SWIPE_DURATION_MS,
    };
    unwrap(await bridge.dispatchGesture(args), "swipe");
  }

  private moveTracker(point: DisplayPoint): void {
    this.requireDisplayId(point.displayId);
    this.requireFiniteCoords(point);
    this.cursorState.current = { ...point };
  }

  private requireBridge(): AndroidComputerUseBridge {
    const bridge = this.deps.getBridge();
    if (!bridge) {
      throw new Error(
        "[computeruse/mobile] Capacitor ComputerUse bridge is not registered",
      );
    }
    return bridge;
  }

  private requireDisplayId(id: number | undefined): void {
    const effective = id ?? ANDROID_LOGICAL_DISPLAY_ID;
    if (effective !== ANDROID_LOGICAL_DISPLAY_ID) {
      throw new Error(
        `[computeruse/mobile] unknown Android displayId ${effective}; only ${ANDROID_LOGICAL_DISPLAY_ID} is supported`,
      );
    }
  }

  private requireFiniteCoords(p: DisplayPoint): void {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new Error(
        `[computeruse/mobile] non-finite coords (${p.x}, ${p.y})`,
      );
    }
  }

  private resolveGlobalAction(
    key: string,
  ): "back" | "home" | "recents" | "notifications" | null {
    if (this.deps.globalActionMap) {
      return this.deps.globalActionMap.get(key) ?? null;
    }
    switch (key.toLowerCase()) {
      case "back":
      case "escape":
        return "back";
      case "home":
        return "home";
      case "recents":
      case "task":
        return "recents";
      case "notifications":
        return "notifications";
      default:
        return null;
    }
  }

  private getDisplay(): DisplayDescriptor {
    if (this.deps.getDisplay) return this.deps.getDisplay();
    return {
      id: ANDROID_LOGICAL_DISPLAY_ID,
      bounds: [0, 0, 1080, 1920],
      scaleFactor: 1,
      primary: true,
      name: "android-screen",
    };
  }
}

/** Convenience factory. */
export function makeMobileComputerInterface(
  deps: MobileComputerInterfaceDeps,
): ComputerInterface {
  return new MobileComputerInterface(deps);
}

function unwrap<T>(result: AndroidBridgeResult<T>, label: string): T {
  if (result.ok) return result.data;
  const err = result as { ok: false; code: string; message: string };
  throw new Error(
    `[computeruse/mobile] ${label} failed: ${err.code} — ${err.message}`,
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(Math.round(v), lo), hi);
}

function defaultDecodeJpeg(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}
