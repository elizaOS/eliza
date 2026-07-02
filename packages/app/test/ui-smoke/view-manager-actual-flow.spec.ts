import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  assertReadyChecks,
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

type DynamicViewManifest = {
  id: string;
  title: string;
  description?: string;
  source?: string;
  entrypoint: string;
  placement?: string;
};

type ViewEntry = {
  id: string;
  label: string;
  viewType?: "gui" | "tui" | "xr";
  viewKind?: "system" | "release" | "developer" | "preview";
  description?: string;
  path: string;
  available: boolean;
  pluginName: string;
  builtin?: boolean;
  tags: string[];
  desktopTabEnabled: boolean;
  bundleUrl?: string;
  componentExport?: string;
  visibleInManager?: boolean;
};

const SCREENSHOT_DIR = path.join(
  process.cwd(),
  "aesthetic-audit-output",
  "view-manager-actual-flow",
);

function viewFromManifest(manifest: DynamicViewManifest): ViewEntry {
  const entrypoint = manifest.entrypoint;
  const isRemote =
    manifest.id.includes("remote") || /^https?:\/\//.test(entrypoint);
  return {
    id: manifest.id,
    label: manifest.title,
    viewType: "gui",
    viewKind: "release",
    description: manifest.description,
    path: `/apps/${manifest.id}`,
    available: true,
    pluginName: isRemote ? "actual-remote-plugin" : "actual-local-plugin",
    tags: isRemote ? ["remote", "actual-app"] : ["local", "actual-app"],
    desktopTabEnabled: true,
    visibleInManager: true,
    bundleUrl: isRemote ? entrypoint : undefined,
    componentExport: "default",
  };
}

function simpleViewBundle(testId: string, label: string, text: string): string {
  return [
    'const ReactModule = await window.__ELIZA_DYNAMIC_VIEW_IMPORT__("react");',
    "const React = ReactModule.default ?? ReactModule;",
    "export default function SimpleView() {",
    "  return React.createElement(",
    '    "section",',
    `    { "data-testid": ${JSON.stringify(testId)}, "aria-label": ${JSON.stringify(label)} },`,
    `    ${JSON.stringify(text)}`,
    "  );",
    "}",
  ].join("\n");
}

async function screenshot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: false,
    attempts: 4,
  });
}

async function activeLauncherPageIndex(page: Page): Promise<number> {
  const pages = page.locator('[data-testid^="launcher-page-"]');
  const pageCount = await pages.count();
  for (let index = 0; index < pageCount; index += 1) {
    const candidate = pages.nth(index);
    const testId = await candidate.getAttribute("data-testid");
    const pageIndex = testId?.match(/^launcher-page-(\d+)$/)?.[1];
    if (pageIndex == null) continue;
    if ((await candidate.getAttribute("aria-hidden")) !== "true") {
      return Number(pageIndex);
    }
  }
  return 0;
}

async function swipeLauncherPage(
  page: Page,
  direction: "next" | "previous",
): Promise<void> {
  const target = page.getByTestId("launcher-page-window").first();
  const box = await target.boundingBox();
  if (!box) throw new Error("launcher page window is not laid out");
  const y = box.y + box.height * 0.45;
  const startX =
    direction === "next" ? box.x + box.width * 0.78 : box.x + box.width * 0.22;
  const endX =
    direction === "next" ? box.x + box.width * 0.22 : box.x + box.width * 0.78;
  await target.evaluate(
    (node, gesture) => {
      const element = node as HTMLElement;
      const dispatch = (
        type: "pointerdown" | "pointermove" | "pointerup",
        clientX: number,
      ) => {
        element.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: "touch",
            isPrimary: true,
            clientX,
            clientY: gesture.y,
            buttons: type === "pointerup" ? 0 : 1,
          }),
        );
      };

      dispatch("pointerdown", gesture.startX);
      for (let step = 1; step <= 8; step += 1) {
        dispatch(
          "pointermove",
          gesture.startX + (gesture.endX - gesture.startX) * (step / 8),
        );
      }
      dispatch("pointerup", gesture.endX);
    },
    { startX, endX, y },
  );
}

async function openViewManager(page: Page): Promise<void> {
  if (page.url() === "about:blank") {
    await openAppPath(page, "/views");
  } else {
    await page.evaluate(() => {
      window.history.pushState(null, "", "/views");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
  }
  await assertReadyChecks(
    page,
    "view manager dynamic controls",
    [{ selector: 'form[aria-label="Dynamic view management"]' }],
    "all",
    90_000,
  );
}

function launcherTile(page: Page, viewId: string) {
  return page.getByTestId(`launcher-tile-${viewId}`).first();
}

async function expectLauncherTile(page: Page, viewId: string): Promise<void> {
  await expect(launcherTile(page, viewId)).toBeVisible();
}

function viewLaunchButton(page: Page, viewId: string) {
  return launcherTile(page, viewId).getByRole("button").first();
}

async function revealLauncherTile(page: Page, viewId: string): Promise<void> {
  const tile = launcherTile(page, viewId);
  await expect(tile).toBeAttached();
  const pageTestId = await tile.evaluate((node) =>
    node
      .closest('[data-testid^="launcher-page-"]')
      ?.getAttribute("data-testid"),
  );
  const pageIndex = pageTestId?.match(/^launcher-page-(\d+)$/)?.[1];
  if (pageIndex == null) return;

  const pageLocator = page.getByTestId(`launcher-page-${pageIndex}`);
  if ((await pageLocator.getAttribute("aria-hidden")) === "true") {
    const targetPageIndex = Number(pageIndex);
    const pageButton = page.getByRole("button", {
      name: `Page ${targetPageIndex + 1}`,
    });
    if ((await pageButton.count()) > 0) {
      await pageButton.click();
    } else {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const activePageIndex = await activeLauncherPageIndex(page);
        if (activePageIndex === targetPageIndex) break;
        await swipeLauncherPage(
          page,
          targetPageIndex > activePageIndex ? "next" : "previous",
        );
        await page.waitForTimeout(350);
      }
    }
    await expect(pageLocator).toHaveAttribute("aria-hidden", "false");
  }
}

async function launchLauncherView(page: Page, viewId: string): Promise<void> {
  await revealLauncherTile(page, viewId);
  await viewLaunchButton(page, viewId).click();
}

async function longPressLauncherView(
  page: Page,
  viewId: string,
): Promise<void> {
  await revealLauncherTile(page, viewId);
  const button = viewLaunchButton(page, viewId);
  const box = await button.boundingBox();
  if (!box) throw new Error(`launcher tile ${viewId} is not laid out`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.up();
}

async function editModeVisible(page: Page): Promise<boolean> {
  const badge = page.locator('[data-testid^="launcher-fav-"]').first();
  if ((await badge.count()) === 0) return false;
  return badge.isVisible().catch(() => false);
}

async function enterLauncherEditMode(
  page: Page,
  viewId: string,
): Promise<void> {
  if (!(await editModeVisible(page))) {
    await longPressLauncherView(page, viewId);
  }
  await expect(
    page.locator('[data-testid^="launcher-fav-"]').first(),
  ).toBeVisible();
}

async function exitLauncherEditMode(page: Page, viewId: string): Promise<void> {
  if (await editModeVisible(page)) {
    await longPressLauncherView(page, viewId);
  }
  await expect(
    page.locator('[data-testid^="launcher-fav-"]').first(),
  ).toHaveCount(0);
}

async function editLauncherView(page: Page, viewId: string): Promise<void> {
  await enterLauncherEditMode(page, viewId);
  await page.getByTestId(`launcher-edit-${viewId}`).click();
}

async function deleteLauncherView(page: Page, viewId: string): Promise<void> {
  await enterLauncherEditMode(page, viewId);
  await page.getByTestId(`launcher-delete-${viewId}`).click();
}

async function installElectrobunDynamicViewBridge(
  page: Page,
  options: {
    register: (payload: {
      manifest: DynamicViewManifest;
      update?: boolean;
    }) => Promise<DynamicViewManifest>;
    unregister: (payload: { viewId: string }) => Promise<{ removed: boolean }>;
  },
): Promise<void> {
  await page.exposeFunction("__actualViewRegister", options.register);
  await page.exposeFunction("__actualViewUnregister", options.unregister);
  await page.addInitScript(() => {
    localStorage.setItem("eliza:developerMode", "1");
    const win = window as Window & {
      __electrobunWindowId?: number;
      __ELIZA_ELECTROBUN_RPC__?: unknown;
      __actualViewRegister?: (payload: unknown) => Promise<unknown>;
      __actualViewUnregister?: (payload: unknown) => Promise<unknown>;
    };
    win.__electrobunWindowId = 1;
    win.__ELIZA_ELECTROBUN_RPC__ = {
      onMessage: () => undefined,
      offMessage: () => undefined,
      request: {
        dynamicViewRegister: (payload: unknown) =>
          win.__actualViewRegister?.(payload),
        dynamicViewUnregister: (payload: unknown) =>
          win.__actualViewUnregister?.(payload),
      },
    };
  });
}

test.beforeEach(({ page }) => {
  installPageDiagnosticsGuard(page);
});

test.afterEach(async ({ page }, testInfo) => {
  await expectNoPageDiagnostics(page, testInfo.title);
});

test("actual app view manager creates, updates, switches, opens, and deletes local and remote dynamic views", async ({
  page,
}) => {
  await rm(SCREENSHOT_DIR, { force: true, recursive: true });
  await seedAppStorage(page, { "eliza:developerMode": "1" });
  await installDefaultAppRoutes(page);

  const views = new Map<string, ViewEntry>([
    [
      "local-notes",
      {
        id: "local-notes",
        label: "Local Notes",
        viewType: "gui",
        viewKind: "release",
        description: "Built-in local notes view",
        path: "/apps/local-notes",
        available: true,
        pluginName: "core",
        builtin: true,
        tags: ["local"],
        desktopTabEnabled: true,
        visibleInManager: true,
      },
    ],
    [
      "shopify",
      {
        id: "shopify",
        label: "Shopify",
        viewType: "gui",
        viewKind: "developer",
        description: "Shopify storefront view for view switching QA",
        path: "/shopify",
        available: true,
        pluginName: "@elizaos/plugin-shopify",
        tags: ["shopify", "qa"],
        desktopTabEnabled: true,
        bundleUrl: "/api/views/shopify/bundle.js",
        componentExport: "default",
        visibleInManager: true,
      },
    ],
  ]);
  let remoteBundleRequests = 0;
  const registerCalls: Array<{
    id: string;
    title: string;
    entrypoint: string;
    update: boolean;
  }> = [];
  const unregisterCalls: string[] = [];

  await installElectrobunDynamicViewBridge(page, {
    async register(payload) {
      registerCalls.push({
        id: payload.manifest.id,
        title: payload.manifest.title,
        entrypoint: payload.manifest.entrypoint,
        update: payload.update === true,
      });
      views.set(payload.manifest.id, viewFromManifest(payload.manifest));
      return payload.manifest;
    },
    async unregister(payload) {
      unregisterCalls.push(payload.viewId);
      const removed = views.delete(payload.viewId);
      return { removed };
    },
  });

  await page.route("**/api/views**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/views/shopify/bundle.js") {
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: simpleViewBundle("shopify-view", "Shopify", "Shopify storefront"),
      });
      return;
    }
    const allViews = [...views.values()];
    if (url.pathname === "/api/views/search") {
      const query = (url.searchParams.get("q") ?? "").toLowerCase();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          results: allViews.filter((view) =>
            [view.id, view.label, view.description, view.pluginName]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(query),
          ),
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ views: allViews }),
    });
  });

  await page.route(
    "**/dynamic-views/actual-remote-ledger.js",
    async (route) => {
      remoteBundleRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: [
          "export default function ActualRemoteLedgerView() {",
          "  return 'Actual remote ledger module loaded';",
          "}",
        ].join("\n"),
      });
    },
  );

  await openViewManager(page);
  await expect(
    page.getByRole("form", { name: "Dynamic view management" }),
  ).toBeVisible();
  await expectLauncherTile(page, "local-notes");
  await expectLauncherTile(page, "shopify");
  await screenshot(page, "00-view-manager-ready");

  await page.getByLabel("Dynamic view ID").fill("actual-local-ledger");
  await page.getByLabel("Dynamic view title").fill("Actual Local Ledger");
  await page
    .getByLabel("Dynamic view entrypoint")
    .fill("/dynamic-views/actual-local-ledger.js");
  await page
    .getByLabel("Dynamic view description")
    .fill("Actual local managed view");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("status")).toContainText(
    "Saved Actual Local Ledger.",
  );
  expect(registerCalls.at(-1)).toEqual({
    id: "actual-local-ledger",
    title: "Actual Local Ledger",
    entrypoint: "/dynamic-views/actual-local-ledger.js",
    update: true,
  });
  await expectLauncherTile(page, "actual-local-ledger");
  await screenshot(page, "01-local-created");

  await launchLauncherView(page, "actual-local-ledger");
  await expect(page).toHaveURL(/\/apps\/actual-local-ledger$/);
  await openViewManager(page);

  await editLauncherView(page, "actual-local-ledger");
  await expect(page.getByLabel("Dynamic view ID")).toHaveValue(
    "actual-local-ledger",
  );
  await page
    .getByLabel("Dynamic view title")
    .fill("Actual Local Ledger Updated");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Saved Actual Local Ledger Updated.",
  );
  expect(registerCalls.at(-1)).toEqual({
    id: "actual-local-ledger",
    title: "Actual Local Ledger Updated",
    entrypoint: "/apps/actual-local-ledger",
    update: true,
  });
  await expectLauncherTile(page, "actual-local-ledger");
  await expect(page.getByText(/^Actual Local Ledger$/)).toHaveCount(0);
  await exitLauncherEditMode(page, "actual-local-ledger");

  await page.getByLabel("Dynamic view ID").fill("actual-remote-ledger");
  await page.getByLabel("Dynamic view title").fill("Actual Remote Ledger");
  await page
    .getByLabel("Dynamic view entrypoint")
    .fill("/dynamic-views/actual-remote-ledger.js");
  await page
    .getByLabel("Dynamic view description")
    .fill("Actual remote managed view");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("status")).toContainText(
    "Saved Actual Remote Ledger.",
  );
  expect(registerCalls.at(-1)).toEqual({
    id: "actual-remote-ledger",
    title: "Actual Remote Ledger",
    entrypoint: "/dynamic-views/actual-remote-ledger.js",
    update: true,
  });
  await expectLauncherTile(page, "actual-remote-ledger");
  await screenshot(page, "02-remote-created");

  await launchLauncherView(page, "actual-local-ledger");
  await expect(page).toHaveURL(/\/apps\/actual-local-ledger$/);
  expect(
    remoteBundleRequests,
    "opening the local dynamic view must not import the remote bundle",
  ).toBe(0);
  await screenshot(page, "03-local-switched");

  await openViewManager(page);

  await launchLauncherView(page, "actual-remote-ledger");
  await expect(page).toHaveURL(/\/apps\/actual-remote-ledger$/);
  await expect(
    page.getByText("Actual remote ledger module loaded"),
  ).toBeVisible();
  expect(remoteBundleRequests).toBeGreaterThan(0);
  await screenshot(page, "04-remote-module-loaded");

  await openViewManager(page);
  await editLauncherView(page, "actual-remote-ledger");
  await page
    .getByLabel("Dynamic view title")
    .fill("Actual Remote Ledger Updated");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Saved Actual Remote Ledger Updated.",
  );
  expect(registerCalls.at(-1)).toEqual({
    id: "actual-remote-ledger",
    title: "Actual Remote Ledger Updated",
    entrypoint: "/dynamic-views/actual-remote-ledger.js",
    update: true,
  });
  await expectLauncherTile(page, "actual-remote-ledger");
  await expect(page.getByText(/^Actual Remote Ledger$/)).toHaveCount(0);
  await exitLauncherEditMode(page, "actual-remote-ledger");

  const remoteRequestsAfterFirstOpen = remoteBundleRequests;
  await launchLauncherView(page, "actual-remote-ledger");
  await expect(page).toHaveURL(/\/apps\/actual-remote-ledger$/);
  await expect(
    page.getByText("Actual remote ledger module loaded"),
  ).toBeVisible();
  expect(remoteBundleRequests).toBeGreaterThanOrEqual(
    remoteRequestsAfterFirstOpen,
  );
  await screenshot(page, "05-remote-updated-reopened");

  await openViewManager(page);

  await launchLauncherView(page, "shopify");
  await expect(page).toHaveURL(/\/shopify$/);
  await expect(page.getByTestId("shopify-view")).toBeVisible();
  await screenshot(page, "06-shopify-open");
  await openViewManager(page);

  await deleteLauncherView(page, "actual-remote-ledger");
  expect(unregisterCalls.at(-1)).toBe("actual-remote-ledger");
  await expect(page.getByRole("status")).toContainText(
    "Deleted Actual Remote Ledger Updated.",
  );
  await expect(launcherTile(page, "actual-remote-ledger")).toHaveCount(0);
  await deleteLauncherView(page, "actual-local-ledger");
  expect(unregisterCalls.at(-1)).toBe("actual-local-ledger");
  await expect(page.getByRole("status")).toContainText(
    "Deleted Actual Local Ledger Updated.",
  );
  await expect(launcherTile(page, "actual-local-ledger")).toHaveCount(0);
  await expectLauncherTile(page, "local-notes");
  await expectLauncherTile(page, "shopify");
  expect(registerCalls).toEqual([
    {
      id: "actual-local-ledger",
      title: "Actual Local Ledger",
      entrypoint: "/dynamic-views/actual-local-ledger.js",
      update: true,
    },
    {
      id: "actual-local-ledger",
      title: "Actual Local Ledger Updated",
      entrypoint: "/apps/actual-local-ledger",
      update: true,
    },
    {
      id: "actual-remote-ledger",
      title: "Actual Remote Ledger",
      entrypoint: "/dynamic-views/actual-remote-ledger.js",
      update: true,
    },
    {
      id: "actual-remote-ledger",
      title: "Actual Remote Ledger Updated",
      entrypoint: "/dynamic-views/actual-remote-ledger.js",
      update: true,
    },
  ]);
  expect(unregisterCalls).toEqual([
    "actual-remote-ledger",
    "actual-local-ledger",
  ]);
});
