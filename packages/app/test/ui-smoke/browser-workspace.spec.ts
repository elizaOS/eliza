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
  const floatingLayerContract = await page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="browser-workspace-tab-switcher"]',
    );
    const chat = document.querySelector<HTMLElement>(
      '[data-testid="chat-overlay"]',
    );
    const chatSheet = document.querySelector<HTMLElement>(
      '[data-testid="chat-sheet-surface"]',
    );
    const backdrop = Array.from(
      document.querySelectorAll<HTMLElement>("[data-state='open']"),
    ).find((element) => getComputedStyle(element).zIndex === "8800");
    if (!dialog || !chat || !chatSheet || !backdrop) return null;
    return {
      dialogZ: Number(getComputedStyle(dialog).zIndex),
      backdropZ: Number(getComputedStyle(backdrop).zIndex),
      chatZ: Number(getComputedStyle(chat).zIndex),
      clearanceGap:
        chatSheet.getBoundingClientRect().top -
        dialog.getBoundingClientRect().bottom,
      clearanceAware: dialog.dataset.chatClearanceAware,
    };
  });
  expect(floatingLayerContract).not.toBeNull();
  expect(floatingLayerContract?.backdropZ).toBeLessThan(
    floatingLayerContract?.dialogZ ?? 0,
  );
  expect(floatingLayerContract?.dialogZ).toBeLessThan(
    floatingLayerContract?.chatZ ?? 0,
  );
  expect(floatingLayerContract?.clearanceGap).toBeGreaterThanOrEqual(0);
  expect(floatingLayerContract?.clearanceAware).toBe("true");
  await closeSwitcher();
  await expect(addressInput).toHaveValue("");
  await expect(newTabButton).toBeEnabled();
  await expect(closeAllButton).toBeDisabled();

  await addressInput.fill("");
  await addressInput.pressSequentially("example.com");
  await expect(addressInput).toHaveValue("example.com");
  await goButton.click();

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

  // New Tab always creates a fresh Google home context rather than cloning the
  // active page or treating an address-bar draft as an implicit destination.
  await newTabButton.click();
  await expect(
    browserWorkspaceView.getByTestId("browser-workspace-tab-count"),
  ).toHaveText("2");
  await expect(addressInput).toHaveValue("https://www.google.com/webhp?igu=1");

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

test("browser iframe focus handoff survives delayed autofocus without stealing deliberate clicks", async ({
  page,
  request,
}) => {
  await resetBrowserWorkspaceTabs(request);
  await openAppPath(page, "/browser");
  await expect(page).toHaveURL(/\/browser$/, { timeout: 20_000 });
  const browserWorkspaceView = page.getByTestId("browser-workspace-view");
  await expect(browserWorkspaceView).toBeVisible({ timeout: 60_000 });

  const appUrl = new URL(page.url());
  const fixtureOrigin = `http://localhost:${appUrl.port}`;
  await page.route(
    `${fixtureOrigin}/__browser-focus-slow.png`,
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64",
        ),
      });
    },
  );
  await page.route(
    `${fixtureOrigin}/__browser-focus-fixture**`,
    async (route) => {
      const url = new URL(route.request().url());
      const autoFocus = url.searchParams.get("auto") === "1";
      const slowLoad = url.searchParams.get("slow") === "1";
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html>
        <html>
          <body>
            <label for="focus-target">Fixture input</label>
            <input id="focus-target" data-testid="focus-target" />
            ${slowLoad ? '<img alt="slow" src="/__browser-focus-slow.png" />' : ""}
            <script>
              window.addEventListener("load", () => {
                document.body.dataset.loaded = "true";
                if (${JSON.stringify(autoFocus)}) {
                  setTimeout(() => document.querySelector("#focus-target").focus(), 120);
                }
              });
            </script>
          </body>
        </html>`,
      });
    },
  );

  const addressInput = browserWorkspaceView.getByTestId(
    "browser-workspace-address-input",
  );
  const delayedAddressUrl = `${fixtureOrigin}/__browser-focus-fixture?auto=1&case=address`;
  await addressInput.fill(delayedAddressUrl);
  await addressInput.press("Enter");
  const iframe = browserWorkspaceView.locator("iframe").first();
  await expect(iframe).toHaveAttribute("src", delayedAddressUrl, {
    timeout: 20_000,
  });
  await page.waitForTimeout(350);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.getAttribute("data-testid") ?? null,
      ),
    )
    .toBe("browser-workspace-address-input");

  const snapshotResponse = await request.get("/api/browser-workspace");
  expect(snapshotResponse.ok()).toBe(true);
  const snapshot: unknown = await snapshotResponse.json();
  expect(isBrowserWorkspaceSmokeSnapshot(snapshot)).toBe(true);
  if (!isBrowserWorkspaceSmokeSnapshot(snapshot) || !snapshot.tabs[0]) return;
  const tabId = snapshot.tabs[0].id;

  const composer = page.getByRole("combobox", { name: "message" });
  // The page may remain under a stationary pointer while the user types in
  // chat. Hover alone must not authorize a later page autofocus.
  await iframe.hover();
  await composer.focus();
  const polledAgentUrl = `${fixtureOrigin}/__browser-focus-fixture?auto=1&case=agent-poll`;
  const navigateResponse = await request.post(
    `/api/browser-workspace/tabs/${encodeURIComponent(tabId)}/navigate`,
    { data: { url: polledAgentUrl } },
  );
  expect(navigateResponse.ok()).toBe(true);
  await expect(iframe).toHaveAttribute("src", polledAgentUrl, {
    timeout: 10_000,
  });
  await page.waitForTimeout(350);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.getAttribute("data-testid") ?? null,
      ),
    )
    .toBe("chat-composer-textarea");

  await composer.focus();
  const intentionalClickUrl = `${fixtureOrigin}/__browser-focus-fixture?slow=1&case=user-click`;
  const clickNavigateResponse = await request.post(
    `/api/browser-workspace/tabs/${encodeURIComponent(tabId)}/navigate`,
    { data: { url: intentionalClickUrl } },
  );
  expect(clickNavigateResponse.ok()).toBe(true);
  await expect(iframe).toHaveAttribute("src", intentionalClickUrl, {
    timeout: 10_000,
  });
  const fixtureInput = page.frameLocator("iframe").getByTestId("focus-target");
  await fixtureInput.click();
  await page.waitForTimeout(1_800);
  await expect(fixtureInput).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName ?? null))
    .toBe("IFRAME");

  // After load, cross-origin pointer events do not bubble to the parent. A
  // genuine press must still cancel the autofocus guard without making hover
  // alone an authorization signal.
  await composer.focus();
  const postLoadClickUrl = `${fixtureOrigin}/__browser-focus-fixture?case=user-click-after-load`;
  const postLoadClickNavigateResponse = await request.post(
    `/api/browser-workspace/tabs/${encodeURIComponent(tabId)}/navigate`,
    { data: { url: postLoadClickUrl } },
  );
  expect(postLoadClickNavigateResponse.ok()).toBe(true);
  await expect(iframe).toHaveAttribute("src", postLoadClickUrl, {
    timeout: 10_000,
  });
  const loadedBody = page
    .frameLocator("iframe")
    .locator("body[data-loaded='true']");
  await expect(loadedBody).toBeVisible();
  const postLoadFixtureInput = page
    .frameLocator("iframe")
    .getByTestId("focus-target");
  await postLoadFixtureInput.click();
  await page.waitForTimeout(1_800);
  await expect(postLoadFixtureInput).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName ?? null))
    .toBe("IFRAME");
});
