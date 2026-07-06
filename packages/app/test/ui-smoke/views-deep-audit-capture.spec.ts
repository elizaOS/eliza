// Opt-in evidence capture for the 2026-07-04 views UX audit. This is not a
// normal CI spec; it screenshots deep subviews that the broad route audit does
// not exercise: wallet tabs/family routes, browser workspace states, launcher
// pages, and the Settings -> Wallet & RPC section.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  hideContinuousChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

const OUT_DIR = path.join(
  process.cwd(),
  "test-results",
  "ui-smoke-artifacts",
  "views-ux-audit-2026-07-04",
  "deep-subviews",
);

type BrowserTab = {
  id: string;
  title: string;
  url: string;
  partition: string;
  visible: boolean;
  createdAt: string;
  updatedAt: string;
  lastFocusedAt: string | null;
  status: string | null;
};

const VIEWPORTS = [
  { name: "desktop", size: { width: 1440, height: 1000 } },
  { name: "mobile", size: { width: 390, height: 844 } },
] as const;

async function screenshot(page: Page, name: string): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    attempts: 4,
    fullPage: true,
    path: path.join(OUT_DIR, `${name}.png`),
    type: "png",
  });
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    path.join(OUT_DIR, `${name}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function normalizedBrowserUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value || value === "about:blank") return "about:blank";
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return value;
  return `https://${value.replace(/^\/+/, "")}/`;
}

function tabTitle(url: string): string {
  if (url === "about:blank") return "New tab";
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function installBrowserWorkspaceAuditRoutes(page: Page): Promise<void> {
  const tabs: BrowserTab[] = [];
  let nextId = 1;
  const now = () => "2026-01-01T00:00:00.000Z";
  const snapshot = () => ({ mode: "web", tabs });

  function showOnly(id: string): BrowserTab | null {
    let selected: BrowserTab | null = null;
    for (const tab of tabs) {
      tab.visible = tab.id === id;
      if (tab.visible) {
        tab.lastFocusedAt = now();
        selected = tab;
      }
    }
    return selected;
  }

  await page.route("**/api/browser-workspace", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify(snapshot()),
    });
  });

  await page.route("**/api/browser-workspace/tabs", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify(snapshot()),
      });
      return;
    }
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = request.postDataJSON() as { url?: string; title?: string };
    const url = normalizedBrowserUrl(body.url);
    const tab: BrowserTab = {
      id: `audit-tab-${nextId++}`,
      title: body.title ?? tabTitle(url),
      url,
      partition: "persist:audit",
      visible: true,
      createdAt: now(),
      updatedAt: now(),
      lastFocusedAt: now(),
      status: "ready",
    };
    for (const existing of tabs) existing.visible = false;
    tabs.push(tab);
    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify({ tab }),
    });
  });

  await page.route(
    "**/api/browser-workspace/tabs/*/navigate",
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const id = decodeURIComponent(
        new URL(route.request().url()).pathname.split("/").at(-2) ?? "",
      );
      const body = route.request().postDataJSON() as { url?: string };
      const tab = tabs.find((entry) => entry.id === id);
      if (!tab) {
        await route.fulfill({
          status: 404,
          body: JSON.stringify({ error: "not found" }),
        });
        return;
      }
      tab.url = normalizedBrowserUrl(body.url);
      tab.title = tabTitle(tab.url);
      tab.updatedAt = now();
      showOnly(tab.id);
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({ tab }),
      });
    },
  );

  await page.route("**/api/browser-workspace/tabs/*/show", async (route) => {
    const id = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").at(-2) ?? "",
    );
    const tab = showOnly(id);
    await route.fulfill({
      contentType: "application/json",
      status: tab ? 200 : 404,
      body: JSON.stringify(tab ? { tab } : { error: "not found" }),
    });
  });

  await page.route("**/api/browser-workspace/tabs/*", async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.fallback();
      return;
    }
    const id = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").pop() ?? "",
    );
    const index = tabs.findIndex((entry) => entry.id === id);
    if (index >= 0) tabs.splice(index, 1);
    if (tabs.length > 0 && !tabs.some((tab) => tab.visible)) {
      tabs[tabs.length - 1].visible = true;
    }
    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify({ closed: index >= 0 }),
    });
  });

  await page.route("**/api/browser-bridge/**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const url = route.request().url();
    const body = url.includes("/companions")
      ? { companions: [] }
      : {
          chrome: { installed: false, version: null },
          safari: { installed: false, version: null },
        };
    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify(body),
    });
  });
}

async function openWalletSidebar(page: Page): Promise<Locator> {
  const sidebar = page
    .locator('[data-testid="wallets-sidebar"]:visible')
    .first();
  if (await sidebar.isVisible().catch(() => false)) return sidebar;
  const expand = page
    .locator('[data-testid="wallets-sidebar-expand-toggle"]:visible')
    .first();
  if (await expand.isVisible().catch(() => false)) {
    await expand.click();
    await expect(sidebar).toBeVisible({ timeout: 60_000 });
    return sidebar;
  }
  const pane = page
    .locator('[data-testid="app-workspace-mobile-pane-left"]:visible')
    .first();
  if (await pane.isVisible().catch(() => false)) {
    await pane.click();
    await expect(sidebar).toBeVisible({ timeout: 60_000 });
    return sidebar;
  }
  return sidebar;
}

async function advanceLauncherPage(page: Page): Promise<boolean> {
  const secondPage = page.getByTestId("launcher-page-1");
  if ((await secondPage.count()) === 0) return false;
  const next = page.getByTestId("launcher-pager-edge-next");
  if ((await next.count()) > 0) {
    await next.click();
    await expect(secondPage).toHaveAttribute("aria-hidden", "false");
    return true;
  }
  return false;
}

test.describe("views deep UX audit capture", () => {
  test.skip(
    process.env.ELIZA_VIEWS_DEEP_AUDIT !== "1",
    "deep views audit capture is opt-in",
  );

  for (const viewport of VIEWPORTS) {
    test(`capture wallet family @ ${viewport.name}`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(viewport.size);
      await seedAppStorage(page, {
        "eliza:wallet:enabled": "true",
        "eliza:wallets:sidebar:collapsed": "false",
        "eliza:wallets:sidebar:width": "352",
        "elizaos:ui:sidebar:eliza:page-sidebar:wallets:tokens:collapsed":
          "false",
        "elizaos:ui:sidebar:eliza:page-sidebar:wallets:defi:collapsed": "false",
        "elizaos:ui:sidebar:eliza:page-sidebar:wallets:nfts:collapsed": "false",
      });
      await installDefaultAppRoutes(page);

      await openAppPath(page, "/wallet");
      await expect(page.getByTestId("wallet-shell")).toBeVisible({
        timeout: 60_000,
      });
      const sidebar = await openWalletSidebar(page);
      await screenshot(page, `${viewport.name}-wallet-overview`);
      for (const tab of ["tokens", "defi", "nfts"] as const) {
        const tabButton = sidebar.getByTestId(`wallet-tab-${tab}`);
        if (await tabButton.isVisible().catch(() => false)) {
          await tabButton.click();
          await page.waitForTimeout(300);
          await screenshot(page, `${viewport.name}-wallet-${tab}`);
        }
      }

      await openAppPath(page, "/hyperliquid");
      await page.waitForTimeout(800);
      await screenshot(page, `${viewport.name}-wallet-perps-hyperliquid`);

      await openAppPath(page, "/polymarket");
      await page.waitForTimeout(800);
      await screenshot(page, `${viewport.name}-wallet-predictions-polymarket`);
    });

    test(`capture browser workspace states @ ${viewport.name}`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(viewport.size);
      await seedAppStorage(page);
      await installDefaultAppRoutes(page);
      await installBrowserWorkspaceAuditRoutes(page);

      await openAppPath(page, "/browser");
      const view = page.getByTestId("browser-workspace-view");
      await expect(view).toBeVisible({ timeout: 60_000 });
      await screenshot(page, `${viewport.name}-browser-empty`);

      const addressInput = page.getByTestId("browser-workspace-address-input");
      await addressInput.fill("example.com");
      await page.getByTestId("browser-workspace-nav-new-tab").click();
      await expect(addressInput).toHaveValue("https://example.com/");
      await page.waitForTimeout(500);
      await screenshot(page, `${viewport.name}-browser-example-tab`);

      await addressInput.fill("docs.elizaos.ai");
      await view.getByRole("button", { name: "Go" }).click();
      await expect(addressInput).toHaveValue("https://docs.elizaos.ai/");
      await page.waitForTimeout(500);
      await screenshot(page, `${viewport.name}-browser-docs-navigation`);
    });

    test(`capture launcher pages and wallet-rpc settings @ ${viewport.name}`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(viewport.size);
      await seedAppStorage(page, {
        "eliza:wallet:enabled": "true",
      });
      await installDefaultAppRoutes(page);
      await hideContinuousChatOverlay(page);

      await openAppPath(page, "/views");
      await expect(page.getByTestId("launcher")).toBeVisible({
        timeout: 60_000,
      });
      await screenshot(page, `${viewport.name}-launcher-page-0`);
      const advanced = await advanceLauncherPage(page);
      if (advanced) {
        await page.waitForTimeout(300);
        await screenshot(page, `${viewport.name}-launcher-page-1`);
      }

      await page.goto("/settings", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("settings-shell")).toBeVisible({
        timeout: 60_000,
      });
      const walletRpcButton = page
        .getByRole("button", { name: /^Wallet & RPC(?:\s+On)?$/ })
        .first();
      await expect(walletRpcButton).toBeVisible({ timeout: 10_000 });
      await walletRpcButton.click();
      await expect(page.getByTestId("wallet-keys-section")).toBeVisible({
        timeout: 60_000,
      });
      await screenshot(page, `${viewport.name}-settings-wallet-rpc`);

      await writeJson(`${viewport.name}-deep-audit-observations`, {
        viewport: viewport.name,
        launcherPage1Captured: advanced,
        walletRpcReached: true,
      });
    });
  }
});
