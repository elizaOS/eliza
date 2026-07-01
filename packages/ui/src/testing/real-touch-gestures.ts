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

async function centerOf(page: Page, selector: string): Promise<Center> {
  const box = await page.locator(selector).first().boundingBox();
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

/**
 * A real two-finger pinch about an element's center: `spread > 0` spreads the
 * fingers apart (zoom-in gesture), `spread < 0` brings them together (zoom-out).
 */
export async function touchPinch(
  page: Page,
  selector: string,
  spread: number,
  {
    steps = 10,
    stepDelayMs = 0,
  }: { steps?: number; stepDelayMs?: number } = {},
): Promise<void> {
  const { cx, cy } = await centerOf(page, selector);
  const client = await page.context().newCDPSession(page);
  const start = 20; // initial half-separation (px) from center
  const pair = (sep: number) => [
    point(cx - sep, cy, 1),
    point(cx + sep, cy, 2),
  ];
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: pair(start),
    });
    for (let i = 1; i <= steps; i += 1) {
      const sep = Math.max(2, start + (spread * i) / steps);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: pair(sep),
      });
      if (stepDelayMs > 0) await page.waitForTimeout(stepDelayMs);
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }
}
