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
  description?: string;
  path: string;
  available: boolean;
  pluginName: string;
  builtin?: boolean;
  tags: string[];
  desktopTabEnabled: boolean;
  bundleUrl?: string;
  componentExport?: string;
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
    description: manifest.description,
    path: `/apps/${manifest.id}`,
    available: true,
    pluginName: isRemote ? "actual-remote-plugin" : "actual-local-plugin",
    tags: isRemote ? ["remote", "actual-app"] : ["local", "actual-app"],
    desktopTabEnabled: true,
    bundleUrl: isRemote ? entrypoint : undefined,
    componentExport: "default",
  };
}

async function screenshot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: false,
    attempts: 4,
  });
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
        description: "Built-in local notes view",
        path: "/apps/local-notes",
        available: true,
        pluginName: "core",
        builtin: true,
        tags: ["local"],
        desktopTabEnabled: true,
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
  await expect(page.getByTestId("view-card-local-notes")).toBeVisible();

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
  await expect(page.getByTestId("view-card-actual-local-ledger")).toBeVisible();
  await screenshot(page, "01-local-created");

  await page
    .getByTestId("view-card-actual-local-ledger")
    .getByRole("button", { name: /^Actual Local Ledger Actual/ })
    .click();
  await expect(page).toHaveURL(/\/apps\/actual-local-ledger$/);
  await openViewManager(page);

  await page.getByRole("button", { name: "Edit Actual Local Ledger" }).click();
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
  await expect(
    page
      .getByRole("button", {
        name: /^Actual Local Ledger Updated Actual local managed view/,
      })
      .first(),
  ).toBeVisible();
  await expect(page.getByText(/^Actual Local Ledger$/)).toHaveCount(0);

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
  await expect(
    page.getByTestId("view-card-actual-remote-ledger"),
  ).toBeVisible();
  await screenshot(page, "02-remote-created");

  await page
    .getByTestId("view-card-actual-local-ledger")
    .first()
    .getByRole("button", { name: /^Actual Local Ledger Updated Actual/ })
    .click();
  await expect(page).toHaveURL(/\/apps\/actual-local-ledger$/);
  expect(
    remoteBundleRequests,
    "opening the local dynamic view must not import the remote bundle",
  ).toBe(0);
  await screenshot(page, "03-local-switched");

  await openViewManager(page);

  await page
    .getByTestId("view-card-actual-remote-ledger")
    .getByRole("button", { name: /^Actual Remote Ledger Actual/ })
    .click();
  await expect(page).toHaveURL(/\/apps\/actual-remote-ledger$/);
  await expect(
    page.getByText("Actual remote ledger module loaded"),
  ).toBeVisible();
  expect(remoteBundleRequests).toBeGreaterThan(0);
  await screenshot(page, "04-remote-module-loaded");

  await openViewManager(page);
  await page.getByRole("button", { name: "Edit Actual Remote Ledger" }).click();
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
  await expect(
    page
      .getByRole("button", {
        name: /^Actual Remote Ledger Updated Actual remote managed view/,
      })
      .first(),
  ).toBeVisible();
  await expect(page.getByText(/^Actual Remote Ledger$/)).toHaveCount(0);

  const remoteRequestsAfterFirstOpen = remoteBundleRequests;
  await page
    .getByTestId("view-card-actual-remote-ledger")
    .getByRole("button", { name: /^Actual Remote Ledger Updated Actual/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/apps\/actual-remote-ledger$/);
  await expect(
    page.getByText("Actual remote ledger module loaded"),
  ).toBeVisible();
  expect(remoteBundleRequests).toBeGreaterThanOrEqual(
    remoteRequestsAfterFirstOpen,
  );
  await screenshot(page, "05-remote-updated-reopened");

  await openViewManager(page);

  await page
    .getByRole("button", { name: "Delete Actual Remote Ledger Updated" })
    .click();
  expect(unregisterCalls.at(-1)).toBe("actual-remote-ledger");
  await expect(page.getByRole("status")).toContainText(
    "Deleted Actual Remote Ledger Updated.",
  );
  await expect(page.getByTestId("view-card-actual-remote-ledger")).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "Delete Actual Local Ledger Updated" })
    .click();
  expect(unregisterCalls.at(-1)).toBe("actual-local-ledger");
  await expect(page.getByRole("status")).toContainText(
    "Deleted Actual Local Ledger Updated.",
  );
  await expect(page.getByTestId("view-card-actual-local-ledger")).toHaveCount(
    0,
  );
  await expect(page.getByTestId("view-card-local-notes")).toBeVisible();
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
