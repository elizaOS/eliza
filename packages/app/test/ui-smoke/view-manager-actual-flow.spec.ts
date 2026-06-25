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

const SPRINGBOARD_LAYOUT_STORAGE_KEY = "elizaos.views.springboard";

const SCREENSHOT_DIR = path.join(
  process.cwd(),
  "aesthetic-audit-output",
  "view-manager-actual-flow",
);

async function screenshot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: false,
    attempts: 4,
  });
}

async function openSpringboard(page: Page): Promise<void> {
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
    "springboard launcher",
    [{ selector: '[data-testid="springboard"]' }],
    "all",
    90_000,
  );
}

function springboardTile(page: Page, viewId: string) {
  return page.getByTestId(`springboard-tile-${viewId}`).first();
}

async function expectSpringboardTile(
  page: Page,
  viewId: string,
): Promise<void> {
  await expect(springboardTile(page, viewId)).toBeVisible();
}

function viewLaunchButton(page: Page, viewId: string) {
  return springboardTile(page, viewId).getByRole("button").first();
}

async function navigateSplitView(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("eliza:navigate:view", {
        detail: {
          action: "split-view",
          viewId: "notes",
          views: ["notes", "simple-calendar"],
          layout: "horizontal",
          placement: "right",
        },
      }),
    );
  });
}

test.beforeEach(({ page }) => {
  installPageDiagnosticsGuard(page);
});

test.afterEach(async ({ page }, testInfo) => {
  await expectNoPageDiagnostics(page, testInfo.title);
});

test("actual app springboard switches plugin, remote, and split views", async ({
  page,
}) => {
  await rm(SCREENSHOT_DIR, { force: true, recursive: true });
  await seedAppStorage(page, {
    "eliza:developerMode": "1",
    [SPRINGBOARD_LAYOUT_STORAGE_KEY]: JSON.stringify({
      favorites: [
        "local-notes",
        "notes",
        "simple-calendar",
        "actual-remote-ledger",
      ],
      pages: [],
    }),
  });
  await installDefaultAppRoutes(page);

  const views: ViewEntry[] = [
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
    {
      id: "actual-remote-ledger",
      label: "Actual Remote Ledger",
      viewType: "gui",
      viewKind: "release",
      description: "Actual remote managed view",
      path: "/apps/actual-remote-ledger",
      available: true,
      pluginName: "actual-remote-plugin",
      tags: ["remote", "actual-app"],
      desktopTabEnabled: true,
      visibleInManager: true,
      bundleUrl: "/dynamic-views/actual-remote-ledger.js",
      componentExport: "default",
    },
  ];
  let remoteBundleRequests = 0;
  const simpleViewsState = {
    notes: [
      {
        id: "note-ui-smoke",
        title: "UI smoke note",
        body: "Rendered from the optional simple views plugin.",
        color: "yellow",
        createdAt: "2026-06-25T00:00:00.000Z",
        updatedAt: "2026-06-25T00:00:00.000Z",
      },
    ],
    events: [
      {
        id: "event-ui-smoke",
        title: "UI smoke calendar event",
        date: "2026-06-25",
        time: "09:00",
        notes: "Rendered from the optional simple views plugin.",
        color: "green",
        createdAt: "2026-06-25T00:00:00.000Z",
      },
    ],
    selectedDate: "2026-06-25",
  };

  await page.route("**/api/simple-views/state", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(simpleViewsState),
    });
  });

  await page.route("**/api/simple-views/interact", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        text: "OK",
        state: simpleViewsState,
      }),
    });
  });

  await page.route("**/api/views**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/views/search") {
      const query = (url.searchParams.get("q") ?? "").toLowerCase();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          results: views.filter((view) =>
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
      body: JSON.stringify({ views }),
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

  await openSpringboard(page);
  await expectSpringboardTile(page, "local-notes");
  await expectSpringboardTile(page, "notes");
  await expectSpringboardTile(page, "simple-calendar");
  await expectSpringboardTile(page, "actual-remote-ledger");
  await screenshot(page, "01-springboard");

  await viewLaunchButton(page, "notes").click();
  await expect(page).toHaveURL(/\/notes$/);
  await expect(page.getByTestId("simple-notes-view")).toBeVisible();
  await screenshot(page, "02-notes-open");
  await openSpringboard(page);

  await viewLaunchButton(page, "simple-calendar").click();
  await expect(page).toHaveURL(/\/simple-calendar$/);
  await expect(page.getByTestId("simple-calendar-view")).toBeVisible();
  await screenshot(page, "03-simple-calendar-open");
  await openSpringboard(page);

  await viewLaunchButton(page, "actual-remote-ledger").click();
  await expect(page).toHaveURL(/\/apps\/actual-remote-ledger$/);
  await expect(
    page.getByText("Actual remote ledger module loaded"),
  ).toBeVisible();
  expect(remoteBundleRequests).toBeGreaterThan(0);
  await screenshot(page, "04-remote-module-loaded");

  await navigateSplitView(page);
  await expect(page.getByTestId("view-layout-surface")).toBeVisible();
  await expect(page.getByTestId("view-layout-pane-notes")).toBeVisible();
  await expect(
    page.getByTestId("view-layout-pane-simple-calendar"),
  ).toBeVisible();
  await expect(page.getByTestId("simple-notes-view")).toBeVisible();
  await expect(page.getByTestId("simple-calendar-view")).toBeVisible();
  await screenshot(page, "05-notes-calendar-split-view");

  await page.getByTestId("view-layout-close").click();
  await expect(page.getByTestId("view-layout-surface")).toHaveCount(0);
  await openSpringboard(page);
  await expectSpringboardTile(page, "local-notes");
  await expectSpringboardTile(page, "notes");
  await expectSpringboardTile(page, "simple-calendar");
  await expectSpringboardTile(page, "actual-remote-ledger");
});
