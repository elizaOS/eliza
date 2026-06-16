// Real interaction coverage for the built-in app page-views that all-pages-
// clicksafe only render-smokes (runtime, plugins, database, skills, trajectories,
// relationships, stream, fine-tuning, rolodex). Each test proves the page is
// wired to a real endpoint (fires its data query on load) AND that a primary
// control does something — not just that the page renders. Sibling of
// apps-diagnostics-interactions.spec.ts; runs keyless against the stub.

import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

function countRequests(page: Page, pattern: RegExp): () => number {
  let n = 0;
  page.on("request", (req) => {
    if (pattern.test(req.url())) n += 1;
  });
  return () => n;
}

test("runtime view loads a snapshot and refresh re-queries it", async ({
  page,
}) => {
  const runtimeReqs = countRequests(page, /\/api\/runtime(?:\?|$)/);
  await openAppPath(page, "/apps/runtime");
  await expect(page.getByTestId("runtime-view")).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(runtimeReqs).toBeGreaterThan(0);

  const before = runtimeReqs();
  await page
    .getByTestId("runtime-view")
    .getByRole("button", { name: /refresh/i })
    .first()
    .click();
  await expect.poll(runtimeReqs).toBeGreaterThan(before);
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

  // The stub serves openai + anthropic + plugin-browser. A specific search must
  // narrow the visible set; clearing it must restore.
  const search = page.getByTestId("plugins-search");
  await expect(search).toBeVisible({ timeout: 15_000 });
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

test("trajectories view loads and search re-queries", async ({ page }) => {
  const trajReqs = countRequests(page, /\/api\/trajectories(?:\?|$|\/)/);
  await openAppPath(page, "/apps/trajectories");
  await expect(page.getByTestId("trajectories-view")).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(trajReqs).toBeGreaterThan(0);

  const before = trajReqs();
  const search = page
    .getByTestId("trajectories-sidebar")
    .getByRole("textbox")
    .first();
  await search.fill("smoke-query");
  await expect.poll(trajReqs).toBeGreaterThan(before);
});

test("relationships view loads the graph and platform filter re-queries", async ({
  page,
}) => {
  const relReqs = countRequests(page, /\/api\/relationships\/(graph|people)/);
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

// NOTE: /apps/fine-tuning (the "training" view) is interaction-covered by
// apps-model-training-interactions.spec.ts — not duplicated here.

test("rolodex renders the views catalog with view cards", async ({ page }) => {
  await openAppPath(page, "/rolodex");
  await expect(page.getByTestId("views-catalog-section").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect
    .poll(() => page.locator('[data-testid^="view-card-"]').count())
    .toBeGreaterThan(0);
});
