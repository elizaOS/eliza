// Shared REAL-touch gesture helpers for the ui-smoke Playwright specs
// (#10722 item 8): drive genuine multi-touch input via CDP
// `Input.dispatchTouchEvent` with per-gesture `Emulation.setTouchEmulationEnabled`,
// so a spec running in a NON-touch desktop-layout context (the default
// `chromium` lane) can still exercise a surface the way fingers drive it —
// pointerType `"touch"`, through the browser's real hit-test / `touch-action`
// / implicit-capture pipeline. This is deliberately different from
// `packages/ui/src/testing/real-touch-gestures.ts`, whose helpers assume a
// `hasTouch: true` context (the `__e2e__` runners + the Pixel-7 lane) and
// therefore never toggle CDP touch emulation; see the NOTE at the bottom of
// that file. One implementation per input contract, each with 2+ consumers.

import type { Page } from "@playwright/test";

interface VisibleRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * The on-screen (viewport-intersected) rectangle of `selector`. Fingers must
 * land on VISIBLE pixels: a zoomed/panned container's box can extend past the
 * viewport (or sit partially scrolled), and touches outside the viewport are
 * silently dropped by the compositor.
 */
async function visibleRectOf(
  page: Page,
  selector: string,
  minWidth: number,
  minHeight: number,
): Promise<VisibleRect> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`real-touch: no bounding box for ${selector}`);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("real-touch: no viewport size");
  const rect: VisibleRect = {
    left: Math.max(box.x, 0),
    right: Math.min(box.x + box.width, viewport.width),
    top: Math.max(box.y, 0),
    bottom: Math.min(box.y + box.height, viewport.height),
  };
  if (rect.right - rect.left < minWidth || rect.bottom - rect.top < minHeight) {
    throw new Error(
      `real-touch: ${selector} is not sufficiently on-screen (visible ${
        rect.right - rect.left
      }x${rect.bottom - rect.top}, need ${minWidth}x${minHeight})`,
    );
  }
  return rect;
}

/**
 * Drive a REAL two-finger pinch via CDP `Input.dispatchTouchEvent` (genuine
 * multi-touch input, not desktop mouse) — #9943 item 6 "pinch case".
 * `scale > 1` spreads the fingers apart (pinch-out → zoom in); `scale < 1`
 * brings them together (pinch-in → zoom out). Touch input is enabled at the
 * CDP level per-gesture so the page keeps its desktop layout; only the
 * gesture is touch.
 */
export async function touchPinch(
  page: Page,
  selector: string,
  scale: number,
  steps = 16,
): Promise<void> {
  const rect = await visibleRectOf(page, selector, 80, 40);
  const cx = (rect.left + rect.right) / 2;
  const cy = (rect.top + rect.bottom) / 2;
  const startGap = Math.min(60, (rect.right - rect.left) / 4);
  const points = (gap: number) => [
    { x: cx - gap, y: cy, id: 0 },
    { x: cx + gap, y: cy, id: 1 },
  ];
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 2,
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: points(startGap),
    });
    for (let i = 1; i <= steps; i += 1) {
      const gap = startGap * (1 + (scale - 1) * (i / steps));
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: points(gap),
      });
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }
}

/**
 * Drive a REAL one-finger pan (drag) via CDP `Input.dispatchTouchEvent` from
 * the center of `selector`'s visible rect by (dx, dy). Same per-gesture CDP
 * touch emulation as {@link touchPinch}; the finger path is clamped to start
 * inside the visible rect so the gesture lands on the surface under test.
 */
export async function touchPan(
  page: Page,
  selector: string,
  dx: number,
  dy: number,
  steps = 16,
): Promise<void> {
  const rect = await visibleRectOf(page, selector, 40, 40);
  const cx = (rect.left + rect.right) / 2;
  const cy = (rect.top + rect.bottom) / 2;
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 1,
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: cx, y: cy, id: 0 }],
    });
    for (let i = 1; i <= steps; i += 1) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: cx + (dx * i) / steps, y: cy + (dy * i) / steps, id: 0 },
        ],
      });
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }
}
