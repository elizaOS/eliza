/**
 * WS7 ↔ AOSP — Privileged-input actor stub.
 *
 * In the consumer build the cascade routes gestures through
 * `MobileComputerInterface` → `AccessibilityGestureDescription` — which is
 * coarse and blocks on touch-recognizer state in some apps (banking, DRM
 * video, anything that sets `filterTouchesWhenObscured`).
 *
 * In an AOSP system-app build (see `docs/AOSP_SYSTEM_APP.md`), the
 * privileged path uses `InputManager.injectInputEvent()` directly. That
 * path lives behind `AospPrivilegedBridge.injectMotionEvent(...)` on the
 * Kotlin side; the consumer-flavor `AospPrivilegedBridge` exports
 * `createIfAvailable(): null` so this actor stays inert until a real AOSP
 * bridge is linked in.
 *
 * `AospInputActor` maps a resolved WS7 `ProposedAction` (display-local
 * pixel coords) into the privileged-bridge calls. It does NOT implement
 * the `Actor` "grounding" contract — grounding stays with the OCR/AX or
 * VLM actor; this is purely an *input-dispatch* shim. It's surfaced as
 * an alternative to `ComputerInterface` for AOSP builds: the agent loop
 * picks `AospInputActor.execute(action)` instead of `dispatch(action, {
 * interface, ... })` when the privileged bridge is available.
 */

import { logger } from "@elizaos/core";
import type { ActionResult, ProposedAction } from "./types.js";

const DEFAULT_TAP_DURATION_MS = 50;
const DEFAULT_SWIPE_DURATION_MS = 300;

/** Minimal Kotlin-side surface this actor needs from the AOSP build. */
export interface AospPrivilegedInputBridge {
  /**
   * Inject a single motion event at the InputManager level. `action` follows
   * `MotionEvent.ACTION_*` constants (DOWN=0, UP=1, MOVE=2). `downTimeMs`
   * is the original-touch timestamp the gesture started at, in `uptimeMillis`
   * units. Implementations enforce the INJECT_EVENTS permission.
   */
  injectMotionEvent(args: {
    x: number;
    y: number;
    action: number;
    downTimeMs: number;
  }): Promise<{ ok: boolean }>;
  /** Capture the primary display frame buffer synchronously. JPEG bytes. */
  captureDisplayFrameBuffer?(): Promise<Uint8Array>;
}

export interface AospInputActorDeps {
  /** Returns the AOSP bridge handle, or null in consumer builds. */
  getBridge: () => AospPrivilegedInputBridge | null;
  /** Override the clock for tests. */
  now?: () => number;
}

/**
 * Motion-event action constants matching `android.view.MotionEvent.ACTION_*`.
 * Re-exported here so callers don't need to import Android Kotlin enums.
 */
export const MOTION_EVENT_ACTION_DOWN = 0 as const;
export const MOTION_EVENT_ACTION_UP = 1 as const;
export const MOTION_EVENT_ACTION_MOVE = 2 as const;

/**
 * Translate a cascade-resolved `ProposedAction` into one or more
 * `injectMotionEvent` calls. Returns the same `ActionResult` envelope the
 * desktop dispatcher uses — invalid args or driver errors do not throw.
 *
 * Behavior parity with `dispatch.ts`:
 *   - unknown action.kind → invalid_args
 *   - missing coords      → invalid_args
 *   - bridge throw        → driver_error
 *   - bridge ok:false     → driver_error
 *
 * Coverage:
 *   - click / double_click / right_click → tap(s)
 *   - drag                              → DOWN at start, MOVE/UP at end
 *   - scroll                            → swipe (DOWN, MOVE, UP)
 *   - wait / finish                     → success: true (no-op)
 *   - type / key / hotkey               → invalid_args (use AccessibilityNodeInfo
 *                                         or a separate keymap actor; out of
 *                                         scope for this stub).
 */
export class AospInputActor {
  readonly name = "aosp-input";

  constructor(private readonly deps: AospInputActorDeps) {}

  async execute(action: ProposedAction): Promise<ActionResult> {
    if (action.kind === "wait" || action.kind === "finish") {
      return { success: true, issued: action };
    }
    if (
      action.kind === "type" ||
      action.kind === "key" ||
      action.kind === "hotkey"
    ) {
      return {
        success: false,
        error: {
          code: "invalid_args",
          message: `[aosp-input] action.kind="${action.kind}" is not supported by the privileged-input path; use the AX-bridge ACTION_SET_TEXT/performGlobalAction path instead`,
        },
      };
    }
    const bridge = this.deps.getBridge();
    if (!bridge) {
      return {
        success: false,
        error: {
          code: "driver_error",
          message:
            "[aosp-input] AospPrivilegedBridge is not available; this build is consumer-flavor or the bridge failed to initialize",
        },
      };
    }
    if (
      action.kind === "click" ||
      action.kind === "double_click" ||
      action.kind === "right_click"
    ) {
      if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) {
        return invalidArgs(
          action,
          "click action requires finite (x, y) coords",
        );
      }
      const times = action.kind === "double_click" ? 2 : 1;
      try {
        for (let i = 0; i < times; i += 1) {
          await this.tap(bridge, action.x!, action.y!);
        }
      } catch (err) {
        return driverError(err);
      }
      return { success: true, issued: action };
    }
    if (action.kind === "scroll") {
      if (
        !Number.isFinite(action.x) ||
        !Number.isFinite(action.y) ||
        typeof action.dx !== "number" ||
        typeof action.dy !== "number"
      ) {
        return invalidArgs(
          action,
          "scroll requires (x, y) anchor and (dx, dy)",
        );
      }
      try {
        // Same sign convention as MobileComputerInterface: dy>0 means
        // "content scrolls down", which is a physical swipe UPWARD.
        await this.swipe(
          bridge,
          action.x!,
          action.y!,
          action.x! - action.dx * 200,
          action.y! - action.dy * 200,
          DEFAULT_SWIPE_DURATION_MS,
        );
      } catch (err) {
        return driverError(err);
      }
      return { success: true, issued: action };
    }
    if (action.kind === "drag") {
      if (
        !Number.isFinite(action.startX) ||
        !Number.isFinite(action.startY) ||
        !Number.isFinite(action.x) ||
        !Number.isFinite(action.y)
      ) {
        return invalidArgs(action, "drag requires startX/startY and x/y");
      }
      try {
        await this.swipe(
          bridge,
          action.startX!,
          action.startY!,
          action.x!,
          action.y!,
          DEFAULT_SWIPE_DURATION_MS,
        );
      } catch (err) {
        return driverError(err);
      }
      return { success: true, issued: action };
    }
    return invalidArgs(
      action,
      `unknown action kind "${(action as ProposedAction).kind}"`,
    );
  }

  private async tap(
    bridge: AospPrivilegedInputBridge,
    x: number,
    y: number,
  ): Promise<void> {
    const downTime = this.now();
    await this.must(
      bridge.injectMotionEvent({
        x,
        y,
        action: MOTION_EVENT_ACTION_DOWN,
        downTimeMs: downTime,
      }),
      "DOWN",
    );
    await this.must(
      bridge.injectMotionEvent({
        x,
        y,
        action: MOTION_EVENT_ACTION_UP,
        downTimeMs: downTime + DEFAULT_TAP_DURATION_MS,
      }),
      "UP",
    );
  }

  private async swipe(
    bridge: AospPrivilegedInputBridge,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
  ): Promise<void> {
    const downTime = this.now();
    await this.must(
      bridge.injectMotionEvent({
        x: x1,
        y: y1,
        action: MOTION_EVENT_ACTION_DOWN,
        downTimeMs: downTime,
      }),
      "DOWN",
    );
    await this.must(
      bridge.injectMotionEvent({
        x: (x1 + x2) / 2,
        y: (y1 + y2) / 2,
        action: MOTION_EVENT_ACTION_MOVE,
        downTimeMs: downTime + Math.floor(durationMs / 2),
      }),
      "MOVE",
    );
    await this.must(
      bridge.injectMotionEvent({
        x: x2,
        y: y2,
        action: MOTION_EVENT_ACTION_UP,
        downTimeMs: downTime + durationMs,
      }),
      "UP",
    );
  }

  private async must(
    p: Promise<{ ok: boolean }>,
    phase: string,
  ): Promise<void> {
    const result = await p;
    if (!result.ok) {
      throw new Error(
        `[aosp-input] injectMotionEvent ${phase} returned ok:false`,
      );
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}

function invalidArgs(action: ProposedAction, message: string): ActionResult {
  return {
    success: false,
    error: {
      code: "invalid_args",
      message: `${message} (action.kind=${action.kind})`,
    },
  };
}

function driverError(err: unknown): ActionResult {
  const message = err instanceof Error ? err.message : String(err);
  logger.warn(`[aosp-input] driver error: ${message}`);
  return {
    success: false,
    error: {
      code: "driver_error",
      message,
    },
  };
}
