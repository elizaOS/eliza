// Rendered-geometry tap-target gate (#10722 item 6). The 44px floor used to
// be enforced only as a CSS token (`--min-touch-target`) + lint conventions —
// nothing ever measured what the browser actually laid out, so a surface
// could regress below the Apple-HIG 44px floor (the spatial filter chips
// shipped at ~34px) with every gate green. This spec measures REAL
// `boundingBox()` geometry on a coarse-pointer Pixel-7 viewport over the
// spatial-view surfaces this repo's decomposed views actually render.

import { devices, expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

// Coarse-pointer mobile emulation: the `@media (pointer: coarse)` floor for
// spatial buttons only applies on touch devices, and that is exactly the
// class of device where tap-target size matters.
test.use({ ...devices["Pixel 7"] });

/** Apple HIG floor, with 0.5px slack for sub-pixel rounding. */
const MIN_TAP_PX = 44 - 0.5;

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("every spatial-view button renders a >=44px hit target on touch viewports", async ({
  page,
}) => {
  // /inbox and /relationships render the decomposed spatial views whose
  // filter chips are the primary mobile tap surfaces (#11144 lineage).
  for (const path of ["/inbox", "/relationships"]) {
    await openAppPath(page, path);
    const buttons = page.locator(
      '[data-spatial-surface] button[data-spatial-kind="button"]',
    );
    await expect(buttons.first()).toBeVisible({ timeout: 60_000 });
    const count = await buttons.count();
    expect(count, `${path} should render spatial buttons`).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const button = buttons.nth(i);
      if (!(await button.isVisible())) continue;
      const label = (await button.textContent())?.trim() ?? `#${i}`;
      const box = await button.boundingBox();
      expect(box, `${path} "${label}" must be laid out`).not.toBeNull();
      if (box) {
        expect(
          box.height,
          `${path} "${label}" tap height`,
        ).toBeGreaterThanOrEqual(MIN_TAP_PX);
        expect(
          box.width,
          `${path} "${label}" tap width`,
        ).toBeGreaterThanOrEqual(MIN_TAP_PX);
      }
    }
  }
});
