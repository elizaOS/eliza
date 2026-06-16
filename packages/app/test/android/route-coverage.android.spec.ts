// Real-device route coverage: navigate the on-device WebView to EVERY app
// route/feature and assert it renders against the real on-device backend. This
// is the Android equivalent of the browser all-pages-clicksafe sweep, but with
// no API mocking — the app talks to the real on-device agent. It reuses the
// canonical route enumerations so this stays in lock-step with the product:
// DIRECT_ROUTE_CASES (every app-window / app-shell page) and
// MANAGER_VISIBLE_VIEW_TILE_CASES (every manager-visible GUI view).
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
  waitForShellReady,
} from "./android-harness";

function caseChecks(routeCase: (typeof DIRECT_ROUTE_CASES)[number]): ReadyCheck[] {
  if ("selector" in routeCase && routeCase.selector) {
    return [{ selector: routeCase.selector }];
  }
  if ("readyChecks" in routeCase && routeCase.readyChecks) {
    return [...routeCase.readyChecks];
  }
  return [{ selector: "#root" }];
}

test.describe.serial("android route coverage (real backend)", () => {
  test.beforeAll(async ({ page }) => {
    await waitForShellReady(page);
  });

  for (const routeCase of DIRECT_ROUTE_CASES) {
    test(`direct route renders: ${routeCase.name} (${routeCase.path})`, async ({
      page,
    }) => {
      await gotoRoute(page, routeCase.path);
      await expectRouteReady(page, routeCase.name, caseChecks(routeCase), {
        mode: "any",
        timeoutMs: routeCase.timeoutMs ?? 60_000,
      });
    });
  }

  for (const view of MANAGER_VISIBLE_VIEW_TILE_CASES) {
    test(`view renders without crash: ${view.viewId} (${view.expectedPath})`, async ({
      page,
    }) => {
      await gotoRoute(page, view.expectedPath);
      // A manager-visible view must at least mount its React root and not trip
      // the error boundary. Specific per-view assertions live in DIRECT_ROUTE_CASES
      // and the plugin-views suites; here we guarantee on-device navigability.
      await expect(page.locator("#root")).toBeVisible({ timeout: 60_000 });
      const crashed = await page
        .getByText(/Something went wrong|Application error|White screen|Unhandled/i)
        .first()
        .isVisible()
        .catch(() => false);
      expect(
        crashed,
        `${view.viewId}: view tripped an error boundary at ${view.expectedPath}`,
      ).toBe(false);
    });
  }
});
