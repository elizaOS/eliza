/**
 * WS7 — BaseComputerInterface (TypeScript port).
 *
 * Shape ported from trycua/cua's `BaseComputerInterface` (MIT). The original
 * provides one unified API surface for screenshot + mouse + keyboard + screen
 * geometry that the Brain/Actor cascade can call without knowing what OS or
 * driver is underneath.
 *
 *   Origin: https://github.com/trycua/cua/blob/main/libs/python/computer/
 *           computer/interface/base.py
 *   License: MIT, Copyright (c) 2025 trycua
 *
 * This is NOT a verbatim re-implementation — Milady's underlying drivers
 * (`platform/driver.ts`, `platform/capture.ts`) already cover most of the same
 * surface. We give the cascade one well-typed seam so tests can swap in a
 * fake driver, and so the Brain doesn't need to know about display-id
 * resolution, retina scaling, or coord-source switches.
 *
 * Coordinate contract (matches WS5):
 *   - Every method that takes `(displayId, x, y)` uses LOCAL pixel coords for
 *     that display. The interface routes those through the configured display
 *     layout before any input fires.
 *   - VLMs producing coords in image-space (i.e. against the downscaled max-
 *     pixels frame) MUST first call `toScreenCoordinates(...)` to get the
 *     real OS-pixel coord. The inverse `toScreenshotCoordinates(...)` is for
 *     logging / replay.
 *   - `displayId` must be a known display from `listDisplays()`. Unknown ids
 *     throw — this is the safety net the dispatch layer relies on.
 */

import { logger } from "@elizaos/core";
import { captureDisplay, type DisplayCapture } from "../platform/capture.js";
import {
  getPrimaryDisplay,
  listDisplays,
} from "../platform/displays.js";
import {
  driverClick,
  driverDoubleClick,
  driverDrag,
  driverKeyCombo,
  driverKeyPress,
  driverMouseMove,
  driverRightClick,
  driverScroll,
  driverType,
} from "../platform/driver.js";
import type { DisplayDescriptor } from "../types.js";
import type { Scene, SceneAxNode } from "../scene/scene-types.js";

/** A POSIX-style mouse button. */
export type MouseButton = "left" | "middle" | "right";

export interface ScreenshotResult {
  displayId: number;
  /** PNG bytes at backing-store resolution. */
  frame: Buffer;
  /** Backing-store / logical-pixel ratio. */
  scaleFactor: number;
  /** [x, y, w, h] in OS-global pixel space, for the display this frame belongs to. */
  bounds: [number, number, number, number];
}

export interface DisplayPoint {
  displayId: number;
  /** LOCAL pixel coords inside the display's logical bounds. */
  x: number;
  y: number;
}

export interface DragPath {
  displayId: number;
  path: Array<{ x: number; y: number }>;
}

export interface ScrollDelta {
  displayId: number;
  x: number;
  y: number;
  /** Negative = scroll up/left, positive = scroll down/right. */
  dx: number;
  dy: number;
}

export interface CursorPosition {
  displayId: number;
  x: number;
  y: number;
}

/**
 * The single seam the cascade calls. All methods are safe to await
 * concurrently within one display (driver semantics permitting); callers
 * serialize at the dispatch layer.
 */
export interface ComputerInterface {
  screenshot(opts?: { displayId?: number }): Promise<ScreenshotResult>;
  mouseDown(point: DisplayPoint & { button?: MouseButton }): Promise<void>;
  mouseUp(point: DisplayPoint & { button?: MouseButton }): Promise<void>;
  leftClick(point: DisplayPoint): Promise<void>;
  rightClick(point: DisplayPoint): Promise<void>;
  doubleClick(point: DisplayPoint): Promise<void>;
  moveCursor(point: DisplayPoint): Promise<void>;
  dragTo(point: DisplayPoint): Promise<void>;
  drag(path: DragPath): Promise<void>;
  keyDown(args: { key: string }): Promise<void>;
  keyUp(args: { key: string }): Promise<void>;
  typeText(args: { text: string }): Promise<void>;
  pressKey(args: { key: string }): Promise<void>;
  hotkey(args: { keys: string[] }): Promise<void>;
  scroll(delta: ScrollDelta): Promise<void>;
  scrollUp(args: { displayId: number; clicks: number }): Promise<void>;
  scrollDown(args: { displayId: number; clicks: number }): Promise<void>;
  getScreenSize(args: { displayId: number }): { w: number; h: number };
  getCursorPosition(): CursorPosition;

  /**
   * Convert from VLM-image-space (the downscaled max-pixels frame the model
   * was shown) into OS-LOCAL-pixel-space for the same display.
   *
   * `(imgX, imgY)` are pixel coords inside an `imgW × imgH` image. Returned
   * `(x, y)` are the same physical point but in the display's logical bounds.
   */
  toScreenCoordinates(args: {
    displayId: number;
    imgX: number;
    imgY: number;
    imgW: number;
    imgH: number;
  }): { x: number; y: number };

  /** Inverse of `toScreenCoordinates`. */
  toScreenshotCoordinates(args: {
    displayId: number;
    x: number;
    y: number;
    imgW: number;
    imgH: number;
  }): { imgX: number; imgY: number };

  /**
   * Return the AX (accessibility) tree the scene-builder snapshot already
   * collected. We don't re-snapshot here — that's WS6's job. Cascade calls
   * this to enumerate clickable AX nodes by display.
   */
  getAccessibilityTree(args: { displayId?: number }): SceneAxNode[];
}

/**
 * Reference implementation that delegates to `platform/driver.ts` and
 * `platform/capture.ts`. The constructor takes a `Scene` accessor so the
 * AX tree is read from the latest WS6 snapshot without re-walking the OS.
 */
export interface ComputerInterfaceDeps {
  /** Latest scene accessor — used for `getAccessibilityTree`. */
  getScene?: () => Scene | null;
  /** Capture override (mostly for tests). */
  capture?: (displayId: number) => Promise<DisplayCapture>;
  /** Driver overrides for tests. */
  driver?: Partial<{
    click: (x: number, y: number) => Promise<void>;
    doubleClick: (x: number, y: number) => Promise<void>;
    rightClick: (x: number, y: number) => Promise<void>;
    mouseMove: (x: number, y: number) => Promise<void>;
    drag: (x1: number, y1: number, x2: number, y2: number) => Promise<void>;
    scroll: (
      x: number,
      y: number,
      direction: "up" | "down" | "left" | "right",
      amount: number,
    ) => Promise<void>;
    type: (text: string) => Promise<void>;
    keyPress: (key: string) => Promise<void>;
    keyCombo: (combo: string) => Promise<void>;
  }>;
  listDisplays?: () => DisplayDescriptor[];
  /**
   * Where the implementation should remember the last cursor target.
   * Set whenever a movement-bearing call resolves successfully.
   */
  cursorState?: { current: CursorPosition };
}

export class DefaultComputerInterface implements ComputerInterface {
  private readonly deps: Required<Omit<ComputerInterfaceDeps, "driver" | "getScene">> & {
    driver: ComputerInterfaceDeps["driver"];
    getScene: ComputerInterfaceDeps["getScene"];
  };

  constructor(deps: ComputerInterfaceDeps = {}) {
    const listDisplaysFn =
      deps.listDisplays ??
      (() =>
        listDisplays().map((d) => ({
          id: d.id,
          bounds: d.bounds,
          scaleFactor: d.scaleFactor,
          primary: d.primary,
          name: d.name,
        })));
    const primary = (() => {
      const displays = listDisplaysFn();
      const configuredPrimary = displays.find((d) => d.primary) ?? displays[0];
      if (configuredPrimary) return configuredPrimary;
      try {
        return getPrimaryDisplay();
      } catch {
        return { id: 0 } as DisplayDescriptor;
      }
    })();
    this.deps = {
      getScene: deps.getScene,
      capture: deps.capture ?? captureDisplay,
      listDisplays: listDisplaysFn,
      cursorState:
        deps.cursorState ?? { current: { displayId: primary.id, x: 0, y: 0 } },
      driver: deps.driver,
    };
  }

  async screenshot(opts: { displayId?: number } = {}): Promise<ScreenshotResult> {
    const displayId = opts.displayId ?? this.primaryId();
    const captured = await this.deps.capture(displayId);
    return {
      displayId: captured.display.id,
      frame: captured.frame,
      scaleFactor: captured.display.scaleFactor,
      bounds: captured.display.bounds,
    };
  }

  async mouseDown(point: DisplayPoint & { button?: MouseButton }): Promise<void> {
    // Lower-level mouseDown/mouseUp aren't exposed by the existing driver
    // (which composes them into click/drag). For Brain-issued primitives we
    // route a synthetic mouse-move + click; the cascade rarely needs
    // separate down/up except for selection drags, which use `drag()`.
    await this.moveCursor(point);
    logger.debug("[computeruse/actor] mouseDown synthesized as moveCursor + click pending");
  }

  async mouseUp(point: DisplayPoint & { button?: MouseButton }): Promise<void> {
    await this.moveCursor(point);
    logger.debug("[computeruse/actor] mouseUp synthesized as moveCursor");
  }

  async leftClick(point: DisplayPoint): Promise<void> {
    const g = this.toGlobalChecked(point);
    const fn = this.deps.driver?.click ?? driverClick;
    await fn(g.x, g.y);
    this.deps.cursorState.current = { ...point };
  }

  async rightClick(point: DisplayPoint): Promise<void> {
    const g = this.toGlobalChecked(point);
    const fn = this.deps.driver?.rightClick ?? driverRightClick;
    await fn(g.x, g.y);
    this.deps.cursorState.current = { ...point };
  }

  async doubleClick(point: DisplayPoint): Promise<void> {
    const g = this.toGlobalChecked(point);
    const fn = this.deps.driver?.doubleClick ?? driverDoubleClick;
    await fn(g.x, g.y);
    this.deps.cursorState.current = { ...point };
  }

  async moveCursor(point: DisplayPoint): Promise<void> {
    const g = this.toGlobalChecked(point);
    const fn = this.deps.driver?.mouseMove ?? driverMouseMove;
    await fn(g.x, g.y);
    this.deps.cursorState.current = { ...point };
  }

  async dragTo(point: DisplayPoint): Promise<void> {
    const start = this.deps.cursorState.current;
    if (start.displayId !== point.displayId) {
      throw new Error(
        `[computeruse/actor] drag across displays not supported (${start.displayId} -> ${point.displayId})`,
      );
    }
    const startG = this.toGlobalChecked(start);
    const endG = this.toGlobalChecked(point);
    const fn = this.deps.driver?.drag ?? driverDrag;
    await fn(startG.x, startG.y, endG.x, endG.y);
    this.deps.cursorState.current = { ...point };
  }

  async drag(args: DragPath): Promise<void> {
    if (args.path.length < 2) {
      throw new Error(
        "[computeruse/actor] drag path requires at least two points",
      );
    }
    // Driver doesn't expose multi-segment polylines; fall back to start→end.
    const start = args.path[0]!;
    const end = args.path[args.path.length - 1]!;
    const startG = this.toGlobalChecked({ displayId: args.displayId, x: start.x, y: start.y });
    const endG = this.toGlobalChecked({ displayId: args.displayId, x: end.x, y: end.y });
    const fn = this.deps.driver?.drag ?? driverDrag;
    await fn(startG.x, startG.y, endG.x, endG.y);
    this.deps.cursorState.current = { displayId: args.displayId, x: end.x, y: end.y };
  }

  async keyDown(args: { key: string }): Promise<void> {
    // Driver pairs keyDown/keyUp inside keyPress. Synthesize via keyPress
    // here; the cascade should prefer `pressKey` for single-shot input.
    const fn = this.deps.driver?.keyPress ?? driverKeyPress;
    await fn(args.key);
  }

  async keyUp(_args: { key: string }): Promise<void> {
    /* paired with keyDown via the driver — no-op here. */
  }

  async typeText(args: { text: string }): Promise<void> {
    const fn = this.deps.driver?.type ?? driverType;
    await fn(args.text);
  }

  async pressKey(args: { key: string }): Promise<void> {
    const fn = this.deps.driver?.keyPress ?? driverKeyPress;
    await fn(args.key);
  }

  async hotkey(args: { keys: string[] }): Promise<void> {
    if (args.keys.length === 0) {
      throw new Error("[computeruse/actor] hotkey requires at least one key");
    }
    const combo = args.keys.join("+");
    const fn = this.deps.driver?.keyCombo ?? driverKeyCombo;
    await fn(combo);
  }

  async scroll(delta: ScrollDelta): Promise<void> {
    const g = this.toGlobalChecked({ displayId: delta.displayId, x: delta.x, y: delta.y });
    const fn = this.deps.driver?.scroll ?? driverScroll;
    if (delta.dy !== 0) {
      const direction = delta.dy > 0 ? "down" : "up";
      await fn(g.x, g.y, direction, Math.abs(delta.dy));
    }
    if (delta.dx !== 0) {
      const direction = delta.dx > 0 ? "right" : "left";
      await fn(g.x, g.y, direction, Math.abs(delta.dx));
    }
  }

  async scrollUp(args: { displayId: number; clicks: number }): Promise<void> {
    const display = this.requireDisplay(args.displayId);
    const cx = Math.round(display.bounds[2] / 2);
    const cy = Math.round(display.bounds[3] / 2);
    await this.scroll({ displayId: args.displayId, x: cx, y: cy, dx: 0, dy: -Math.abs(args.clicks) });
  }

  async scrollDown(args: { displayId: number; clicks: number }): Promise<void> {
    const display = this.requireDisplay(args.displayId);
    const cx = Math.round(display.bounds[2] / 2);
    const cy = Math.round(display.bounds[3] / 2);
    await this.scroll({ displayId: args.displayId, x: cx, y: cy, dx: 0, dy: Math.abs(args.clicks) });
  }

  getScreenSize(args: { displayId: number }): { w: number; h: number } {
    const display = this.requireDisplay(args.displayId);
    return { w: display.bounds[2], h: display.bounds[3] };
  }

  getCursorPosition(): CursorPosition {
    return { ...this.deps.cursorState.current };
  }

  toScreenCoordinates(args: {
    displayId: number;
    imgX: number;
    imgY: number;
    imgW: number;
    imgH: number;
  }): { x: number; y: number } {
    const display = this.requireDisplay(args.displayId);
    if (args.imgW <= 0 || args.imgH <= 0) {
      throw new Error(
        "[computeruse/actor] toScreenCoordinates requires positive image dimensions",
      );
    }
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
    const display = this.requireDisplay(args.displayId);
    if (display.bounds[2] <= 0 || display.bounds[3] <= 0) {
      throw new Error(
        "[computeruse/actor] toScreenshotCoordinates: display has zero bounds",
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

  private primaryId(): number {
    const ds = this.deps.listDisplays();
    return ds.find((d) => d.primary)?.id ?? ds[0]?.id ?? 0;
  }

  private requireDisplay(displayId: number): DisplayDescriptor {
    const d = this.deps.listDisplays().find((x) => x.id === displayId);
    if (!d) {
      const known = this.deps
        .listDisplays()
        .map((x) => `${x.id}(${x.name})`)
        .join(", ");
      throw new Error(
        `[computeruse/actor] unknown displayId ${displayId}. Known: ${known}`,
      );
    }
    return d;
  }

  private toGlobalChecked(point: DisplayPoint): { x: number; y: number } {
    const d = this.requireDisplay(point.displayId);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error(
        `[computeruse/actor] non-finite coords (${point.x}, ${point.y})`,
      );
    }
    return {
      x: Math.round(d.bounds[0] + point.x),
      y: Math.round(d.bounds[1] + point.y),
    };
  }
}

/** Convenience factory used by the cascade. */
export function makeComputerInterface(
  deps: ComputerInterfaceDeps = {},
): ComputerInterface {
  return new DefaultComputerInterface(deps);
}
