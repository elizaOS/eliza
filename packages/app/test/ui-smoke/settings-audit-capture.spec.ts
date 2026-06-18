// Settings audit capture: full-page screenshots of every settings section at
// desktop + mobile (light theme) into reports/settings-audit/ for legibility +
// copy review. Keyless against the stub. Not a pass/fail spec — it captures.

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, test } from "@playwright/test";
import {
  SETTINGS_SECTIONS,
  VIEWPORT_SIZES,
} from "../../../../scripts/ai-qa/route-catalog.ts";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const OUT_DIR = resolve(REPO_ROOT, "reports", "settings-audit");

const VIEWPORTS = [
  { name: "desktop", size: VIEWPORT_SIZES.desktop },
  { name: "mobile", size: VIEWPORT_SIZES.mobile },
] as const;

async function settleTheme(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("eliza:theme-mode", "light");
      localStorage.setItem("eliza-theme", "light");
    } catch {}
  });
  await page.emulateMedia({ colorScheme: "light" });
}

test.describe("settings audit capture", () => {
  test.describe.configure({ mode: "default" });
  // Opt-in: this spec only screenshots (no assertions) and adds ~90s to the
  // lane, so it stays out of normal CI. Run it on demand with
  // ELIZA_SETTINGS_AUDIT=1 when reviewing the settings surface.
  test.skip(
    process.env.ELIZA_SETTINGS_AUDIT !== "1",
    "settings audit capture is opt-in (set ELIZA_SETTINGS_AUDIT=1)",
  );

  for (const viewport of VIEWPORTS) {
    test(`capture all sections @ ${viewport.name}`, async ({ browser }) => {
      test.setTimeout(600_000);
      const outDir = join(OUT_DIR, viewport.name);
      await mkdir(outDir, { recursive: true });

      const context = await browser.newContext({
        viewport: viewport.size,
        colorScheme: "light",
      });
      const page = await context.newPage();
      await settleTheme(page);
      await seedAppStorage(page);
      await installDefaultAppRoutes(page);

      await openAppPath(page, "/settings");
      await page
        .getByTestId("settings-shell")
        .first()
        .waitFor({ state: "visible", timeout: 90_000 });

      // Hub / landing capture.
      await captureScreenshotWithQualityRetry(page, `hub ${viewport.name}`, {
        attempts: 4,
        fullPage: true,
        type: "png",
        path: join(outDir, "_hub.png"),
      });

      const missing: string[] = [];
      for (const section of SETTINGS_SECTIONS) {
        try {
          await openSettingsSection(page, section.match);
        } catch (error) {
          missing.push(`${section.id}: ${(error as Error).message}`);
          continue;
        }
        // Let async section bodies paint.
        await page.waitForTimeout(600);
        await captureScreenshotWithQualityRetry(
          page,
          `${section.id} ${viewport.name}`,
          {
            attempts: 4,
            fullPage: true,
            type: "png",
            path: join(outDir, `${section.id}.png`),
          },
        );
      }

      await writeFile(
        join(outDir, "_missing.json"),
        JSON.stringify({ viewport: viewport.name, missing }, null, 2),
      );
      await context.close();
    });
  }
});
