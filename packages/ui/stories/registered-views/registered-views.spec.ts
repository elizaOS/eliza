/**
 * GUI + XR screenshot capture for every registered plugin spatial view.
 *
 * Boots the ui stories dev server (keyless) and, for every id the page reports
 * from the live spatial view-thunk registry, navigates `?id=<id>&modality=…`
 * and screenshots the mounted `<SpatialSurface>` panel to
 * `stories/__screens__/{gui,xr}/<id>.png`. Captured vs skipped ids are written
 * to a manifest so there's no silent truncation — every registered id is either
 * shot on both surfaces or explicitly recorded as skipped with the reason.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

type Modality = "gui" | "xr";

declare global {
  interface Window {
    __regviews: {
      ready: boolean;
      ids: string[];
      show: (id: string, modality: Modality) => void;
    };
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const screensDir = resolve(here, "../__screens__");
const guiDir = resolve(screensDir, "gui");
const xrDir = resolve(screensDir, "xr");
mkdirSync(guiDir, { recursive: true });
mkdirSync(xrDir, { recursive: true });

async function readIds(page: Page): Promise<string[]> {
  await page.goto("/registered-views.html");
  await page.waitForFunction(() => window.__regviews?.ready === true, {
    timeout: 30_000,
  });
  return page.evaluate(() => window.__regviews.ids);
}

test("capture GUI + XR screenshots for every registered view", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  const ids = await readIds(page);
  expect(ids.length).toBeGreaterThanOrEqual(30);

  const captured: { id: string; gui: boolean; xr: boolean }[] = [];
  const skipped: { id: string; reason: string }[] = [];

  // The page is mounted once; switch the active (id, modality) in place so we
  // don't pay a full module-graph reload per shot (33 × 2 = 66 surfaces).
  for (const id of ids) {
    const result = { id, gui: false, xr: false };
    for (const modality of ["gui", "xr"] as const) {
      try {
        await page.evaluate(({ i, m }) => window.__regviews.show(i, m), {
          i: id,
          m: modality,
        });
        const panel = page.locator(
          `[data-regview-panel="${id}"][data-regview-modality="${modality}"]`,
        );
        await panel.waitFor({ state: "visible", timeout: 10_000 });
        // The real authored view mounted inside the panel on this surface.
        await expect(
          panel.locator(`[data-spatial-surface="${modality}"]`),
        ).toBeVisible();
        const dir = modality === "gui" ? guiDir : xrDir;
        await panel.screenshot({ path: `${dir}/${id}.png` });
        result[modality] = true;
      } catch (err) {
        skipped.push({
          id,
          reason: `${modality}: ${(err as Error)?.message?.split("\n")[0] ?? err}`,
        });
      }
    }
    captured.push(result);
  }

  writeFileSync(
    resolve(screensDir, "gui-xr-manifest.json"),
    JSON.stringify({ captured, skipped, pageErrors: errors }, null, 2),
  );

  // Every registered id must capture on BOTH surfaces.
  const incomplete = captured.filter((c) => !c.gui || !c.xr);
  expect(incomplete, JSON.stringify(incomplete)).toEqual([]);
});
