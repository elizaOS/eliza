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
  const isCompanionGui = view.id === "companion" && view.viewType === "gui";
  await expect(viewRoot).toBeVisible({ timeout: 60_000 });
  if (isCompanionGui) {
    await expect(viewRoot.getByTestId("companion-root").first()).toBeVisible({
      timeout: 60_000,
    });
  } else {
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
  }
  await expect(page.getByText(/Loading view/)).toHaveCount(0);
  await expect(page.getByText("Failed to load view")).toHaveCount(0);
  await expectNoRenderTelemetryErrors(
    page,
    `${view.id} ${view.viewType} ${phase}`,
  );
}

async function expectViewManagerPage(page: Page) {
  const main = page.locator("main").first();
  const smokeManager = main.getByText(/^View Manager \d+ views$/);
  const realManager = main.getByRole("heading", { level: 1, name: "Views" });
  await expect(smokeManager.or(realManager).first()).toBeVisible();

  if ((await smokeManager.count()) > 0) {
    await expect(
      main.getByRole("button", { name: "Refresh views" }),
    ).toBeVisible();
    await expect(
      main.getByRole("button", { name: "Open Companion" }),
    ).toBeVisible();
  } else {
    // #8597 moved the views search out of <main> and into the floating chat
    // composer ("Search views…"). The catalog renders as a flat launcher grid
    // of icon tiles (no per-source section headers), so assert a view tile is
    // present rather than a "Plugins" heading.
    await expect(page.getByPlaceholder(/Search views/)).toBeVisible();
    await expect(
      main.locator('[data-testid^="view-card-"]').first(),
    ).toBeVisible();
  }
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
      await expectViewManagerPage(page);
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
