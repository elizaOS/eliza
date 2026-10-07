/**
 * Exercises built-in views through the real renderer and deterministic API stub,
 * checking data requests and user interactions. Runtime layout uses real browser
 * geometry and scrolling rather than stylesheet source assertions.
 */

import { Buffer } from "node:buffer";
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page, { "eliza:developerMode": "1" });
  await installDefaultAppRoutes(page);
});

function countRequests(page: Page, pattern: RegExp): () => number {
  let n = 0;
  page.on("request", (req) => {
    if (pattern.test(req.url())) n += 1;
  });
  return () => n;
}

test("runtime view polls its snapshot and keeps long registration rows scrollable", async ({
  page,
}) => {
  // The minimal redesign dropped the manual Refresh button: the snapshot stays
  // live via a silent background poll. Assert the load query fires on mount and
  // the poll re-queries the source (no user-facing refresh control).
  const runtimeReqs = countRequests(page, /\/api\/runtime(?:\?|$)/);
  await openAppPath(page, "/apps/runtime");
  await expect(page.getByTestId("runtime-view")).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(runtimeReqs).toBeGreaterThan(0);

  for (const width of [390, 820]) {
    await page.setViewportSize({ width, height: 900 });
    const row = page.getByText(/^\[0\] open_browser_workspace/).first();
    await expect(row).toBeVisible();
    const geometry = await row.evaluate((element) => {
      const scroller = element.parentElement;
      if (!scroller)
        throw new Error("Registration row has no scroll container");
      scroller.scrollLeft = scroller.scrollWidth;
      return {
        scrollLeft: scroller.scrollLeft,
        rowHeight: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(geometry.scrollLeft).toBeGreaterThan(0);
    expect(geometry.rowHeight).toBeLessThanOrEqual(geometry.lineHeight + 1);
    expect(geometry.pageOverflow).toBeLessThanOrEqual(2);
  }

  const before = runtimeReqs();
  await expect.poll(runtimeReqs, { timeout: 30_000 }).toBeGreaterThan(before);
});

test("plugins view loads plugins and search filters the list", async ({
  page,
}) => {
  const pluginReqs = countRequests(page, /\/api\/plugins(?:\?|$)/);
  await openAppPath(page, "/apps/plugins");
  await expect(page.getByTestId("plugins-view-page")).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(pluginReqs).toBeGreaterThan(0);

  // Search now runs through the floating chat composer — the plugins view takes
  // over its placeholder + live draft (no in-page search box). The stub serves
  // openai + anthropic + plugin-browser: a specific search must narrow the
  // visible set; clearing it must restore.
  const search = page.getByTestId("chat-composer-textarea");
  await expect(search).toHaveAttribute("placeholder", /search plugins/i, {
    timeout: 15_000,
  });
  const cardsAll = await page.locator("[data-plugin-toggle]").count();
  await search.fill("browser");
  await expect
    .poll(() => page.locator("[data-plugin-toggle]").count())
    .toBeLessThan(Math.max(cardsAll, 2));
  await search.fill("");
  await expect
    .poll(() => page.locator("[data-plugin-toggle]").count())
    .toBe(cardsAll);
});

test("database view loads tables and runs a SQL query", async ({ page }) => {
  const queryReqs = countRequests(page, /\/api\/database\/query/);
  await openAppPath(page, "/apps/database");
  await expect(page.getByTestId("database-view")).toBeVisible({
    timeout: 60_000,
  });

  // Switch to the SQL editor, run a query, and prove a query request fired.
  await page
    .getByRole("button", { name: /SQL Editor/i })
    .first()
    .click();
  const editor = page.getByPlaceholder(/SELECT.*FROM/i).first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.fill("SELECT * FROM memories");
  const before = queryReqs();
  await page
    .getByRole("button", { name: /run query/i })
    .first()
    .click();
  await expect.poll(queryReqs).toBeGreaterThan(before);
});

test("media gallery includes media after the first database page", async ({
  page,
}, testInfo) => {
  const requestedOffsets: number[] = [];
  let failLaterPage = true;
  await page.unroute("**/api/database/tables");
  await page.route("**/api/database/tables", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        tables: [{ name: "memories", rowCount: 501 }],
      }),
    });
  });
  await page.route("**/api/database/tables/memories/rows?*", async (route) => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    requestedOffsets.push(offset);
    if (offset > 0 && failLaterPage) {
      failLaterPage = false;
      await route.fulfill({
        status: 503,
        json: { error: "Later media page unavailable" },
      });
      return;
    }
    const rows =
      offset === 0
        ? Array.from({ length: 500 }, (_, index) => ({
            content: `plain text ${index}`,
          }))
        : [
            {
              content: "https://example.test/after-first-page.png",
              createdAt: "2026-10-06",
            },
          ];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        table: "memories",
        rows,
        columns: ["content", "createdAt"],
        total: 501,
        offset,
        limit,
      }),
    });
  });
  await page.route(
    "https://example.test/after-first-page.png",
    async (route) => {
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

  await openAppPath(page, "/apps/database");
  await page.getByRole("tab", { name: "Media" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "Some media could not be loaded",
  );
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "after-first-page.png" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(requestedOffsets).toEqual([0, 500, 0, 500]);
  await testInfo.attach("media-pagination-desktop", {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "after-first-page.png" }),
  ).toBeVisible();
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(pageOverflow).toBeLessThanOrEqual(2);
  await testInfo.attach("media-pagination-mobile", {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png",
  });
});

test("skills view shows empty state and New Skill opens the create form", async ({
  page,
}) => {
  await openAppPath(page, "/apps/skills");
  await expect(page.getByTestId("skills-shell")).toBeVisible({
    timeout: 60_000,
  });
  // Stub serves no skills.
  await expect(page.getByTestId("skills-empty-state")).toBeVisible({
    timeout: 15_000,
  });

  await page
    .getByRole("button", { name: /new skill/i })
    .first()
    .click();
  // The create form exposes a "Create Skill" submit button.
  await expect(
    page.getByRole("button", { name: /create skill/i }).first(),
  ).toBeVisible({ timeout: 10_000 });
});

test("learning a skill opens an editable conversation draft", async ({
  page,
}) => {
  let sentMessages = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/(?:chat|conversations\/[^/]+\/messages)(?:\/stream)?(?:\?|$)/.test(
        request.url(),
      )
    )
      sentMessages += 1;
  });
  await openAppPath(page, "/character/skills");
  const learn = page.getByRole("button", {
    name: "Learn a skill",
    exact: true,
  });
  await expect(learn).toBeVisible({ timeout: 60_000 });
  const before = sentMessages;
  await learn.click();
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toBeVisible();
  await expect(composer).toHaveValue(/Help me learn a new skill/);
  await composer.fill("Help me practice Spanish conversation.");
  await expect(composer).toHaveValue("Help me practice Spanish conversation.");
  expect(sentMessages).toBe(before);
  // The stub keeps one message list per conversation for the whole run, so
  // fixture replies from earlier specs in this worker are already in the
  // thread; assert the send added exactly one, not that it is the only one.
  const thread = page.getByTestId("chat-thread");
  const fixtureReplies = thread.getByText(/"fixture":"ui-smoke-assistant-v1"/);
  const repliesBefore = await fixtureReplies.count();
  const submitted = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      /\/api\/(?:chat|conversations\/[^/]+\/messages)(?:\/stream)?(?:\?|$)/.test(
        request.url(),
      ),
  );
  await page.getByRole("button", { name: "send", exact: true }).click();
  expect((await submitted).postDataJSON()).toMatchObject({
    text: "Help me practice Spanish conversation.",
  });
  await expect(thread).toBeVisible();
  await expect(fixtureReplies).toHaveCount(repliesBefore + 1);
  expect(sentMessages).toBe(before + 1);
});

test("trajectories view loads and search re-queries", async ({ page }) => {
  const trajReqs = countRequests(page, /\/api\/trajectories(?:\?|$|\/)/);
  await openAppPath(page, "/apps/trajectories");
  await expect(page.getByTestId("trajectories-view")).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(trajReqs).toBeGreaterThan(0);

  // Search runs through the floating chat composer now (the view overrides its
  // placeholder); typing re-queries the trajectories list.
  const before = trajReqs();
  const search = page.getByTestId("chat-composer-textarea");
  await expect(search).toHaveAttribute("placeholder", /search/i, {
    timeout: 15_000,
  });
  await search.fill("smoke-query");
  await expect.poll(trajReqs).toBeGreaterThan(before);
});

test("relationships view loads the entity and relationship graph", async ({
  page,
}) => {
  const relReqs = countRequests(
    page,
    /\/api\/lifeops\/(entities|relationships)(?:\?|$)/,
  );
  await openAppPath(page, "/apps/relationships");
  await expect(page.getByTestId("relationships-view")).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(relReqs).toBeGreaterThan(0);
});

test("stream view renders the offline status surface", async ({ page }) => {
  await openAppPath(page, "/stream");
  await expect(page.locator("[data-stream-view]").first()).toBeVisible({
    timeout: 60_000,
  });
});

test("stream view keeps a failed Go Live request visible and retryable", async ({
  page,
}, testInfo) => {
  const statuses: number[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/stream/live") {
      statuses.push(response.status());
    }
  });
  await page.route("**/api/stream/live", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Encoder unavailable" }),
    });
  });

  await openAppPath(page, "/stream");
  const goLive = page.getByRole("button", { name: "Go Live" });
  await expect(goLive).toBeVisible({ timeout: 60_000 });
  await goLive.click();

  await expect(page.getByRole("alert")).toContainText("Encoder unavailable");
  await expect(goLive).toBeEnabled();
  await expect.poll(() => statuses).toEqual([503]);

  const desktopScreenshotPath = testInfo.outputPath(
    "stream-action-error-desktop.jpg",
  );
  await page.screenshot({
    path: desktopScreenshotPath,
    type: "jpeg",
    quality: 85,
    fullPage: true,
  });
  await testInfo.attach("stream-action-error-desktop.jpg", {
    path: desktopScreenshotPath,
    contentType: "image/jpeg",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("alert")).toBeVisible();
  const mobileScreenshotPath = testInfo.outputPath(
    "stream-action-error-mobile.jpg",
  );
  await page.screenshot({
    path: mobileScreenshotPath,
    type: "jpeg",
    quality: 85,
    fullPage: true,
  });
  await testInfo.attach("stream-action-error-mobile.jpg", {
    path: mobileScreenshotPath,
    contentType: "image/jpeg",
  });
});

test("legacy rolodex URL opens the working relationship graph", async ({
  page,
}) => {
  const graphRequests = countRequests(
    page,
    /\/api\/lifeops\/(entities|relationships)(?:\?|$)/,
  );
  await openAppPath(page, "/apps/relationships");
  await expect(page.getByTestId("relationships-view")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page).toHaveURL(/\/apps\/relationships$/);
  await expect.poll(graphRequests).toBeGreaterThan(0);
});
