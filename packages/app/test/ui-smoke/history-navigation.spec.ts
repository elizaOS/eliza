/**
 * Playwright UI-smoke spec for the History Navigation app flow using the real
 * renderer fixture.
 */
import { expect, test } from "@playwright/test";
import {
  assertReadyChecks,
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type HistoryRoute = {
  name: string;
  path: string;
  readyChecks: Parameters<typeof assertReadyChecks>[2];
  mode?: Parameters<typeof assertReadyChecks>[3];
};

const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';

const HISTORY_ROUTES = [
  {
    name: "chat",
    path: "/chat",
    readyChecks: [{ selector: CHAT_COMPOSER_SELECTOR }],
    mode: "all",
  },
  {
    name: "settings",
    path: "/settings",
    readyChecks: [{ selector: '[data-testid="settings-shell"]' }],
    mode: "all",
  },
  {
    name: "character",
    path: "/character",
    readyChecks: [{ selector: '[data-testid="character-editor-view"]' }],
    mode: "all",
  },
] as const satisfies readonly HistoryRoute[];

async function prepareHistoryPage(page: Parameters<typeof seedAppStorage>[0]) {
  installPageDiagnosticsGuard(page);
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await page.route("**/api/extension/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ installed: false, connected: false }),
    });
  });
  await page.route("**/api/skills/curated", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ skills: [] }),
    });
  });
}

async function expectRouteReady(
  page: Parameters<typeof seedAppStorage>[0],
  route: HistoryRoute,
): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`${route.path}$`), {
    timeout: 60_000,
  });
  await assertReadyChecks(
    page,
    `history ${route.name}`,
    route.readyChecks,
    route.mode ?? "any",
    60_000,
  );
}

test.describe("browser history navigation", () => {
  test.afterEach(async ({ page }) => {
    // Wait for API fixture handlers before disposing their page, preserving
    // handler failures while navigation requests are still settling.
    await page.unrouteAll({ behavior: "wait" });
  });

  test("preserves route state across back and forward navigation", async ({
    page,
  }) => {
    await prepareHistoryPage(page);

    await openAppPath(page, "/chat");
    await expectRouteReady(page, HISTORY_ROUTES[0]);
    await openAppPath(page, "/settings");
    await expectRouteReady(page, HISTORY_ROUTES[1]);
    await openAppPath(page, "/character");
    await expectRouteReady(page, HISTORY_ROUTES[2]);

    await page.goBack({ waitUntil: "domcontentloaded" });
    await expectRouteReady(page, HISTORY_ROUTES[1]);
    await page.goBack({ waitUntil: "domcontentloaded" });
    await expectRouteReady(page, HISTORY_ROUTES[0]);
    await page.goForward({ waitUntil: "domcontentloaded" });
    await expectRouteReady(page, HISTORY_ROUTES[1]);
    await page.goForward({ waitUntil: "domcontentloaded" });
    await expectRouteReady(page, HISTORY_ROUTES[2]);

    await expectNoPageDiagnostics(page, "history back-forward route stack");
  });

  test("survives repeated direct route sequences and history rewinds", async ({
    page,
  }) => {
    await prepareHistoryPage(page);

    const sequence = [
      HISTORY_ROUTES[0],
      HISTORY_ROUTES[2],
      HISTORY_ROUTES[1],
      HISTORY_ROUTES[0],
    ] as const;

    await openAppPath(page, sequence[0].path);
    await expectRouteReady(page, sequence[0]);

    for (const route of sequence.slice(1)) {
      await openAppPath(page, route.path);
      await expectRouteReady(page, route);
    }

    for (let i = sequence.length - 2; i >= 0; i--) {
      await page.goBack({ waitUntil: "domcontentloaded" });
      await expectRouteReady(page, sequence[i]);
    }

    await expectNoPageDiagnostics(page, "history direct route sequence");
  });
});
