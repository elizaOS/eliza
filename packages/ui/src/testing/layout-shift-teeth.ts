/**
 * Teeth-check for the chat perf gates: proves the live layout-shift observer +
 * CLS detector actually catch a real, non-intentional shift on the real surface.
 *
 * A perf gate that only asserts `CLS ≤ 0.1` can go green for the wrong reason —
 * a dead PerformanceObserver, a surface that never re-lays-out, or an over-broad
 * `data-eliza-layout-shift-intent="transient"` marker that swallows a genuine
 * shift — all report CLS 0.0000 and pass vacuously. This injects real
 * `layout-shift`-producing DOM mutations OUTSIDE any transient-intent marker
 * (spacers pushed in above the fixture's static content) and returns the
 * detector's verdict, so the gate can assert the injected shift IS flagged. It is
 * the regression guard for the class of shift the removed horizontal
 * conversation-swipe once produced here (CLS 0.80, #14333).
 *
 * Consumes `window.__ELIZA_LAYOUT_SHIFTS__`, populated by
 * {@link LAYOUT_SHIFT_OBSERVER_INIT}; the caller must install that observer.
 */
import type { Page } from "playwright";
import {
  type LayoutShiftSample,
  type StabilitySummary,
  summarizeStability,
} from "./layout-stability.ts";

declare global {
  interface Window {
    /** Populated in the browser by {@link LAYOUT_SHIFT_OBSERVER_INIT}. */
    __ELIZA_LAYOUT_SHIFTS__?: LayoutShiftSample[];
  }
}

export interface TeethCheckOptions {
  /** Selector of an in-flow container OUTSIDE the transient-marked overlay. A
   * painted victim block is inserted at its top and then pushed down. */
  rootSelector: string;
  /** Number of spacers pushed in above the victim block; each move is one shift
   * and CLS sums, so the tuned default clears 0.1 with a wide margin (~0.37). */
  injections?: number;
  /** Height of the painted victim block whose downward motion produces the
   * large-impact shifts, in px. */
  blockPx?: number;
  /** Height of each spacer pushed above the block, in px (the per-shift move). */
  spacerPx?: number;
  /** CLS budget the detector flags against (mirrors the gate's own budget). */
  maxCls?: number;
}

/**
 * Insert a painted victim block into `rootSelector`, push it down with
 * `injections` spacers to produce real non-transient layout shifts, harvest the
 * observed `layout-shift` entries, remove every injected node, and return the
 * detector's verdict. A flagged, over-budget result proves the gate has teeth.
 * Call while the surface under the block is visible (impact fraction is largest);
 * the tuned defaults yield a deterministic ~0.37 CLS on the 420×820 fixture.
 */
export async function measureInjectedNonTransientShift(
  page: Page,
  {
    rootSelector,
    injections = 6,
    blockPx = 400,
    spacerPx = 300,
    maxCls = 0.1,
  }: TeethCheckOptions,
): Promise<StabilitySummary> {
  await page.evaluate(
    ({ rootSelector, blockPx }) => {
      const root = document.querySelector(rootSelector);
      if (!root)
        throw new Error(`teeth-check: root "${rootSelector}" not found`);
      const block = document.createElement("div");
      block.style.cssText = `height:${blockPx}px;width:100%;background:#0a0a0a;`;
      block.setAttribute("data-teeth", "block");
      root.insertBefore(block, root.firstChild);
    },
    { rootSelector, blockPx },
  );
  await page.waitForTimeout(250); // let the victim block paint before it moves
  await page.evaluate(() => {
    window.__ELIZA_LAYOUT_SHIFTS__ = [];
  });
  // The observer excludes shifts within 500ms of user input; a gesture drive may
  // have just finished, so wait past that window or every injected shift is
  // discarded as input-caused.
  await page.waitForTimeout(700);
  for (let i = 0; i < injections; i += 1) {
    await page.evaluate(
      ({ rootSelector, spacerPx }) => {
        const root = document.querySelector(rootSelector);
        if (!root)
          throw new Error(`teeth-check: root "${rootSelector}" not found`);
        const spacer = document.createElement("div");
        spacer.style.cssText = `height:${spacerPx}px;width:100%;`;
        spacer.setAttribute("data-teeth", "spacer");
        root.insertBefore(spacer, root.firstChild);
      },
      { rootSelector, spacerPx },
    );
    await page.waitForTimeout(180);
  }
  const injected: LayoutShiftSample[] = await page.evaluate(
    () => window.__ELIZA_LAYOUT_SHIFTS__ ?? [],
  );
  await page.evaluate(() => {
    for (const n of document.querySelectorAll("[data-teeth]")) n.remove();
  });
  return summarizeStability(injected, [], { maxCls });
}
