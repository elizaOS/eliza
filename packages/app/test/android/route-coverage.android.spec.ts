// Real-device route coverage: navigate the on-device WebView to EVERY app
// route/feature and assert it renders against the real on-device backend. This
// is the Android equivalent of the browser all-pages-clicksafe sweep, but with
// no API mocking — the app talks to the real on-device agent.
//
// Every route must retain the requested pathname. Direct product routes also
// reuse their canonical page-ready marker, so a shared shell or router fallback
// cannot satisfy the whole matrix. Manager-provided views have no static
// per-view DOM contract, so they retain the pathname + nonblank/error-boundary
// proof against the real, unseeded backend.
//
// It reuses the canonical route enumerations so coverage stays in lock-step with
// the product: DIRECT_ROUTE_CASES (app-window / app-shell pages) and
// MANAGER_VISIBLE_VIEW_TILE_CASES (manager-visible GUI views).
import {
  DIRECT_ROUTE_CASES,
  MANAGER_VISIBLE_VIEW_TILE_CASES,
} from "../ui-smoke/apps-session-route-cases";
import {
  expect,
  expectRouteReady,
  gotoRoute,
  type ReadyCheck,
  test,
} from "./android-harness";

type RouteCase = {
  name: string;
  path: string;
  readyChecks?: readonly ReadyCheck[];
};

const ROUTES: RouteCase[] = [
  ...DIRECT_ROUTE_CASES.map((route) => ({
    name: route.name,
    path: route.path,
    readyChecks:
      "selector" in route ? [{ selector: route.selector }] : route.readyChecks,
  })),
  ...MANAGER_VISIBLE_VIEW_TILE_CASES.map((v) => ({
    name: `view ${v.viewId}`,
    path: v.expectedPath,
  })),
];
// Dedupe by path (some views share a path with a direct route).
const SEEN = new Set<string>();
const UNIQUE_ROUTES = ROUTES.filter((r) => {
  if (SEEN.has(r.path)) return false;
  SEEN.add(r.path);
  return true;
});

// NOT describe.serial: the routes share one WebView so they already run serially
// (workers=1), but a single render hiccup must not abort the rest of the sweep.
test.describe("android route coverage (real backend)", () => {
  test.beforeAll(async ({ page }) => {
    // The combined hosted lane starts with a genuinely fresh onboarding test,
    // so the worker fixture intentionally cannot seed developer mode before
    // boot. Exercise the visible Settings control before probing developer-only
    // routes such as Orchestrator; reserved shell storage correctly rejects a
    // raw localStorage write once a view realm has mounted.
    // Onboarding also leaves the successful conversation expanded. Close it
    // through the sheet's keyboard-operable product control so it cannot cover
    // the Settings rows on the compact Android viewport.
    const openChatGrabber = page.getByLabel("drag down to close chat");
    if (await openChatGrabber.isVisible().catch(() => false)) {
      await openChatGrabber.press("ArrowDown");
      await expect(page.getByLabel("drag up to open chat")).toBeVisible({
        timeout: 15_000,
      });
    }
    await gotoRoute(page, "/settings");
    const backupsSection = page.getByText("Backups", { exact: true }).first();
    await expect(backupsSection).toBeVisible({ timeout: 45_000 });
    await backupsSection.click();
    const developerViews = page.locator("#advanced-developer-mode");
    await expect(developerViews).toBeVisible({ timeout: 45_000 });
    if ((await developerViews.getAttribute("aria-checked")) !== "true") {
      await developerViews.click();
    }
    await expect(developerViews).toHaveAttribute("aria-checked", "true");
  });

  for (const route of UNIQUE_ROUTES) {
    test(`renders on device: ${route.name} (${route.path})`, async ({
      page,
    }) => {
      await gotoRoute(page, route.path);
      await expect
        .poll(() => page.evaluate(() => window.location.pathname), {
          timeout: 45_000,
          message: `${route.name}: router did not retain ${route.path}`,
        })
        .toBe(route.path);
      // React root stays mounted.
      await expect(page.locator("#root")).toBeVisible({ timeout: 45_000 });
      if (route.readyChecks?.length) {
        try {
          await expectRouteReady(page, route.name, route.readyChecks, {
            timeoutMs: 45_000,
          });
        } catch (error) {
          const renderedState = await page.evaluate(() => ({
            text: (document.body?.innerText ?? "").trim().slice(0, 1_000),
            testIds: Array.from(document.querySelectorAll("[data-testid]"))
              .map((element) => element.getAttribute("data-testid"))
              .filter((value): value is string => Boolean(value))
              .slice(0, 100),
          }));
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\nRendered state: ${JSON.stringify(renderedState)}`,
            { cause: error },
          );
        }
      }
      // The route paints SOMETHING (not a blank white screen) within the window.
      await expect
        .poll(
          () =>
            page.evaluate(() => (document.body?.innerText ?? "").trim().length),
          {
            timeout: 45_000,
            message: `${route.name}: route never painted content`,
          },
        )
        .toBeGreaterThan(0);
      // It does not trip the React error boundary.
      const crashed = await page
        .getByText(
          /Something went wrong|Application error|White screen|Unhandled exception/i,
        )
        .first()
        .isVisible()
        .catch(() => false);
      expect(
        crashed,
        `${route.name}: tripped an error boundary at ${route.path}`,
      ).toBe(false);
    });
  }
});
