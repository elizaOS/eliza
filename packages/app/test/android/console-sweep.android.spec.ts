// #10196 console-error sweep: walk every shipping route on-device (via the same
// harness route-coverage uses) and collect console.error / pageerror per view.
// route-coverage already asserts each view PAINTS + doesn't trip the error
// boundary; this catches runtime errors that render OK but log errors/throw —
// a deeper "view renders cleanly" check. Reports per-view, fails only if a view
// logs a hard error/exception.
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
const seen = new Set<string>();
const UNIQUE_ROUTES = ROUTES.filter((r) => {
  if (seen.has(r.path)) return false;
  seen.add(r.path);
  return true;
});

// Known-noisy patterns to ignore (dev warnings, not defects).
const IGNORE =
  /DevTools|Download the React|\[vite\]|HMR|deprecat|favicon|sourcemap/i;

test.describe("android console-error sweep (real backend)", () => {
  test("every shipping view renders without console errors / exceptions", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const errorsByRoute: Record<string, string[]> = {};
    let current = "(boot)";
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (IGNORE.test(text)) return;
      errorsByRoute[current] ??= [];
      errorsByRoute[current].push(`console.error: ${text.slice(0, 160)}`);
    });
    page.on("pageerror", (err) => {
      errorsByRoute[current] ??= [];
      errorsByRoute[current].push(
        `pageerror: ${String(err.message).slice(0, 160)}`,
      );
    });

    await waitForShellReady(page);

    for (const route of UNIQUE_ROUTES) {
      current = `${route.name} (${route.path})`;
      try {
        await gotoRoute(page, route.path);
        await expect(page.locator("#root")).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(1200); // let the view settle / async errors surface
      } catch (e) {
        errorsByRoute[current] ??= [];
        errorsByRoute[current].push(
          `navigation-error: ${String(e).slice(0, 120)}`,
        );
      }
    }

    const dirty = Object.entries(errorsByRoute).filter(([, e]) => e.length);
    console.log(
      `\n=== console-error sweep: ${UNIQUE_ROUTES.length} views walked ===`,
    );
    if (!dirty.length) {
      console.log(
        "CLEAN: no console errors / exceptions on any shipping view.",
      );
    } else {
      for (const [route, errs] of dirty) {
        console.log(`  ${route}:`);
        for (const e of [...new Set(errs)].slice(0, 4))
          console.log(`     ${e}`);
      }
    }
    // Hard exceptions/pageerrors are defects; console.error alone is reported but not failed.
    const hardFailures = dirty.filter(([, errs]) =>
      errs.some(
        (e) => e.startsWith("pageerror") || e.startsWith("navigation-error"),
      ),
    );
    expect(
      hardFailures.map(([r]) => r),
      `views threw an uncaught exception or failed to navigate`,
    ).toEqual([]);
  });
});
