/**
 * Humanized input layer — clean-room reimplementation (Apache-2.0) of the
 * "humanized mouse motion" technique used to defeat Google Meet's
 * synthetic-input detection. No third-party source or recorded data is used;
 * the mocap library is procedurally generated from a min-jerk motion model
 * with a seeded PRNG (see mocap.ts).
 *
 * Google Meet flags Playwright/CDP clicks (isTrusted=false, no real pointer
 * motion). Two drivers satisfy the `InputDriver` seam:
 *  - PlaywrightInputDriver — humanized mouse.move stepping + click. Works
 *    everywhere Playwright runs (macOS dev, Linux CI). Events remain
 *    isTrusted=false but carry genuine MotionNotify-style step trajectories.
 *  - XtestInputDriver — real OS-level XTEST input via xdotool on Linux/X11.
 *    Events are delivered by the X server itself (isTrusted=true), the signal
 *    Meet keys on. Only available when DISPLAY + xdotool are present.
 */

import type { ElementHandle, Page } from "playwright-core";

/** Relative pointer delta with pre-move dwell (seconds). */
export interface MocapMovement {
  dx: number;
  dy: number;
  /** Seconds to wait BEFORE issuing this move. */
  dt: number;
}

/** One recorded-style trajectory + click timing. */
export interface MocapSequence {
  movements: MocapMovement[];
  total_dx: number;
  total_dy: number;
  /** Seconds between arrival and button-down. */
  click_down_dt: number;
  /** Seconds button held before release. */
  click_up_dt: number;
}

export interface MocapLibrary {
  meta: Record<string, unknown>;
  sequences: MocapSequence[];
}

/** Absolute device-pixel rectangle (X-screen space). */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * A pluggable pointer/keyboard input backend. Meet join clicks and name entry
 * route through this so the concrete mechanism (synthetic vs XTEST) is chosen
 * once at construction and never branched on downstream.
 */
export interface InputDriver {
  /** Human-readable backend name for logs. */
  readonly kind: "playwright" | "xtest";
  /** True when this backend can actually drive input in the current env. */
  available(): Promise<boolean>;
  /** Move the pointer along a human trajectory to `handle` and click it. */
  click(page: Page, handle: ElementHandle<Element>): Promise<void>;
  /** Click a text field then enter `text` with human-like timing. */
  fill(page: Page, handle: ElementHandle<Element>, text: string): Promise<void>;
}
