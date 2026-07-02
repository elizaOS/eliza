/**
 * Real-gesture drag-and-drop helpers (#10722).
 *
 * Two families of interaction live here, matching the two DnD models the app
 * actually ships:
 *
 * 1. `realMouseDrag` — REAL pointer input: `mouse.down` → a staged multi-step
 *    `mouse.move` path at a realistic velocity → `mouse.up`. For HTML5
 *    `draggable` elements Chromium (via Playwright's CDP drag interception)
 *    runs the native drag loop, so the product's `dragstart` / `dragover` /
 *    `drop` / `dragend` handlers fire exactly as they do for a human drag —
 *    no synthetic `dispatchEvent` shortcuts.
 *
 * 2. `fileDataTransfer` + `dropFilesOn` — a REAL `DataTransfer` carrying REAL
 *    `File` payloads, dispatched as `dragenter`/`dragover`/`drop`. An OS-level
 *    file drag physically cannot be scripted into a browser page (the drag
 *    source lives outside the renderer), so a genuine DataTransfer with the
 *    genuine bytes is the strongest possible stand-in: everything from the
 *    event listener down (file reading, encoding, upload POST, state) is the
 *    real product pipeline.
 */

import type { JSHandle, Locator, Page } from "@playwright/test";

interface RealMouseDragOptions {
  /**
   * Number of intermediate move segments between source and target. Each
   * segment is a real `mouse.move` with sub-steps, so the browser sees a
   * continuous pointer path rather than a teleport.
   */
  pathSegments?: number;
  /** Pause (ms) while hovering the drop target before release — lets the
   *  product's dragover highlight state settle like a human hesitation. */
  hoverPauseMs?: number;
  /** Press Escape mid-path (after entering the target) before releasing. */
  escapeBeforeRelease?: boolean;
  /**
   * Release the mouse at this page coordinate instead of over the target.
   * Used for cancel paths: releasing outside any drop target ends the native
   * drag with `dragend` and NO `drop` — the same product-visible event
   * sequence a native Escape cancel produces.
   */
  releaseAt?: { x: number; y: number };
}

async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("realMouseDrag: element has no layout box");
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Drag `source` onto `target` with real mouse input. The path is staged:
 * a small arming jiggle after mousedown (HTML5 dragstart requires movement),
 * then `pathSegments` real intermediate moves toward the target, a hover
 * pause over it, and the release.
 */
export async function realMouseDrag(
  page: Page,
  source: Locator,
  target: Locator,
  options: RealMouseDragOptions = {},
): Promise<void> {
  const {
    pathSegments = 8,
    hoverPauseMs = 120,
    escapeBeforeRelease = false,
    releaseAt,
  } = options;

  const from = await centerOf(source);
  const to = await centerOf(target);

  await page.mouse.move(from.x, from.y, { steps: 4 });
  await page.mouse.down();
  // Arming jiggle: the native drag loop starts only after real movement while
  // the button is held (and Playwright's drag interception needs at least two
  // moves), so wiggle a few px around the grab point first.
  await page.mouse.move(from.x + 4, from.y + 2, { steps: 2 });
  await page.mouse.move(from.x + 8, from.y + 4, { steps: 2 });

  for (let segment = 1; segment <= pathSegments; segment++) {
    const t = segment / pathSegments;
    const x = from.x + (to.x - from.x) * t;
    // A light arc makes the path human-plausible rather than a straight ray.
    const arc = Math.sin(t * Math.PI) * 6;
    const y = from.y + (to.y - from.y) * t + arc;
    await page.mouse.move(x, y, { steps: 3 });
    await page.waitForTimeout(16);
  }

  await page.mouse.move(to.x, to.y, { steps: 2 });
  await page.waitForTimeout(hoverPauseMs);

  if (escapeBeforeRelease) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(50);
  }

  if (releaseAt) {
    await page.mouse.move(releaseAt.x, releaseAt.y, { steps: 6 });
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  // Let React commit the post-drop/post-dragend state.
  await page.waitForTimeout(120);
}

export interface DataTransferFileSpec {
  name: string;
  mimeType: string;
  /** Raw file bytes, base64-encoded for transport into the page. */
  base64: string;
}

/**
 * Build a REAL `DataTransfer` in page context carrying REAL `File` objects
 * with the given bytes. The returned handle can be passed as the
 * `dataTransfer` event-init to `dispatchEvent("dragover" | "drop")`.
 */
export async function fileDataTransfer(
  page: Page,
  files: DataTransferFileSpec[],
): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle((specs) => {
    const dt = new DataTransfer();
    for (const spec of specs) {
      const bytes = Uint8Array.from(atob(spec.base64), (char) =>
        char.charCodeAt(0),
      );
      dt.items.add(new File([bytes], spec.name, { type: spec.mimeType }));
    }
    return dt;
  }, files);
}

/** A DataTransfer carrying only text — a text-selection drag, not a file drag. */
export async function textDataTransfer(
  page: Page,
): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "dragged text selection, not a file");
    return dt;
  });
}

/**
 * Dispatch the full enter→over→drop sequence a real file drag produces on a
 * drop zone. `dragover` first (twice, as browsers continuously refire it) so
 * the product's hover/highlight state engages before the drop lands.
 */
export async function dropFilesOn(
  zone: Locator,
  dataTransfer: JSHandle<DataTransfer>,
): Promise<void> {
  await zone.dispatchEvent("dragenter", { dataTransfer });
  await zone.dispatchEvent("dragover", { dataTransfer });
  await zone.dispatchEvent("dragover", { dataTransfer });
  await zone.dispatchEvent("drop", { dataTransfer });
}

/** The enter→over→leave sequence of an aborted hover (drag away, no drop). */
export async function hoverThenLeaveFiles(
  zone: Locator,
  dataTransfer: JSHandle<DataTransfer>,
): Promise<void> {
  await zone.dispatchEvent("dragenter", { dataTransfer });
  await zone.dispatchEvent("dragover", { dataTransfer });
  await zone.dispatchEvent("dragleave", { dataTransfer });
}
