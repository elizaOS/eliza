import { expect, type Locator, type Page, test } from "@playwright/test";
import { DIRECT_ROUTE_CASES } from "./apps-session-route-cases";
import {
  assertReadyChecks,
  hideContinuousChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

type RouteCase = (typeof DIRECT_ROUTE_CASES)[number];

const FINANCE_COMMERCE_ROUTE_NAMES = [
  "hyperliquid",
  "polymarket",
  "shopify",
  "vincent",
] as const;

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
  if (routeCase.name === "companion") {
    await page.goto(
      `/?appWindow=1&qaApp=${encodeURIComponent(routeCase.name)}#${routeCase.path}`,
      {
        waitUntil: "domcontentloaded",
      },
    );
  } else if (routeCase.name === "elizamaker app window") {
    await openAppPath(page, "/chat");
  } else {
    await openAppPath(page, routeCase.path);
  }
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
  await hideContinuousChatOverlay(page);
  await seedAppStorage(page, {
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
});

test("companion app controls are interactive and error-free", async ({
  page,
}) => {
  test.skip(
    !DIRECT_ROUTE_CASES.some((routeCase) => routeCase.name === "companion"),
    "Companion app route is not registered in this smoke stack.",
  );
  const issues = installIssueGuards(page);
  let newConversationRequests = 0;
  let lastEmoteId: string | null = null;

  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() === "POST") {
      newConversationRequests += 1;
    }
    await route.fallback();
  });

  await page.route("**/api/emote", async (route) => {
    const raw = route.request().postData();
    const body = raw ? (JSON.parse(raw) as { emoteId?: string }) : {};
    lastEmoteId = typeof body.emoteId === "string" ? body.emoteId : null;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, emoteId: lastEmoteId }),
    });
  });

  const companion = DIRECT_ROUTE_CASES.find(
    (routeCase) => routeCase.name === "companion",
  );
  expect(companion).toBeTruthy();
  await openAppWindow(page, companion as RouteCase);

  await expect(page.getByTestId("companion-vrm-canvas")).toBeVisible();
  await expect(page.getByTestId("companion-vrm-stage")).toHaveAttribute(
    "data-vrm-loaded",
    "true",
    { timeout: 90_000 },
  );
  await expect(page.getByTestId("companion-root")).toHaveAttribute(
    "data-avatar-ready",
    "true",
    { timeout: 90_000 },
  );

  const headerShell = page.getByTestId("companion-header-shell");
  if ((await headerShell.count()) > 0) {
    await expect(headerShell).toBeVisible();

    const voiceToggle = page.getByTestId("companion-voice-toggle");
    const initialVoicePressed = await voiceToggle.getAttribute("aria-pressed");
    await voiceToggle.click();
    await expect(voiceToggle).not.toHaveAttribute(
      "aria-pressed",
      initialVoicePressed ?? "",
    );

    await page.getByTestId("companion-new-chat").click();
    await expect
      .poll(() => newConversationRequests, {
        message: "new chat posts a conversation request",
      })
      .toBeGreaterThan(0);

    await page.getByTestId("companion-shell-toggle-settings").click();
    await expect(page.getByTestId("companion-settings-panel")).toBeVisible();
    await page.getByTestId("settings-companion-vrm-power-efficiency").click();
    await expect(
      page.getByTestId("settings-companion-vrm-power-efficiency"),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("settings-companion-half-framerate-always").click();
    await expect(
      page.getByTestId("settings-companion-half-framerate-always"),
    ).toHaveAttribute("aria-pressed", "true");
    const backgroundToggle = page.getByTestId(
      "settings-companion-animate-when-hidden-toggle",
    );
    const initialBackgroundChecked =
      await backgroundToggle.getAttribute("aria-checked");
    await backgroundToggle.focus();
    await backgroundToggle.press("Space");
    await expect(backgroundToggle).not.toHaveAttribute(
      "aria-checked",
      initialBackgroundChecked ?? "",
    );

    await page.getByTestId("companion-shell-toggle-character").click();
    await expect(page.getByTestId("companion-character-editor")).toBeVisible();
    await page.getByTestId("companion-shell-toggle-companion").click();
    await expect(page.getByTestId("companion-vrm-stage")).toBeVisible();

    await page.getByTestId("companion-emote-toggle").click();
    await expect(page.getByTestId("emote-picker")).toBeVisible();
    await page.getByTestId("emote-picker-search").fill("wave");
    await page.getByTestId("emote-picker-item-wave").click();
    await expect.poll(() => lastEmoteId).toBe("wave");
    await page.getByTestId("emote-picker-stop").click();
    await page.getByTestId("emote-picker-close").click();
    await expect(page.getByTestId("emote-picker")).toBeHidden();
  }

  const canvas = page.getByTestId("companion-vrm-canvas");
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) {
    throw new Error("Companion VRM canvas did not produce a bounding box");
  }
  const dragStart = {
    x: canvasBox.x + canvasBox.width * 0.5,
    y: canvasBox.y + canvasBox.height * 0.35,
  };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 60, dragStart.y - 20, { steps: 5 });
  await page.mouse.up();

  await expectNoIssues(page, issues, "companion interactions");
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

test("vector browser controls search and switch projection modes", async ({
  page,
}) => {
  const issues = installIssueGuards(page);
  const vectorBrowser = {
    name: "vector-browser",
    path: "/vector-browser",
    readyChecks: [
      { selector: '[data-agent-id="vector-table"]' },
      { text: "Deterministic memory fixture" },
    ],
    timeoutMs: 90_000,
  } satisfies RouteCase;

  await openAppWindow(page, vectorBrowser);
  await expect(page.locator('[data-agent-id="vector-table"]')).toBeVisible();
  await expect(page.getByPlaceholder("Search content...")).toBeVisible();
  await expect(
    page.getByText("Deterministic memory fixture").first(),
  ).toBeVisible();

  await page.getByPlaceholder("Search content...").fill("smoke");
  await clickRequired(
    page.getByRole("button", { name: /^Search$/ }),
    "vector search",
  );
  await expect(
    page.getByText("Deterministic memory fixture").first(),
  ).toBeVisible();

  await clickRequired(
    page.getByRole("button", { name: "2D" }),
    "vector 2D projection",
  );
  await expect(page.getByRole("button", { name: "2D" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByText(/Not enough embeddings/i)).toBeVisible();

  await clickRequired(
    page.getByRole("button", { name: "3D" }),
    "vector 3D projection",
  );
  await expect(page.getByRole("button", { name: "3D" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByText(/Not enough embeddings/i)).toBeVisible();

  await clickRequired(
    page.getByRole("button", { name: "List" }),
    "vector list view",
  );
  await expect(page.getByText("Memory Detail")).toBeVisible();
  await expectNoIssues(page, issues, "vector browser interactions");
});

test("finance and commerce utility controls refresh and show fixture data", async ({
  page,
}) => {
  test.skip(
    !FINANCE_COMMERCE_ROUTE_NAMES.every((name) =>
      DIRECT_ROUTE_CASES.some((routeCase) => routeCase.name === name),
    ),
    "Finance and commerce app routes are not registered in this smoke stack.",
  );
  const issues = installIssueGuards(page);
  const openedRoutes = new Set<string>();

  const hyperliquid = routeCaseByName("hyperliquid");
  await openAppWindow(page, hyperliquid);
  openedRoutes.add(hyperliquid.path);
  await clickRequired(
    page.getByRole("button", { name: "Refresh" }),
    "Hyperliquid refresh",
  );
  await expect(page.getByRole("heading", { name: "Markets" })).toBeVisible();
  await expect(page.getByText("BTC", { exact: true })).toBeVisible();
  await expect(page.getByText("ETH", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Positions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible();
  await expectNoIssues(page, issues.splice(0), "hyperliquid refresh");

  const polymarket = routeCaseByName("polymarket");
  await openAppWindow(page, polymarket);
  openedRoutes.add(polymarket.path);
  await clickRequired(
    page.getByRole("button", { name: "Refresh" }),
    "Polymarket refresh",
  );
  await clickRequired(
    page.getByRole("button", { name: /Will the UI smoke suite stay green/i }),
    "Polymarket first market",
  );
  await expect(
    page.getByRole("heading", {
      name: /Will the UI smoke suite stay green/i,
    }),
  ).toBeVisible();
  await clickRequired(
    page.getByRole("button", { name: /Will fixture market selection work/i }),
    "Polymarket second market",
  );
  await expect(
    page.getByRole("heading", { name: /Will fixture market selection work/i }),
  ).toBeVisible();
  await expect(page.getByText("Up", { exact: true })).toBeVisible();
  await expectNoIssues(page, issues.splice(0), "polymarket refresh");

  const shopify = routeCaseByName("shopify");
  await openAppWindow(page, shopify);
  openedRoutes.add(shopify.path);
  await clickRequired(
    page.getByRole("button", { name: "Refresh" }),
    "Shopify refresh",
  );
  await expect(page.getByText("smoke-store.example").first()).toBeVisible();
  await clickRequired(
    page.getByRole("tab", { name: /Products/i }),
    "Shopify products tab",
  );
  await expect(page.getByText("Milady Hoodie")).toBeVisible();
  await page.getByPlaceholder("Search products…").fill("Sticker");
  await expect(page.getByText("Agent Sticker Pack")).toBeVisible();
  await clickRequired(
    page.getByRole("button", { name: /^Create$/ }),
    "Shopify create product",
  );
  await expect(
    page.getByRole("dialog", { name: "Create product" }),
  ).toBeVisible();
  await page.getByLabel(/Title/).fill("Coverage Tee");
  await page.getByLabel("Vendor").fill("Eliza Smoke Store");
  await page.getByLabel("Product type").fill("Apparel");
  await page.getByLabel("Base price").fill("21.38");
  await clickRequired(
    page.getByRole("button", { name: "Create product" }),
    "Shopify submit product",
  );
  await expect(
    page.getByRole("dialog", { name: "Create product" }),
  ).toBeHidden();
  await clickRequired(
    page.getByRole("tab", { name: /Orders/i }),
    "Shopify orders tab",
  );
  await clickRequired(
    page.getByRole("button", { name: /#1001/i }),
    "Shopify order row",
  );
  await expect(page.getByText("gid://shopify/Order/2001")).toBeVisible();
  await clickRequired(
    page.getByRole("tab", { name: /Inventory/i }),
    "Shopify inventory tab",
  );
  await page.getByLabel("Location").selectOption("Main Warehouse");
  await expect(page.getByText("MLDY-HOODIE")).toBeVisible();
  await clickRequired(
    page.getByRole("button", { name: "Increase inventory by 1" }).first(),
    "Shopify inventory increase",
  );
  await clickRequired(
    page.getByRole("tab", { name: /Customers/i }),
    "Shopify customers tab",
  );
  await page
    .getByPlaceholder("Search customers by name or email…")
    .fill("Grace");
  await expect(page.getByText("Grace Hopper")).toBeVisible();
  await expectNoIssues(page, issues.splice(0), "shopify interactions");

  const vincent = routeCaseByName("vincent");
  await openAppWindow(page, vincent);
  openedRoutes.add(vincent.path);
  await clickRequired(
    page.getByRole("button", { name: "Refresh" }),
    "Vincent refresh",
  );
  await expect(page.getByText("Connected to Vincent")).toBeVisible();
  await expect(page.getByText("Vincent Trading Agent")).toBeVisible();
  await expect(page.getByText("Trading Profile")).toBeVisible();
  await expect(page.getByText("Agent Wallet")).toBeVisible();
  await clickRequired(
    page.getByRole("button", { name: "Disconnect" }),
    "Vincent disconnect",
  );
  await expect(page.getByText("Not connected to Vincent")).toBeVisible();
  await expectNoIssues(page, issues.splice(0), "vincent interactions");

  expect([...openedRoutes].sort()).toEqual(
    FINANCE_COMMERCE_ROUTE_NAMES.map(
      (name) => routeCaseByName(name).path,
    ).sort(),
  );
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

  const requestCountBeforeRefresh = balanceRequestCount;
  await clickRequired(
    walletSidebar.getByRole("button", { name: "Refresh wallet" }),
    "Wallet refresh",
  );
  await expect
    .poll(() => balanceRequestCount, {
      message: "wallet refresh should request deterministic balances",
    })
    .toBeGreaterThan(requestCountBeforeRefresh);

  await clickRequired(
    walletSidebar.getByRole("button", { name: "DeFi" }),
    "Wallet DeFi tab",
  );
  await expect(walletSidebar.getByText("No positions")).toBeVisible();

  await clickRequired(
    walletSidebar.getByRole("button", { name: "NFTs" }),
    "Wallet NFTs tab",
  );
  await expect(walletSidebar.getByText("Smoke Test NFT #42")).toBeVisible();
  await expect(
    walletSidebar.getByText("Smoke Solana Collectible"),
  ).toBeVisible();

  await clickRequired(
    walletSidebar.getByRole("button", { name: "Tokens" }),
    "Wallet tokens tab",
  );
  await clickRequired(
    walletSidebar.getByRole("button", { name: "Hide USDC" }),
    "Wallet hide token action",
  );
  await expect(walletSidebar.getByText("USDC", { exact: true })).toHaveCount(0);

  await clickRequired(
    walletSidebar.getByRole("button", { name: "Open RPC settings" }),
    "Wallet RPC settings action",
  );
  await expect(page).toHaveURL(/wallet-rpc/);
  await expect(
    page.locator("#wallet-rpc").getByText("Wallet & RPC"),
  ).toBeVisible();
  await expectNoIssues(page, issues.splice(0), "wallet inventory interactions");
});

test("steward approvals and history controls consume deterministic API stubs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const issues = installIssueGuards(page);

  await openAppPath(page, "/steward");
  const stewardView = visibleByTestId(page, "steward-view");
  await expect(stewardView, "steward view should be visible").toBeVisible();
  await expect(page.getByRole("heading", { name: "Approvals" })).toBeVisible();
  await expect(page.getByText("2 pending")).toBeVisible();
  await expect(
    page.getByText("Manual approval required for UI smoke.").first(),
  ).toBeVisible();

  await clickRequired(
    page.getByRole("button", { name: "Refresh" }),
    "Steward approvals refresh",
  );
  await clickRequired(
    page.getByRole("button", { name: "Approve" }).first(),
    "Steward approve pending transaction",
  );
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(1);

  await clickRequired(
    page.getByRole("button", { name: "Reject" }).first(),
    "Steward reject pending transaction",
  );
  await page
    .getByPlaceholder("e.g., Unauthorized recipient")
    .fill("UI smoke deterministic rejection");
  await clickRequired(
    page.getByRole("button", { name: "Confirm Reject" }),
    "Steward confirm reject",
  );
  await expect(page.getByText("No pending approvals")).toBeVisible();

  await clickRequired(
    stewardView.getByRole("button", {
      name: /History/,
    }),
    "Steward history tab",
  );
  await expect(
    page.getByRole("heading", { name: "Transaction History" }),
  ).toBeVisible();
  await expect(page.getByText("2 transactions")).toBeVisible();
  const transactionTable = page.getByRole("table");
  await expect(transactionTable.getByText("Confirmed")).toBeVisible();
  await expect(transactionTable.getByText("Base")).toBeVisible();

  await page.locator("select").first().selectOption("pending");
  await expect(page.getByText("1 transaction")).toBeVisible();
  await expect(transactionTable.getByText("BSC")).toBeVisible();

  await page.locator("select").nth(1).selectOption("8453");
  await expect(page.getByText("No transactions yet")).toBeVisible();
  await expectNoIssues(page, issues.splice(0), "steward interactions");
});
