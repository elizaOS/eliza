/**
 * Playwright UI-smoke spec for the Plugin Views Lifecycle app flow using the
 * real renderer fixture.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  expectNoRenderTelemetryErrors,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { VIEW_CASES, type ViewCase } from "./plugin-view-cases";

async function expectLoadedView(page: Page, view: ViewCase, phase: string) {
  const viewRoot = page.locator("main").first();
  await expect(viewRoot).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      async () => {
        const text = await viewRoot.evaluate((root) =>
          root.innerText.trim().replace(/\s+/g, " "),
        );
        return text.length > 20 && !/^Loading view\b/.test(text);
      },
      {
        message: `${view.id} ${view.viewType} should load during ${phase}`,
        timeout: 60_000,
      },
    )
    .toBe(true);
  await expect(page.getByText(/Loading view/)).toHaveCount(0);
  await expect(page.getByText("Failed to load view")).toHaveCount(0);
  await expectNoRenderTelemetryErrors(
    page,
    `${view.id} ${view.viewType} ${phase}`,
  );
}

async function expectLauncherPage(page: Page) {
  const main = page.locator("main").first();
  await expect(main.getByTestId("launcher")).toBeVisible();
  await expect(
    main.locator('[data-testid^="launcher-tile-"]').first(),
  ).toBeVisible();
  await expect(main.getByText("dynamic view smoke surface")).toHaveCount(0);
}

test.describe("registered plugin view lifecycle coverage", () => {
  for (const view of VIEW_CASES) {
    test(`${view.id} ${view.viewType} loads, unmounts, reopens, and reloads cleanly`, async ({
      page,
    }) => {
      installPageDiagnosticsGuard(page);
      await seedAppStorage(page);
      await installDefaultAppRoutes(page);

      await openAppPath(page, view.path);
      await expectLoadedView(page, view, "initial open");

      await openAppPath(page, "/views");
      await expectLauncherPage(page);
      await expectNoRenderTelemetryErrors(
        page,
        `${view.id} ${view.viewType} after unmount`,
      );

      await openAppPath(page, view.path);
      await expectLoadedView(page, view, "reopen");

      await page.reload({ waitUntil: "domcontentloaded" });
      await expectLoadedView(page, view, "browser reload");
      await expectNoPageDiagnostics(
        page,
        `${view.id} ${view.viewType} lifecycle`,
      );
    });
  }
});
