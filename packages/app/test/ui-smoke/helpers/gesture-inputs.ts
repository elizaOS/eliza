/**
 * Real-input gesture helpers for the gesture-matrix suite (L3 of the UI
 * interaction epic). Mirrors the proven input paths already used by
 * chat-clear-swipe.spec.ts and input-modality.spec.ts:
 *
 * - `mousePointerDrag` — `page.mouse` down → staged moves → up (pointerType
 *   "mouse"), the real desktop drag path including the browser's compat
 *   `click` synthesis on release (which is exactly what the ghost-click
 *   regression tests need).
 * - `cdpTouchDrag` — CDP `Input.dispatchTouchEvent` (pointerType "touch"), a
 *   genuine finger path for the hasTouch mobile project — not page.mouse
 *   wearing a viewport.
 */

import type { Locator, Page } from "@playwright/test";

export async function centerOf(
  locator: Locator,
): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("gesture target has no bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Real mouse drag from the center of `target` by (dx, dy). `pauseMs` between
 * segments controls the release velocity: 0 → a fast flick, larger → a slow
 * deliberate drag (used to discriminate velocity-gated detents from taps).
 */
export async function mousePointerDrag(
  page: Page,
  target: Locator,
  dx: number,
  dy: number,
  { steps = 8, pauseMs = 0 }: { steps?: number; pauseMs?: number } = {},
): Promise<void> {
  const from = await centerOf(target);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(from.x + (dx * i) / steps, from.y + (dy * i) / steps);
    if (pauseMs > 0) await page.waitForTimeout(pauseMs);
  }
  await page.mouse.up();
}

/** Genuine CDP touch drag from the center of `target` by (dx, dy). */
export async function cdpTouchDrag(
  page: Page,
  target: Locator,
  dx: number,
  dy: number,
  steps = 12,
): Promise<void> {
  const from = await centerOf(target);
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: from.x, y: from.y }],
    });
    for (let i = 1; i <= steps; i += 1) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: from.x + (dx * i) / steps, y: from.y + (dy * i) / steps },
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

/**
 * Install a capture-phase pointer/click recorder scoped to the subtree of the
 * element matching `containerTestId`. Returns nothing; read the counters with
 * `readLeakedEvents`. Used for drag-through / click-through assertions: events
 * that land INSIDE the layer beneath during a gesture on the layer above are
 * leaks.
 */
export async function installLayerLeakRecorder(
  page: Page,
  containerTestId: string,
): Promise<void> {
  await page.evaluate((testId) => {
    const leaks: Array<{ type: string; target: string }> = [];
    (
      window as unknown as {
        __GESTURE_LEAKS__?: Array<{ type: string; target: string }>;
      }
    ).__GESTURE_LEAKS__ = leaks;
    const container = document.querySelector(`[data-testid="${testId}"]`);
    if (!container) throw new Error(`no [data-testid="${testId}"] to observe`);
    for (const type of ["pointerdown", "pointerup", "click"]) {
      document.addEventListener(
        type,
        (event) => {
          const target = event.target as Element | null;
          if (target && container.contains(target)) {
            leaks.push({
              type,
              target:
                target.closest("[data-testid]")?.getAttribute("data-testid") ??
                target.tagName,
            });
          }
        },
        { capture: true },
      );
    }
  }, containerTestId);
}

export async function readLeakedEvents(
  page: Page,
): Promise<Array<{ type: string; target: string }>> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __GESTURE_LEAKS__?: Array<{ type: string; target: string }>;
        }
      ).__GESTURE_LEAKS__ ?? [],
  );
}
