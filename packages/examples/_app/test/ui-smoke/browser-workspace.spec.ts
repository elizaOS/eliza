import { expect, type Page, type Route, test } from "@playwright/test";
import { installDefaultAppMocks, openAppPath, seedAppStorage } from "./helpers";

type BrowserWorkspaceTab = {
  id: string;
  title: string;
  url: string;
  partition: string;
  visible: boolean;
  createdAt: string;
  updatedAt: string;
  lastFocusedAt: string | null;
};

function buildTab(
  partial: Partial<BrowserWorkspaceTab> = {},
): BrowserWorkspaceTab {
  const now = new Date().toISOString();
  return {
    id: partial.id ?? "tab-1",
    title: partial.title ?? "Smoke tab",
    url: partial.url ?? "about:blank",
    partition: partial.partition ?? "persist:browser-smoke",
    visible: partial.visible ?? true,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    lastFocusedAt: partial.lastFocusedAt ?? now,
  };
}

async function fulfillJson(route: Route, payload: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

async function installBrowserWorkspaceMocks(page: Page): Promise<void> {
  const tabs: BrowserWorkspaceTab[] = [
    buildTab({
      id: "tab-1",
      title: "Eliza home",
      url: "about:blank",
    }),
  ];

  const snapshot = () => ({
    mode: "web",
    tabs,
  });

  await page.route("**/api/browser-workspace", async (route) => {
    await fulfillJson(route, snapshot());
  });

  await page.route("**/api/browser-workspace/tabs", async (route) => {
    if (route.request().method() !== "POST") {
      await fulfillJson(route, snapshot());
      return;
    }

    const body = route.request().postDataJSON() as {
      url?: string;
      title?: string;
    };
    for (const tab of tabs) {
      tab.visible = false;
    }
    const tab = buildTab({
      id: `tab-${tabs.length + 1}`,
      title: body.title ?? `Workspace tab ${tabs.length + 1}`,
      url: body.url ?? "about:blank",
    });
    tabs.push(tab);
    await fulfillJson(route, { tab });
  });

  await page.route(
    "**/api/browser-workspace/tabs/*/navigate",
    async (route) => {
      const targetId = route.request().url().split("/tabs/")[1]?.split("/")[0];
      const body = route.request().postDataJSON() as { url?: string };
      const tab = tabs.find((entry) => entry.id === targetId);
      if (!tab) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "tab not found" }),
        });
        return;
      }
      tab.url = body.url ?? tab.url;
      tab.updatedAt = new Date().toISOString();
      await fulfillJson(route, { tab });
    },
  );

  await page.route("**/api/browser-workspace/tabs/*/show", async (route) => {
    const targetId = route.request().url().split("/tabs/")[1]?.split("/")[0];
    let selected: BrowserWorkspaceTab | undefined;
    for (const tab of tabs) {
      tab.visible = tab.id === targetId;
      if (tab.visible) {
        tab.lastFocusedAt = new Date().toISOString();
        selected = tab;
      }
    }
    await fulfillJson(route, { tab: selected ?? tabs[0] });
  });

  await page.route("**/api/browser-workspace/tabs/*", async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.fallback();
      return;
    }

    const targetId = route.request().url().split("/tabs/")[1];
    const index = tabs.findIndex((entry) => entry.id === targetId);
    if (index >= 0) {
      tabs.splice(index, 1);
      if (tabs.length > 0) {
        tabs[0].visible = true;
      }
    }
    await fulfillJson(route, { closed: index >= 0 });
  });

  await page.route("**/api/wallet/config", async (route) => {
    await fulfillJson(route, {
      provider: null,
      chainId: 1,
      address: null,
      enabled: false,
    });
  });
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppMocks(page);
  await installBrowserWorkspaceMocks(page);
});

test("browser workspace can load, add a tab, and switch selection", async ({
  page,
}) => {
  await openAppPath(page, "/browser");
  await expect(page.getByTestId("browser-workspace-view")).toBeVisible();
  await expect(page.getByTestId("browser-workspace-sidebar")).toBeVisible();
  const firstTabButton = page.getByRole("button", {
    name: /Eliza home about:blank/,
  });
  await expect(firstTabButton).toBeVisible();

  const addressInput = page.getByPlaceholder("Enter a URL");
  await addressInput.fill("example.com");
  await page.getByRole("button", { name: "New tab" }).click();

  const secondTabButton = page.getByRole("button", {
    name: /example\.com https:\/\/example\.com\//,
  });
  await expect(secondTabButton).toBeVisible();
  await expect(addressInput).toHaveValue("https://example.com/");

  await firstTabButton.click();
  await expect(addressInput).toHaveValue("about:blank");
});
