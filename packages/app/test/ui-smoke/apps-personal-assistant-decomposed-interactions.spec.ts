// Interaction coverage for the decomposed personal-assistant domain views
// (calendar, finances, focus, goals, health, inbox, todos, relationships).
// These are dynamic plugin views; the ui-smoke stub registers their bundles so
// they render (not the launcher fallback). Each `<Domain>View` is a spatial
// wrapper that renders the same DOM on the desktop `chromium` and Pixel-7
// `mobile-chromium` lanes, so every assertion below is a viewport-independent
// semantic outcome: populated content from the mocked lifeops endpoints plus a
// real state-changing interaction (channel/kind/status filters, calendar day
// selection and month navigation). This is the interaction owner that closes

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

async function expectTopmostAtCenter(
  locator: Locator,
  owner: string,
): Promise<void> {
  await expect(locator).toBeVisible({ timeout: 15_000 });
  const isTopmost = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const topmost = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return element === topmost || element.contains(topmost);
  });

  // #11144 regressed when the (now-removed) global corner back button visually
  // cleared the content but kept intercepting first-chip pointer input. This
  // guard still asserts the target chip is the DOM hit-test winner at its own
  // center before clicking it, so any future overlay that occludes it fails.
  expect(
    isTopmost,
    `${owner} should be topmost at its center, not occluded by an overlay (#11144)`,
  ).toBe(true);
}

async function openPopulatedCalendar(page: Page): Promise<void> {
  await openAppPath(page, "/calendar");
  await expect(page.getByTestId("lifeops-calendar-section")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Design sync").first()).toBeVisible({
    timeout: 15_000,
  });
}

test("calendar decomposed view: responsive modes and event creation", async ({
  page,
}) => {
  await openPopulatedCalendar(page);

  const monthMode = page.getByRole("button", { name: "Month", exact: true });
  await expectTopmostAtCenter(monthMode, "Calendar Month mode");
  await monthMode.click();
  await expect(monthMode).toHaveAttribute("aria-pressed", "true");

  const newEvent = page.getByTestId("lifeops-calendar-new-event");
  await expectTopmostAtCenter(newEvent, "Calendar New event");
  await newEvent.click();
  await expect(page.getByTestId("event-editor-drawer")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByRole("button", { name: "Create event" }),
  ).toBeVisible();
});

test("calendar mobile layout keeps navigation and editor inside 390px viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPopulatedCalendar(page);

  const dayMode = page.getByRole("button", { name: "Day", exact: true });
  await expectTopmostAtCenter(dayMode, "Calendar Day mode");
  await dayMode.click();
  await expect(dayMode).toHaveAttribute("aria-pressed", "true");

  const newEvent = page.getByTestId("lifeops-calendar-new-event");
  await expectTopmostAtCenter(newEvent, "Calendar New event");
  await expect(newEvent).toBeInViewport();
  await expect(page.getByRole("button", { name: "Previous" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Today" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Next" })).toBeInViewport();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
    "Calendar mobile shell must not introduce page-level horizontal overflow",
  ).toBe(390);

  await newEvent.click();
  const editor = page.getByTestId("event-editor-drawer");
  await expect(editor).toBeVisible({ timeout: 15_000 });
  const editorBounds = await editor.boundingBox();
  expect(editorBounds).not.toBeNull();
  expect(editorBounds?.x).toBeGreaterThanOrEqual(0);
  expect(
    (editorBounds?.x ?? 0) + (editorBounds?.width ?? 0),
  ).toBeLessThanOrEqual(390);
  await expect(page.getByLabel("Event title")).toBeInViewport();
  await expect(page.getByLabel("Start time")).toBeInViewport();
  await expect(page.getByLabel("End time")).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Create event" }),
  ).toBeVisible();
});

test("inbox decomposed view: channel filters toggle", async ({ page }) => {
  // /inbox renders the populated triage list from the inbox mock: an Email
  // (gmail) thread and a Discord thread.
  await openAppPath(page, "/inbox");
  await expect(page.getByText("Invoice #42 overdue").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByText("gm everyone — standup in 10").first(),
  ).toBeVisible({ timeout: 15_000 });

  // Activating a channel chip narrows the server query (?channels=<channel>)
  // and the rendered list: the active chip is renamed "* <Channel>", its
  // thread stays, and the other channel's thread disappears.
  const emailChip = page
    .getByRole("button", { name: "Email", exact: true })
    .first();
  await expectTopmostAtCenter(emailChip, "Inbox Email filter chip");
  await emailChip.click();
  await expect(
    page.getByRole("button", { name: "* Email", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Invoice #42 overdue").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("gm everyone — standup in 10")).toHaveCount(0, {
    timeout: 15_000,
  });
});

test("finances decomposed view: renders the financial summary", async ({
  page,
}) => {
  // The money mocks seed a source + dashboard + transactions + recurring, so
  // FinancesView lands on its populated branch: the net balance, the "Latte"
  // transaction, and the Netflix recurring charge.
  await openAppPath(page, "/finances");
  await expect(page.getByText("$2,765.50").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Transactions (1)").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Latte").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Recurring (1)").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Netflix").first()).toBeVisible({
    timeout: 15_000,
  });
});

test("focus decomposed view: renders the focus scaffold", async ({ page }) => {
  // The website-blocker mock reports enabled:false, so FocusView resolves to
  // its idle branch (not loading, not error, not "Focus unavailable").
  await openAppPath(page, "/focus");
  await expect(page.getByText("Idle", { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  });
});

test("goals decomposed view: renders the goals scaffold", async ({ page }) => {
  // The goals mock seeds one active goal + one paused goal (flagged
  // needs_attention → the "1 goal needs a review." proactive line).
  await openAppPath(page, "/goals");
  await expect(page.getByText("Run a half marathon").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByText("Learn conversational Spanish").first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("1 goal needs a review.").first()).toBeVisible({
    timeout: 15_000,
  });

  // Toggling the "Active" status chip narrows the groups: the paused goal
  // disappears, the active goal stays.
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await expect(page.getByText("Learn conversational Spanish")).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.getByText("Run a half marathon").first()).toBeVisible({
    timeout: 15_000,
  });
});

test("health decomposed view: renders the health regions", async ({ page }) => {
  // The sleep mocks populate the three health regions: last night, regularity,
  // and the personal baseline. 465 min → the "7h 45m" duration readout.
  await openAppPath(page, "/health");
  await expect(
    page.getByRole("heading", { name: "Last sleep" }).first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByRole("heading", { name: "Regularity" }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("heading", { name: "Baseline" }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("7h 45m").first()).toBeVisible({
    timeout: 15_000,
  });
});

test("todos decomposed view: renders the todo lanes", async ({ page }) => {
  // The todos mock seeds one item per lane, so all three lanes render with
  // their counts and titles.
  await openAppPath(page, "/todos");
  await expect(page.getByText("Today (1)").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Upcoming (1)").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Someday (1)").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByText("Submit the quarterly report").first(),
  ).toBeVisible({ timeout: 15_000 });
});

test("relationships decomposed view: renders the graph and toggles a kind filter", async ({
  page,
}) => {
  // /relationships mounts the unified RelationshipsView. The helper mocks
  // GET /api/lifeops/entities + /api/lifeops/relationships with a populated
  // graph (Owner, Pat Doe, Acme Corp), so the view lands on its populated
  // branch. Toggling the "Organizations" kind filter narrows the node list to
  // the organization node only; "All" restores it.
  await openAppPath(page, "/relationships");
  await expect(page.getByText("3 entities").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Pat Doe").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Acme Corp").first()).toBeVisible({
    timeout: 15_000,
  });

  // Layout sanity (#11145 lineage): this decomposed route renders the unified
  // list-based RelationshipsSpatialView (RelationshipsView.tsx), whose
  // container is `[data-spatial-surface]`. Assert the rendered surface never
  // exceeds the viewport width (no horizontal page-scroll blowout).
  const viewport = page.viewportSize();
  if (viewport) {
    const box = await page
      .locator("[data-spatial-surface]")
      .first()
      .boundingBox();
    expect(box, "spatial surface should be laid out").not.toBeNull();
    if (box) {
      // +1px slack for sub-pixel rounding.
      expect(box.width).toBeLessThanOrEqual(viewport.width + 1);
    }
  }

  const kindFilter = page.getByRole("button", {
    name: /^Filter relationship type/,
  });
  await kindFilter.click();
  await page
    .getByRole("menuitemradio", { name: "Organizations", exact: true })
    .click();
  await expect(page.getByText("1 entity").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Pat Doe")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("Acme Corp").first()).toBeVisible({
    timeout: 15_000,
  });

  // #11144 guard: the filter trigger must remain reachable above the graph.
  // Drive the real restore path through the dropdown and assert every kind is
  // visible again.
  await expectTopmostAtCenter(kindFilter, "Relationships kind filter");
  await kindFilter.click();
  await page.getByRole("menuitemradio", { name: "All", exact: true }).click();
  await expect(page.getByText("3 entities").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Pat Doe").first()).toBeVisible({
    timeout: 15_000,
  });
});
