/**
 * Playwright UI-smoke spec for the Apps Utility Interactions app flow using
 * the real renderer fixture.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { DIRECT_ROUTE_CASES } from "./apps-session-route-cases";
import {
  assertReadyChecks,
  hideChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

type RouteCase = (typeof DIRECT_ROUTE_CASES)[number];

const APP_WINDOW_ROUTE_CASES = DIRECT_ROUTE_CASES.filter(
  (routeCase) =>
    !["phone", "contacts", "wifi"].includes(routeCase.name.toLowerCase()),
);

const RED_ERROR_TEXT =
  /Could not open app|Something went wrong|Cannot read properties|Unhandled Runtime Error|Traceback|TypeError:|ReferenceError:|Failed to load VRM/i;

const BENIGN_CONSOLE_PATTERNS = [
  /THREE\.Clock: This module has been deprecated/i,
  /THREE\.WebGLShadowMap: PCFSoftShadowMap has been deprecated/i,
  /\[VrmEngine\] TSL dissolve unavailable, showing instantly/i,
  /GL Driver Message .*GPU stall due to ReadPixels/i,
  // The smoke stub already treats avatar VRM request failures as non-fatal;
  // Chromium can surface the same optional avatar fetch as a console warning.
  /Failed to load VRM: TypeError: network error/i,
  /\[eliza\]\[startup:init\] stream settings avatar TypeError: Failed to fetch/i,
];

function routeReadyChecks(routeCase: RouteCase): readonly ReadyCheck[] {
  return "readyChecks" in routeCase
    ? routeCase.readyChecks
    : [{ selector: routeCase.selector }];
}

function routeTimeout(routeCase: RouteCase): number {
  return "timeoutMs" in routeCase ? routeCase.timeoutMs : 60_000;
}

function installIssueGuards(page: Page): string[] {
  const issues: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (BENIGN_CONSOLE_PATTERNS.some((pattern) => pattern.test(text))) {
      return;
    }
    if (message.type() === "error" || RED_ERROR_TEXT.test(text)) {
      issues.push(`console ${message.type()}: ${text}`);
    }
  });
  page.on("pageerror", (error) => {
    issues.push(`pageerror: ${error.message}`);
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status < 500) return;
    const url = response.url();
    const pathname = new URL(url).pathname;
    if (!pathname.startsWith("/api/")) return;
    issues.push(`http ${status}: ${pathname}`);
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const pathname = new URL(url).pathname;
    const failureText = request.failure()?.errorText ?? "";
    if (failureText === "net::ERR_ABORTED") return;
    if (/\/api\/avatar\/(vrm|background)/.test(pathname)) return;
    issues.push(`requestfailed: ${url} ${failureText}`);
  });
  return issues;
}

async function expectNoIssues(
  page: Page,
  issues: readonly string[],
  label: string,
): Promise<void> {
  await expect(page.locator("body")).not.toContainText(RED_ERROR_TEXT);
  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(
    metrics.scrollWidth,
    `${label}: horizontal overflow (${metrics.scrollWidth} > ${metrics.innerWidth})`,
  ).toBeLessThanOrEqual(metrics.innerWidth + 2);
  expect(issues, label).toEqual([]);
}

async function openAppWindow(page: Page, routeCase: RouteCase): Promise<void> {
  await openAppPath(page, routeCase.path);
  await expect(page.locator("#root")).toBeVisible({
    timeout: routeTimeout(routeCase),
  });
  await assertReadyChecks(
    page,
    routeCase.name,
    routeReadyChecks(routeCase),
    "any",
    routeTimeout(routeCase),
  );
}

async function clickRequired(locator: Locator, label: string): Promise<void> {
  const target = locator.first();
  await expect(target, `${label} should be visible`).toBeVisible();
  await expect(target, `${label} should be enabled`).toBeEnabled();
  await target.click();
}

function visibleByTestId(page: Page, testId: string): Locator {
  return page.locator(`[data-testid="${testId}"]:visible`).first();
}

async function ensurePageSidebarVisible(
  page: Page,
  testId: string,
  label: string,
  expandTestId?: string,
): Promise<Locator> {
  const visibleSidebar = visibleByTestId(page, testId);
  if (await visibleSidebar.isVisible().catch(() => false)) {
    return visibleSidebar;
  }

  if (expandTestId) {
    const expandButton = visibleByTestId(page, expandTestId);
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
      await expect(visibleSidebar, `${label} should expand`).toBeVisible();
      return visibleSidebar;
    }
  }

  const workspacePaneLeft = visibleByTestId(
    page,
    "app-workspace-mobile-pane-left",
  );
  if (await workspacePaneLeft.isVisible().catch(() => false)) {
    if ((await workspacePaneLeft.getAttribute("aria-pressed")) !== "true") {
      await workspacePaneLeft.click();
    }
    await expect(
      visibleSidebar,
      `${label} should open from workspace pane`,
    ).toBeVisible();
    return visibleSidebar;
  }

  const pageDrawerTrigger = visibleByTestId(
    page,
    "page-layout-mobile-sidebar-trigger",
  );
  if (await pageDrawerTrigger.isVisible().catch(() => false)) {
    await pageDrawerTrigger.click();
  }

  await expect(visibleSidebar, `${label} should be visible`).toBeVisible();
  return visibleSidebar;
}

function routeCaseByName(name: string) {
  const routeCase = DIRECT_ROUTE_CASES.find((item) => item.name === name);
  expect(
    routeCase,
    `${name} must be registered as a direct route case`,
  ).toBeTruthy();
  return routeCase as RouteCase;
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page, {
    "eliza:developerMode": "1",
    "eliza:ui-theme": "dark",
    "elizaos:ui-theme": "dark",
    "eliza:wallet:enabled": "true",
    "eliza:wallets:sidebar:collapsed": "false",
    "eliza:wallets:sidebar:width": "352",
    "app-workspace-chrome:chat-collapsed": "true",
    "elizaos:ui:sidebar:primary-app-sidebar:collapsed": "false",
    "elizaos:ui:sidebar:eliza:page-sidebar:wallets:tokens:collapsed": "false",
    "elizaos:ui:sidebar:eliza:page-sidebar:wallets:defi:collapsed": "false",
    "elizaos:ui:sidebar:eliza:page-sidebar:wallets:nfts:collapsed": "false",
  });
  await installDefaultAppRoutes(page);
  await hideChatOverlay(page);
});

test("utility app-window routes render without red errors or overflow", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const issues = installIssueGuards(page);
  for (const routeCase of APP_WINDOW_ROUTE_CASES) {
    await test.step(routeCase.name, async () => {
      await openAppWindow(page, routeCase);
      await expectNoIssues(page, issues.splice(0), routeCase.name);
    });
  }
});

test("wallet inventory controls update visible deterministic state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const issues = installIssueGuards(page);
  let balanceRequestCount = 0;
  await page.route("**/api/wallet/balances", async (route) => {
    if (route.request().method() === "GET") {
      balanceRequestCount += 1;
    }
    await route.fallback();
  });
  const inventory = routeCaseByName("inventory app window");

  await openAppWindow(page, inventory);
  const walletSidebar = await ensurePageSidebarVisible(
    page,
    "wallets-sidebar",
    "wallet sidebar",
    "wallets-sidebar-expand-toggle",
  );
  await expect(walletSidebar.getByText("$1,550.50")).toBeVisible();
  await expect(
    walletSidebar.getByText("USDC", { exact: true }).first(),
  ).toBeVisible();

  // The minimal redesign dropped the manual "Refresh wallet" button: balances
  // stay current via a quiet ~20s background poll. Assert the poll re-requests
  // the deterministic balances (no user-facing refresh control).
  const requestCountBeforeRefresh = balanceRequestCount;
  await expect
    .poll(() => balanceRequestCount, {
      message: "wallet poll should request deterministic balances",
      timeout: 30_000,
    })
    .toBeGreaterThan(requestCountBeforeRefresh);

  await clickRequired(
    walletSidebar.getByRole("tab", { name: "DeFi" }),
    "Wallet DeFi tab",
  );
  await expect(walletSidebar.getByText("ETH / USDC Position")).toBeVisible();
  await expect(walletSidebar.getByText("Uniswap V3 Liquidity Pool")).toBeVisible();

  await clickRequired(
    walletSidebar.getByRole("tab", { name: "NFTs" }),
    "Wallet NFTs tab",
  );
  await expect(walletSidebar.getByText("Smoke Test NFT #42")).toBeVisible();
  await expect(
    walletSidebar.getByText("Smoke Solana Collectible"),
  ).toBeVisible();

  await clickRequired(
    walletSidebar.getByRole("tab", { name: "Tokens" }),
    "Wallet tokens tab",
  );
  await clickRequired(
    walletSidebar.getByRole("button", { name: "Manage USDC" }),
    "Wallet manage token action",
  );
  await clickRequired(page.getByText("Hide token", { exact: true }), "Hide token");
  await expect(walletSidebar.getByText("USDC", { exact: true })).toHaveCount(0);

  await clickRequired(
    walletSidebar.getByRole("button", { name: "Show wallet details" }),
    "Wallet details disclosure",
  );
  await clickRequired(
    page.getByRole("button", { name: "Network settings" }),
    "Wallet RPC settings action",
  );
  await expect(page).toHaveURL(/wallet-rpc/);
  await expect(
    page.locator("#wallet-rpc").getByText("Wallet & RPC"),
  ).toBeVisible();
  await expectNoIssues(page, issues.splice(0), "wallet inventory interactions");
});
