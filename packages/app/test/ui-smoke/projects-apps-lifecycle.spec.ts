/**
 * Real-renderer lifecycle proof for the consolidated Projects → Apps segment
 * (#17031). The standalone My Apps view is retired, so the create / load-from-
 * directory / installed-inventory controls it used to own must still be
 * reachable and functional from the Projects surface, on both the retired deep
 * links (`/apps`, `/apps/my-apps`) and the canonical `/apps/tasks` route.
 *
 * This lane boots the packaged renderer in Chromium and drives the real
 * `AppsManagementSection` mounted inside `TasksPageView`: it asserts the
 * installed inventory renders with its run badges, that "Create new app" and
 * "Load from directory" submit the exact agent-API payloads, and that the
 * segment survives a round trip through the Tasks segment. The agent app
 * endpoints (`/api/apps/installed`, `/api/apps/runs`, `/api/apps/create`,
 * `/api/apps/load-from-directory`) are route-mocked because this spec proves
 * the consolidated UI wiring; the endpoints' own contracts are covered by the
 * agent package suites.
 *
 * The canonical hub's empty and populated collection states are captured at
 * mobile portrait, short landscape, tablet portrait, and desktop landscape.
 *
 * Run:
 *   bun run --cwd packages/app test:e2e test/ui-smoke/projects-apps-lifecycle.spec.ts
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, type Route, test } from "@playwright/test";
import { DASHBOARD_E2E_DEVICE_MATRIX } from "./device-matrix";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const EVIDENCE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../test-results/ui-smoke-artifacts/17031-projects-apps",
);

const INSTALLED_APP = {
  name: "starfield-notes",
  displayName: "Starfield Notes",
  version: "1.4.0",
  installPath: "/Users/proof/apps/starfield-notes",
  installedAt: "2026-08-01T00:00:00.000Z",
  isRunning: true,
};

const APP_RUN = {
  runId: "run-17031-1",
  appName: INSTALLED_APP.name,
  appId: INSTALLED_APP.name,
  status: "running",
  startedAt: "2026-08-01T00:05:00.000Z",
};

const AVAILABLE_APP = {
  name: "aurora-tracker",
  displayName: "Aurora Tracker",
  description: "Track aurora sightings and receive alerts at dusk.",
  category: "productivity",
  launchType: "page",
  launchUrl: null,
  icon: null,
  heroImage: null,
  capabilities: [],
  stars: 12,
  repository: "https://github.com/elizaOS/aurora-tracker",
  latestVersion: "2.0.0",
  supports: { v0: false, v1: true, v2: true },
  npm: {
    package: "@elizaos/plugin-aurora-tracker",
    v0Version: null,
    v1Version: "2.0.0",
    v2Version: "2.0.0",
  },
};

type CapturedPosts = {
  create: unknown[];
  load: unknown[];
  launch: unknown[];
};

type AppsFixtureState = {
  installed: Array<typeof INSTALLED_APP>;
  catalog: Array<typeof AVAILABLE_APP>;
};

async function fulfillJson(
  route: Route,
  status: number,
  body: unknown,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * Route-mock the agent app-management endpoints the section calls. Registered
 * after `installDefaultAppRoutes` so Playwright's last-registered-first
 * matching gives these handlers precedence.
 */
async function installAppsApiMocks(
  page: Page,
  posts: CapturedPosts,
  state: AppsFixtureState = {
    installed: [INSTALLED_APP],
    catalog: [AVAILABLE_APP],
  },
): Promise<void> {
  await page.route("**/api/apps/installed", async (route) => {
    await fulfillJson(route, 200, state.installed);
  });
  await page.route("**/api/catalog/apps", async (route) => {
    await fulfillJson(route, 200, state.catalog);
  });
  await page.route("**/api/apps/runs", async (route) => {
    await fulfillJson(route, 200, [APP_RUN]);
  });
  await page.route("**/api/apps/create", async (route) => {
    posts.create.push(route.request().postDataJSON());
    await fulfillJson(route, 200, {
      ok: true,
      status: "queued",
      appId: "aurora-tracker",
      taskId: "task-17031",
    });
  });
  await page.route("**/api/apps/load-from-directory", async (route) => {
    posts.load.push(route.request().postDataJSON());
    await fulfillJson(route, 200, { ok: true, loaded: 1, count: 1 });
  });
  await page.route("**/api/apps/launch", async (route) => {
    posts.launch.push(route.request().postDataJSON());
    await fulfillJson(route, 200, {
      pluginInstalled: true,
      needsRestart: false,
      displayName: AVAILABLE_APP.displayName,
      launchType: AVAILABLE_APP.launchType,
      launchUrl: null,
      viewer: null,
      session: null,
      run: null,
    });
  });
}

async function openProjectsApps(page: Page, path: string): Promise<void> {
  await openAppPath(page, path);
  await expect(page.getByTestId("tasks-view")).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByTestId("projects-apps-segment")).toBeVisible({
    timeout: 90_000,
  });
}

test.beforeEach(async ({ page }) => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await installDefaultAppRoutes(page);
  await seedAppStorage(page);
});

test("Projects → Apps keeps the retired My Apps lifecycle controls working", async ({
  page,
}) => {
  const posts: CapturedPosts = { create: [], load: [], launch: [] };
  await installAppsApiMocks(page, posts);

  // Retired standalone slug resolves onto Projects with Apps pre-selected.
  await openProjectsApps(page, "/apps/my-apps");

  // Installed inventory survives the consolidation, including the run badge
  // reconciled from /api/apps/runs.
  const row = page.getByTestId(`apps-mgmt-row-${INSTALLED_APP.name}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(INSTALLED_APP.displayName);
  await expect(row).toContainText(INSTALLED_APP.version);
  await expect(row).toContainText("1 run");
  await page.screenshot({
    path: `${EVIDENCE_DIR}/desktop-01-apps-rest.png`,
    fullPage: true,
  });

  // Hover state on the inventory row's launch control.
  const launchButton = page.getByRole("button", {
    name: `Launch ${INSTALLED_APP.displayName}`,
    exact: true,
  });
  await launchButton.hover();
  await page.screenshot({
    path: `${EVIDENCE_DIR}/desktop-02-apps-row-hover.png`,
    fullPage: true,
  });

  // Create flow — the exact /api/apps/create payload must still be produced
  // from the consolidated surface.
  const createToggle = page.getByRole("button", { name: "Create new app" });
  await expect(createToggle).toBeVisible();
  await createToggle.focus();
  await page.screenshot({
    path: `${EVIDENCE_DIR}/desktop-03-create-focus.png`,
    fullPage: true,
  });
  await createToggle.click();
  const intent = page.getByLabel("What should the app do?");
  await expect(intent).toBeVisible({ timeout: 15_000 });
  await intent.fill("Track aurora sightings and notify me at dusk.");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(() => posts.create.length, { timeout: 20_000 }).toBe(1);
  expect(posts.create[0]).toMatchObject({
    intent: "Track aurora sightings and notify me at dusk.",
  });

  // Import flow — "Load from directory" is the create/import half #17031 calls
  // out; it must still reach /api/apps/load-from-directory.
  const loadToggle = page.getByRole("button", { name: "Load from directory" });
  await loadToggle.click();
  const directory = page.getByLabel("Directory path");
  await expect(directory).toBeVisible({ timeout: 15_000 });
  await directory.fill("/Users/proof/code/imported-app");
  await page.getByRole("button", { name: "Load", exact: true }).click();
  await expect.poll(() => posts.load.length, { timeout: 20_000 }).toBe(1);
  expect(posts.load[0]).toMatchObject({
    directory: "/Users/proof/code/imported-app",
  });
  await page.screenshot({
    path: `${EVIDENCE_DIR}/desktop-04-load-submitted.png`,
    fullPage: true,
  });

  // Segment round trip: Tasks and back to Apps, with the inventory intact.
  await page.getByTestId("projects-segment-tasks").click();
  await expect(page.getByTestId("projects-apps-segment")).toBeHidden();
  await page.getByTestId("projects-segment-apps").click();
  await expect(
    page.getByTestId(`apps-mgmt-row-${INSTALLED_APP.name}`),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({
    path: `${EVIDENCE_DIR}/desktop-05-segment-roundtrip.png`,
    fullPage: true,
  });
});

test("bare /apps and /apps/tasks resolve to the right Projects segment", async ({
  page,
}) => {
  const posts: CapturedPosts = { create: [], load: [], launch: [] };
  await installAppsApiMocks(page, posts);

  // Bare retired route → Apps segment.
  await openProjectsApps(page, "/apps");
  await expect(page.getByText("Install, create, and run")).toBeVisible();

  // Canonical route → Tasks segment (Apps body not mounted).
  await openAppPath(page, "/apps/tasks");
  await expect(page.getByTestId("tasks-view")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("projects-apps-segment")).toBeHidden();
  await expect(page.getByTestId("projects-segment-apps")).toBeVisible();
});

test("mobile Projects → Apps keeps every lifecycle control reachable", async ({
  page,
}) => {
  const posts: CapturedPosts = { create: [], load: [], launch: [] };
  await installAppsApiMocks(page, posts);
  await page.setViewportSize({ width: 390, height: 844 });

  await openProjectsApps(page, "/apps/my-apps");
  const createToggle = page.getByRole("button", { name: "Create new app" });
  await expect(createToggle).toBeVisible({ timeout: 30_000 });
  await page.screenshot({
    path: `${EVIDENCE_DIR}/mobile-01-apps-rest.png`,
    fullPage: true,
  });

  // The ambient chat sheet must not swallow the management controls on phone
  // widths — the regression #17031's consolidation introduced and 896da53
  // fixed. Clicking through (not force) is the proof it is hit-testable.
  await createToggle.click();
  await expect(page.getByLabel("What should the app do?")).toBeVisible({
    timeout: 15_000,
  });
  await page.screenshot({
    path: `${EVIDENCE_DIR}/mobile-02-create-open.png`,
    fullPage: true,
  });

  // Installed row stays reachable by scrolling within the segment body.
  const row = page.getByTestId(`apps-mgmt-row-${INSTALLED_APP.name}`);
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();
  await page.screenshot({
    path: `${EVIDENCE_DIR}/mobile-03-inventory.png`,
    fullPage: true,
  });
});

test("Apps hub proves empty and populated collections across canonical viewports", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const posts: CapturedPosts = { create: [], load: [], launch: [] };
  const state: AppsFixtureState = { installed: [], catalog: [] };
  await installAppsApiMocks(page, posts, state);

  for (const device of DASHBOARD_E2E_DEVICE_MATRIX) {
    await page.setViewportSize(device.viewport);
    state.installed = [];
    state.catalog = [];
    await openProjectsApps(page, "/apps");
    await expect(
      page.getByText("No apps installed", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("No additional apps available", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Filter apps")).toHaveAttribute(
      "data-agent-id",
      "apps-filter",
    );
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(device.viewport.width);
    await page.screenshot({
      path: `${EVIDENCE_DIR}/${device.id}-empty.png`,
      fullPage: true,
    });

    state.installed = [INSTALLED_APP];
    state.catalog = [AVAILABLE_APP];
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByTestId(`apps-mgmt-row-${INSTALLED_APP.name}`),
    ).toBeVisible({ timeout: 30_000 });
    const availableRow = page.getByTestId(
      `apps-available-row-${AVAILABLE_APP.name}`,
    );
    await expect(availableRow).toBeVisible();
    await page.screenshot({
      path: `${EVIDENCE_DIR}/${device.id}-populated.png`,
      fullPage: true,
    });

    const filter = page.getByLabel("Filter apps");
    await filter.fill("aurora");
    await expect(
      page.getByTestId(`apps-mgmt-row-${INSTALLED_APP.name}`),
    ).toBeHidden();
    await expect(availableRow).toBeVisible();
    await filter.fill("");

    const launchesBefore = posts.launch.length;
    const getButton = page.getByRole("button", {
      name: `Get ${AVAILABLE_APP.displayName}`,
    });
    await expect(getButton).toHaveAttribute(
      "data-agent-id",
      `apps-get-${AVAILABLE_APP.name}`,
    );
    await getButton.click();
    await expect
      .poll(() => posts.launch.length, { timeout: 20_000 })
      .toBe(launchesBefore + 1);
    expect(posts.launch.at(-1)).toEqual({ name: AVAILABLE_APP.name });
  }
});
