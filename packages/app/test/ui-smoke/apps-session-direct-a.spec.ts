import { expect, test } from "@playwright/test";
import { DIRECT_ROUTE_CASES, escapeRegExp } from "./apps-session-route-cases";
import {
  assertReadyChecks,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const ROUTE_CASES = DIRECT_ROUTE_CASES.slice(0, 7);

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

for (const routeCase of ROUTE_CASES) {
  test(`direct ${routeCase.name} route boots the app shell`, async ({
    page,
  }) => {
    await openAppPath(page, routeCase.path);
    await expect(page).toHaveURL(
      new RegExp(`${escapeRegExp(routeCase.path)}$`),
    );
    if ("readyChecks" in routeCase) {
      await assertReadyChecks(
        page,
        routeCase.name,
        routeCase.readyChecks,
        "any",
        routeCase.timeoutMs,
      );
      return;
    }
    await assertReadyChecks(
      page,
      routeCase.name,
      [{ selector: routeCase.selector }],
      "any",
      "timeoutMs" in routeCase ? routeCase.timeoutMs : undefined,
    );
  });
}
