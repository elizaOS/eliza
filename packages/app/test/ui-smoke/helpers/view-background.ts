// Shared, route-parameterized assertion of the unified-background contract
// (#9143 / #13452 / #13538): the routed view shell is transparent and NO
// ancestor between it and the App root paints an opaque `bg-bg` over the fixed
// wallpaper, so the launcher background is continuous edge-to-edge on every
// view — not just Settings. Generalizes the `inspectSettingsSeam` walk from
// settings-background.spec.ts, keyed by a per-view shell selector so the same
// leak assertion runs across chat / knowledge / wallet / browser (the #13538
// backgrounds catalog multiplies this leak surface). Consumed by
// views-background-sweep.spec.ts.

import { expect, type Page } from "@playwright/test";

/** localStorage key for the persisted BackgroundConfig (persistence.ts). */
export const UI_BACKGROUND_STORAGE_KEY = "eliza:ui-background";

export interface BackgroundSeamReport {
  /** The opaque `bg-bg` ancestors between the view shell and the App root. */
  opaqueBgAncestors: string[];
  /** The first such layer, or null when the wallpaper is continuous. */
  remainingOpaqueLayer: string | null;
  /** The fixed unified background physically spans the full viewport (y=0..H). */
  appBackgroundReachesTop: boolean;
  /** The `data-eliza-bg` kind of the mounted background, or null if absent. */
  backgroundKind: string | null;
  /** Whether the shell element itself was found (guards a bad selector). */
  shellFound: boolean;
}

/**
 * Walk up from `shellSelector` to `document.body`, collecting every ancestor
 * that paints an opaque `bg-bg`, and measure whether the fixed unified
 * background spans the viewport. Runs entirely in the page so the class walk +
 * geometry read reflect the real render.
 */
export async function inspectViewBackgroundSeam(
  page: Page,
  shellSelector: string,
): Promise<BackgroundSeamReport> {
  return page.evaluate((selector) => {
    const shell = document.querySelector(selector);
    const opaque: string[] = [];
    let node: Element | null = shell;
    while (node && node !== document.body) {
      const cls = node.className;
      if (typeof cls === "string" && cls.length > 0) {
        const tokens = cls.split(/\s+/);
        if (tokens.includes("bg-bg")) opaque.push(cls);
      }
      node = node.parentElement;
    }

    const bgEl =
      document.querySelector('[data-testid="app-background-image"]') ??
      document.querySelector('[data-testid="app-background-shader"]');
    let reachesTop = false;
    let kind: string | null = null;
    if (bgEl) {
      kind = bgEl.getAttribute("data-eliza-bg");
      const rect = bgEl.getBoundingClientRect();
      reachesTop = rect.top <= 0 && rect.bottom >= window.innerHeight - 1;
    }
    return {
      opaqueBgAncestors: opaque,
      remainingOpaqueLayer: opaque[0] ?? null,
      appBackgroundReachesTop: reachesTop,
      backgroundKind: kind,
      shellFound: shell !== null,
    };
  }, shellSelector);
}

/**
 * Assert the unified background is continuous under `shellSelector`: no opaque
 * `bg-bg` ancestor paints over the wallpaper and the fixed background reaches
 * the top of the viewport. `label` names the view in failure output.
 */
export async function assertNoOpaqueBackgroundAncestor(
  page: Page,
  shellSelector: string,
  label: string,
): Promise<BackgroundSeamReport> {
  const seam = await inspectViewBackgroundSeam(page, shellSelector);
  expect(seam.shellFound, `${label}: shell "${shellSelector}" is present`).toBe(
    true,
  );
  expect(
    seam.remainingOpaqueLayer,
    `${label}: no ancestor of "${shellSelector}" may paint an opaque bg-bg over the wallpaper (leak: ${seam.remainingOpaqueLayer})`,
  ).toBeNull();
  expect(
    seam.appBackgroundReachesTop,
    `${label}: the unified background must span the full viewport including the safe-area top`,
  ).toBe(true);
  return seam;
}

/** Seed the persisted BackgroundConfig so a known wallpaper mounts on load. */
export async function seedBackgroundStorage(
  page: Page,
  background: { mode: string; color?: string; imageUrl?: string },
): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, value);
    },
    { key: UI_BACKGROUND_STORAGE_KEY, value: JSON.stringify(background) },
  );
}
