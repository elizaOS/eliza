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

test("browser workspace can create live tabs and switch selection", async ({
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

  const tabsSurface = browserWorkspaceView;

  const newTabButton = tabsSurface.getByTestId("browser-workspace-nav-new-tab");
  await expect(newTabButton).toBeVisible({ timeout: 120_000 });
  const addressInput = browserWorkspaceView.locator("input").first();
  await expect(addressInput).toBeVisible({ timeout: 120_000 });
  const goButton = browserWorkspaceView.getByRole("button", { name: "Go" });
  await expect(goButton).toBeVisible({ timeout: 120_000 });
  const chatSidebar = browserWorkspaceView.getByTestId(
    "browser-workspace-view-chat-sidebar",
  );
  await expect(chatSidebar).toBeVisible({ timeout: 120_000 });
  const chatSidebarBox = await chatSidebar.boundingBox();
  const addressInputBox = await addressInput.boundingBox();
  if (!chatSidebarBox || !addressInputBox) {
    throw new Error("Browser workspace layout elements did not render boxes.");
  }
  expect(chatSidebarBox.y).toBeLessThan(addressInputBox.y);

  await expect(tabsSurface.getByText("No browser tabs yet")).toBeVisible({
    timeout: 120_000,
  });
  await expect(addressInput).toHaveValue("");
  await expect(newTabButton).toBeEnabled();

  await addressInput.fill("");
  await addressInput.pressSequentially("example.com");
  await expect(addressInput).toHaveValue("example.com");
  await newTabButton.click();

  const exampleTabButton = tabsSurface.locator(
    '[role="tab"][title="https://example.com/"]',
  );
  await expect(exampleTabButton).toHaveCount(1);
  await expect(exampleTabButton).toHaveAttribute(
    "title",
    "https://example.com/",
  );
  await expect(addressInput).toHaveValue("https://example.com/");

  const blankTabButtons = tabsSurface.locator(
    '[role="tab"][title="about:blank"]',
  );
  const blankTabCount = await blankTabButtons.count();
  await addressInput.fill("about:blank");
  await expect(addressInput).toHaveValue("about:blank");
  await newTabButton.click();
  await expect(blankTabButtons).toHaveCount(blankTabCount + 1);

  const blankTabButton = blankTabButtons.nth(blankTabCount);
  await expect(blankTabButton).toHaveAttribute("title", "about:blank");
  await expect(addressInput).toHaveValue("about:blank");
});
