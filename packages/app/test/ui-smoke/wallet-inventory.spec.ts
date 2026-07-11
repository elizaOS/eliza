/**
 * Playwright UI-smoke spec for the Wallet Inventory app flow using the real
 * renderer fixture.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  hideContinuousChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

async function visibleByTestId(page: Page, testId: string): Promise<Locator> {
  const target = page.locator(`[data-testid="${testId}"]:visible`).first();
  await expect(target, `${testId} should be visible`).toBeVisible({
    timeout: 60_000,
  });
  return target;
}

async function openWalletSidebar(page: Page): Promise<Locator> {
  const sidebar = page
    .locator('[data-testid="wallets-sidebar"]:visible')
    .first();
  if (await sidebar.isVisible().catch(() => false)) {
    return sidebar;
  }

  const expandToggle = page
    .locator('[data-testid="wallets-sidebar-expand-toggle"]:visible')
    .first();
  if (await expandToggle.isVisible().catch(() => false)) {
    await expandToggle.click();
    await expect(sidebar).toBeVisible({ timeout: 60_000 });
    return sidebar;
  }

  const workspacePaneLeft = page
    .locator('[data-testid="app-workspace-mobile-pane-left"]:visible')
    .first();
  if (await workspacePaneLeft.isVisible().catch(() => false)) {
    if ((await workspacePaneLeft.getAttribute("aria-pressed")) !== "true") {
      await workspacePaneLeft.click();
    }
    await expect(sidebar).toBeVisible({ timeout: 60_000 });
    return sidebar;
  }

  const pageDrawerTrigger = page
    .locator('[data-testid="page-layout-mobile-sidebar-trigger"]:visible')
    .first();
  if (await pageDrawerTrigger.isVisible().catch(() => false)) {
    await pageDrawerTrigger.click();
  }

  await expect(sidebar).toBeVisible({ timeout: 60_000 });
  return sidebar;
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page, {
    "eliza:ui-theme": "dark",
    "elizaos:ui-theme": "dark",
    "eliza:wallet:enabled": "true",
    "eliza:wallets:sidebar:collapsed": "false",
    "eliza:wallets:sidebar:width": "352",
    "eliza:wallet:hidden-token-ids:v1": "[]",
    "app-workspace-chrome:chat-collapsed": "true",
    "elizaos:ui:sidebar:primary-app-sidebar:collapsed": "false",
    "elizaos:ui:sidebar:eliza:page-sidebar:wallets:tokens:collapsed": "false",
    "elizaos:ui:sidebar:eliza:page-sidebar:wallets:defi:collapsed": "false",
    "elizaos:ui:sidebar:eliza:page-sidebar:wallets:nfts:collapsed": "false",
  });
  await installDefaultAppRoutes(page);
  await hideContinuousChatOverlay(page);
});

test("wallet inventory exposes chain badges, rows, copy controls, and hide state", async ({
  page,
  browserName,
}) => {
  // Engine difference (documented, per-assertion — not a whole-spec skip):
  // WebKit exposes no Playwright-grantable "clipboard-read" permission and
  // gates navigator.clipboard.readText() behind a transient user gesture, so
  // the copy READ-BACK is asserted on Chromium only. Everything else —
  // badges, rows, tabs, copy-control clicks, hide state, persistence — runs
  // on every engine, including the desktop-webkit lane.
  const clipboardReadable = browserName === "chromium";
  if (clipboardReadable) {
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
  }
  await openAppPath(page, "/wallet");

  await expect(page).toHaveURL(/\/wallet$/, { timeout: 20_000 });
  const sidebar = await openWalletSidebar(page);

  await expect(sidebar.getByText("$1,550.50")).toBeVisible();
  for (const chain of ["ethereum", "base", "bsc", "avax", "solana"]) {
    await expect(
      sidebar.getByTestId(`wallet-chain-chip-${chain}`),
      `${chain} chain badge should be rendered`,
    ).toBeVisible();
  }

  await expect(
    sidebar.getByTestId("wallet-token-row-ethereum-native-eth"),
  ).toContainText("ETH");
  await expect(
    sidebar.getByTestId("wallet-token-row-ethereum-native-eth"),
  ).toContainText("$900.00");
  await expect(
    sidebar.getByTestId("wallet-token-row-ethereum-native-usdc"),
  ).toContainText("USDC");
  await expect(
    sidebar.getByTestId("wallet-token-row-solana-native-sol"),
  ).toContainText("SOL");

  await sidebar.getByTestId("wallet-copy-evm-address").click();
  if (clipboardReadable) {
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), {
        message: "EVM copy control writes the fixture address",
      })
      .toBe("0x1234567890abcdef1234567890abcdef12345678");
  }

  await sidebar.getByTestId("wallet-copy-sol-address").click();
  if (clipboardReadable) {
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), {
        message: "Solana copy control writes the fixture address",
      })
      .toBe("So11111111111111111111111111111111111111112");
  }

  await sidebar.getByTestId("wallet-tab-nfts").click();
  await expect(sidebar.getByText("Smoke Test NFT #42")).toBeVisible();
  await expect(sidebar.getByText("Smoke Solana Collectible")).toBeVisible();

  await sidebar.getByTestId("wallet-tab-defi").click();
  await expect(sidebar.getByText("No DeFi positions.")).toBeVisible();

  await sidebar.getByTestId("wallet-tab-tokens").click();
  await expect(
    sidebar.getByTestId("wallet-token-row-ethereum-native-usdc"),
  ).toBeVisible();
  await sidebar.getByTestId("wallet-token-hide-ethereum-native-usdc").click();
  await expect(
    sidebar.getByTestId("wallet-token-row-ethereum-native-usdc"),
  ).toHaveCount(0);

  await expect
    .poll(async () => {
      const raw = await page.evaluate(() =>
        window.localStorage.getItem("eliza:wallet:hidden-token-ids:v1"),
      );
      return raw ? JSON.parse(raw) : [];
    })
    .toContain("ethereum:native:usdc");

  await expect(
    await visibleByTestId(page, "wallet-copy-evm-address"),
  ).toBeEnabled();
});
