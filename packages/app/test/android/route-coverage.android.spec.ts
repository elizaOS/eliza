// Real-device route coverage: navigate the on-device WebView to EVERY app
// route/feature and assert it renders against the real on-device backend. This
// is the Android equivalent of the browser all-pages-clicksafe sweep, but with
// no API mocking — the app talks to the real on-device agent.
//
// The assertion here is "navigates client-side + mounts its React root + does
// not trip the error boundary", NOT the exact per-route content: those text
// assertions live in the (mocked) ui-smoke suite and don't hold against real,
// unseeded backend data. This sweep's job is to guarantee every route is
// on-device navigable and render-safe on the real WebView.
//
// It reuses the canonical route enumerations so coverage stays in lock-step with
// the product: DIRECT_ROUTE_CASES (app-window / app-shell pages) and
// MANAGER_VISIBLE_VIEW_TILE_CASES (manager-visible GUI views).
import {
  DIRECT_ROUTE_CASES,
  MANAGER_VISIBLE_VIEW_TILE_CASES,
} from "../ui-smoke/apps-session-route-cases";
import { expect, gotoRoute, test, waitForShellReady } from "./android-harness";

type RouteCase = { name: string; path: string };

const ROUTES: RouteCase[] = [
  ...DIRECT_ROUTE_CASES.map((c) => ({ name: c.name, path: c.path })),
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
    await waitForShellReady(page);
  });

  for (const route of UNIQUE_ROUTES) {
    test(`renders on device: ${route.name} (${route.path})`, async ({
      page,
    }) => {
      await gotoRoute(page, route.path);
      // React root stays mounted.
      await expect(page.locator("#root")).toBeVisible({ timeout: 45_000 });
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
