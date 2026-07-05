/**
 * Playwright UI-smoke spec for the Browser Workspace app flow using the real
 * renderer fixture. Drives the #13596 folded-tab UX: tabs live in the switcher
 * overlay (opened from the toolbar's fold control), not a permanent sidebar
 * strip, so tab assertions open the switcher and read its cards.
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type BrowserWorkspaceSmokeSnapshot = {
  tabs: { id: string }[];
};

function isBrowserWorkspaceSmokeSnapshot(
  value: unknown,
): value is BrowserWorkspaceSmokeSnapshot {
  if (!value || typeof value !== "object") return false;
  const tabs = (value as { tabs?: unknown }).tabs;
  return (
    Array.isArray(tabs) &&
    tabs.every(
      (tab) =>
        Boolean(tab) &&
        typeof tab === "object" &&
        typeof (tab as { id?: unknown }).id === "string",
    )
  );
}

async function resetBrowserWorkspaceTabs(
  request: APIRequestContext,
): Promise<void> {
  const response = await request.get("/api/browser-workspace");
  expect(response.ok()).toBe(true);
  const snapshot: unknown = await response.json();
  expect(isBrowserWorkspaceSmokeSnapshot(snapshot)).toBe(true);
  if (!isBrowserWorkspaceSmokeSnapshot(snapshot)) return;

  for (const tab of snapshot.tabs) {
    const closeResponse = await request.delete(
      `/api/browser-workspace/tabs/${encodeURIComponent(tab.id)}`,
    );
    expect(closeResponse.ok()).toBe(true);
  }
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("browser workspace can create, navigate, switch, and close tabs", async ({
  page,
  request,
}) => {
  await resetBrowserWorkspaceTabs(request);
  await openAppPath(page, "/browser");
  await expect(page).toHaveURL(/\/browser$/, { timeout: 20_000 });
  const browserWorkspaceView = page.getByTestId("browser-workspace-view");
  await expect(browserWorkspaceView).toBeVisible({
    timeout: 60_000,
  });

  const newTabButton = browserWorkspaceView.getByTestId(
    "browser-workspace-nav-new-tab",
  );
  await expect(newTabButton).toBeVisible({ timeout: 120_000 });
  const addressInput = browserWorkspaceView.getByTestId(
    "browser-workspace-address-input",
  );
  await expect(addressInput).toBeVisible({ timeout: 120_000 });
  const goButton = browserWorkspaceView.getByRole("button", { name: "Go" });
  const closeAllButton = browserWorkspaceView.getByTestId(
    "browser-workspace-close-all-tabs",
  );
  const foldControl = browserWorkspaceView.getByTestId(
    "browser-workspace-tab-fold-control",
  );
  await expect(goButton).toBeVisible({ timeout: 120_000 });
  await expect(closeAllButton).toBeVisible({ timeout: 120_000 });
  await expect(foldControl).toBeVisible({ timeout: 120_000 });

  // The folded tab switcher is the only multi-tab surface (no permanent strip).
  // Opening it and reading its cards is how we assert tab state.
  const openSwitcher = async () => {
    await foldControl.click();
    return page.getByTestId("browser-workspace-tab-switcher");
  };
  const closeSwitcher = async () => {
    await page.keyboard.press("Escape");
    await expect(
      page.getByTestId("browser-workspace-tab-switcher"),
    ).toHaveCount(0);
  };

  // Empty start: the switcher shows its designed empty state, no closable tabs.
  let switcher = await openSwitcher();
  await expect(switcher.getByText("No tabs open yet")).toHaveCount(1);
  await closeSwitcher();
  await expect(addressInput).toHaveValue("");
  await expect(newTabButton).toBeEnabled();
  await expect(closeAllButton).toBeDisabled();

  await addressInput.fill("");
  await addressInput.pressSequentially("example.com");
  await expect(addressInput).toHaveValue("example.com");
  await newTabButton.click();

  // The new tab is now the active one; the fold control names it and counts 1.
  await expect(
    browserWorkspaceView.getByTestId("browser-workspace-tab-count"),
  ).toHaveText("1");
  await expect(addressInput).toHaveValue("https://example.com/");
  await expect(closeAllButton).toBeEnabled();

  switcher = await openSwitcher();
  const exampleCard = switcher.locator(
    '[role="tab"][title*="https://example.com/"]',
  );
  await expect(exampleCard).toHaveCount(1);
  await closeSwitcher();

  // Open a second (blank) tab and confirm the count grows.
  await addressInput.fill("about:blank");
  await expect(addressInput).toHaveValue("about:blank");
  await newTabButton.click();
  await expect(
    browserWorkspaceView.getByTestId("browser-workspace-tab-count"),
  ).toHaveText("2");
  await expect(addressInput).toHaveValue("about:blank");

  // Switch back to the example tab via the switcher — selecting closes it and
  // the address bar follows the picked tab.
  switcher = await openSwitcher();
  await switcher.locator('[role="tab"][title*="https://example.com/"]').click();
  await expect(page.getByTestId("browser-workspace-tab-switcher")).toHaveCount(
    0,
  );
  await expect(addressInput).toHaveValue("https://example.com/");

  await addressInput.fill("docs.elizaos.ai");
  await expect(addressInput).toHaveValue("docs.elizaos.ai");
  await goButton.click();
  await expect(addressInput).toHaveValue("https://docs.elizaos.ai/");

  // Header nav (back/forward) preserves the folded browser state.
  await openAppPath(page, "/chat");
  await expect(page).toHaveURL(/\/chat$/, { timeout: 20_000 });
  await page.goBack({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/browser$/, { timeout: 20_000 });
  await expect(browserWorkspaceView).toBeVisible({ timeout: 60_000 });
  await expect(addressInput).toHaveValue("https://docs.elizaos.ai/");
  await page.goForward({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/chat$/, { timeout: 20_000 });
  await page.goBack({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/browser$/, { timeout: 20_000 });

  // Close-all removes the user's tabs. The server re-seeds a default tab on last
  // close (#13810), so the view never gets stuck in a broken zero-tab state —
  // the fold control keeps naming an active tab. Assert the closable set is
  // gone (close-all disabled) rather than a fixed count, since the re-seed is
  // server-owned.
  await closeAllButton.click();
  await expect(closeAllButton).toBeDisabled({ timeout: 60_000 });
});
