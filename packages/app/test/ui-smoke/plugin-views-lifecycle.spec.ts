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

type VisualSignalCase = {
  rootSelector: string;
  visualSignalSelector: string;
};

const VISUAL_SIGNAL_CASES = new Map<string, VisualSignalCase>([
  [
    "companion:gui:/companion",
    {
      rootSelector: "[data-testid='companion-root']",
      visualSignalSelector: "[data-testid='companion-vrm-stage']",
    },
  ],
]);

async function expectLoadedView(page: Page, view: ViewCase, phase: string) {
  const visualSignalCase = VISUAL_SIGNAL_CASES.get(
    `${view.id}:${view.viewType}:${view.path}`,
  );
  const viewRoot = page
    .locator(visualSignalCase?.rootSelector ?? "main")
    .first();
  const visualSignal = visualSignalCase
    ? page.locator(visualSignalCase.visualSignalSelector).first()
    : null;
  await expect(viewRoot).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      async () => {
        const text = await viewRoot.evaluate((root) =>
          root.innerText.trim().replace(/\s+/g, " "),
        );
        if (text.length > 20 && !/^Loading view\b/.test(text)) return true;
        return visualSignal ? await visualSignal.isVisible() : false;
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
    await expect(main.getByPlaceholder(/Search views/)).toBeVisible();
    await expect(
      main.getByRole("heading", { level: 2, name: "Plugins" }),
    ).toBeVisible();
    await expect(main.locator("button, [role='button']").first()).toBeVisible();
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
