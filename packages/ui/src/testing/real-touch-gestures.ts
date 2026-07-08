/**
 * Shared REAL-touch gesture helpers for e2e: drive genuine touch input via CDP
 * Input.dispatchTouchEvent (the same path page.touchscreen uses).
 */
import type { Page } from "playwright";

/**
 * Shared REAL-touch gesture helpers (#10722): drive genuine touch input via CDP
 * `Input.dispatchTouchEvent` — the same path `page.touchscreen` uses — so a
 * gesture is exercised the way a finger drives it (pointerType `"touch"`,
 * through the browser's real hit-test / `touch-action` / implicit-capture
 * pipeline), NOT a synthetic `el.dispatchEvent(new PointerEvent(...))` inside
 * `page.evaluate` that bypasses all of it (the larp this replaces).
 *
 * Works with any Playwright `Page` (the `__e2e__` runners' raw `playwright`
 * page AND the ui-smoke specs' `@playwright/test` page). For touch input to be
 * accepted the page's context should be created with `hasTouch: true`.
 */

interface Center {
  cx: number;
  cy: number;
  box: { x: number; y: number; width: number; height: number };
}

/**
 * Wait for the page's main thread to be responsive (a main-world round-trip
 * that resolves on the next produced frame) before dispatching a gesture. A
 * real finger interacts with UI it can SEE — i.e. after the renderer committed
 * the previous step. Without this, the CDP touch stream can race a main thread
 * still busy with the previous step's React commit/style recalc; Chromium then
 * resolves the gesture compositor-side and the page's pointer handlers never
 * receive a clean release — the swipe is silently dropped in a way no real
 * user gesture reproduces (the conversation-swipe runner's post-new-
 * conversation swipes failed exactly this way).
 */
async function settleMainThread(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

async function centerOf(page: Page, selector: string): Promise<Center> {
  // Settle first so the box also reflects the committed layout.
  await settleMainThread(page);
  await page.waitForFunction(
    (selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0;
    },
    selector,
    { timeout: 3000 },
  );
  const box = await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
    };
  }, selector);
  if (!box) throw new Error(`real-touch: no bounding box for ${selector}`);
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2, box };
}

function point(x: number, y: number, id = 1) {
  return { x, y, id, radiusX: 4, radiusY: 4, force: 1 };
}

export interface TouchSwipeOptions {
  /** Intermediate `touchMove` events between start and end (higher = smoother). */
  steps?: number;
  /** Delay (ms) between move steps — controls velocity and lets rAF-based
   *  telemetry/animation tick across the drag. */
  stepDelayMs?: number;
  /** Hold at the start before moving (a long-press-then-drag). */
  holdMs?: number;
}

export interface ActiveTouchDrag {
  readonly endX: number;
  readonly endY: number;
  release(): Promise<void>;
  cancel(): Promise<void>;
}

/**
 * Real touch drag from an element's center by (dx, dy), leaving the finger held
 * down at the final point. Call `release()` after inspecting mid-drag state.
 */
export async function touchDragHold(
  page: Page,
  selector: string,
  dx: number,
  dy: number,
  { steps = 12, stepDelayMs = 0, holdMs = 0 }: TouchSwipeOptions = {},
): Promise<ActiveTouchDrag> {
  const { cx, cy } = await centerOf(page, selector);
  const client = await page.context().newCDPSession(page);
  const endX = cx + dx;
  const endY = cy + dy;
  let ended = false;

  const finish = async (type: "touchEnd" | "touchCancel") => {
    if (ended) return;
    ended = true;
    try {
      await client.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: [],
      });
    } finally {
      await client.detach();
    }
  };

  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point(cx, cy)],
    });
    if (holdMs > 0) await page.waitForTimeout(holdMs);
    for (let i = 1; i <= steps; i += 1) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [point(cx + (dx * i) / steps, cy + (dy * i) / steps)],
      });
      if (stepDelayMs > 0) await page.waitForTimeout(stepDelayMs);
    }
    return {
      endX,
      endY,
      release: () => finish("touchEnd"),
      cancel: () => finish("touchCancel"),
    };
  } catch (error) {
    await finish("touchCancel").catch(() => {});
    throw error;
  }
}

/**
 * Real touch swipe / drag from an element's center by (dx, dy).
 */
export async function touchSwipe(
  page: Page,
  selector: string,
  dx: number,
  dy: number,
  options: TouchSwipeOptions = {},
): Promise<void> {
  const drag = await touchDragHold(page, selector, dx, dy, options);
  await drag.release();
}

/** A real touch tap at an element's center (touchStart → touchEnd, no move). */
export async function touchTap(page: Page, selector: string): Promise<void> {
  const { cx, cy } = await centerOf(page, selector);
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point(cx, cy)],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }
}

/** A real touch long-press: touchStart, hold `holdMs`, touchEnd — no movement. */
export async function touchLongPress(
  page: Page,
  selector: string,
  holdMs = 600,
): Promise<void> {
  const { cx, cy } = await centerOf(page, selector);
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point(cx, cy)],
    });
    await page.waitForTimeout(holdMs);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }
}

// NOTE: no `touchPinch`/`touchPan` here on purpose. The pinch/pan consumers
// (the ui-smoke specs, e.g. apps-personal-assistant-decomposed-interactions)
// deliberately run in a NON-touch, desktop-layout context and must enable
// touch at the CDP level per-gesture (`Emulation.setTouchEmulationEnabled`)
// with scale-based finger geometry — semantics these hasTouch-context helpers
// don't share. That contract has its own shared module:
// packages/app/test/ui-smoke/helpers/real-touch-gestures.ts (#10722 item 8).
