// Interaction coverage for the decomposed personal-assistant domain views
// (calendar, finances, focus, goals, health, inbox, todos, relationships).
// These are dynamic plugin views; the ui-smoke stub registers their bundles so
// they render (not the launcher fallback). Each `<Domain>View` is a spatial
// wrapper that renders the same DOM on the desktop `chromium` and Pixel-7
// `mobile-chromium` lanes, so every assertion below is a viewport-independent
// semantic outcome: populated content from the mocked lifeops endpoints plus a
// real state-changing interaction (channel/kind/status filters, calendar day
// selection and month navigation). This is the interaction owner that closes

import type { Locator } from "@playwright/test";
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

test("calendar decomposed view: day selection and month navigation", async ({
  page,
}) => {
  // /calendar mounts the canonical SimpleCalendarView (#17859 swapped the view
  // bundle from the canonical Calendar view): a month grid with month/year
  // navigation and a per-day agenda, always fetching a 42-day month-grid
  // window. There is no Day/Week/Month mode control here anymore — that
  // belongs to the retired unified CalendarView. The shipped month-grid
  // behavior is covered by SimpleCalendarView.test.tsx.
  // The feed mock anchors "Design sync" at the requested window start (the
  // grid's first cell), so the populated feed is announced on the owning day
  // button ("<formatted date>. 1 event").
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const feedWindows: Array<{ timeMin: number; timeMax: number }> = [];
  page.on("request", (request) => {
    if (!request.url().includes("/api/lifeops/calendar/feed")) return;
    const url = new URL(request.url());
    const timeMin = Date.parse(url.searchParams.get("timeMin") ?? "");
    const timeMax = Date.parse(url.searchParams.get("timeMax") ?? "");
    if (Number.isFinite(timeMin) && Number.isFinite(timeMax)) {
      feedWindows.push({ timeMin, timeMax });
    }
  });

  await openAppPath(page, "/calendar");
  await expect(page.getByTestId("simple-calendar-view")).toBeVisible({
    timeout: 60_000,
  });
  // Today's cell is marked and the mocked feed rendered into the grid as an
  // event badge (the events sit on the grid's first two days, which usually
  // belong to the previous month, so the badge — not the agenda — is the
  // deterministic populated signal).
  await expect(page.locator('[aria-current="date"]').first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByRole("button", { name: /\. 1 event$/ }).first(),
  ).toBeVisible({ timeout: 15_000 });
  // The initial fetch is a month-grid window (42 local days; ±1 for DST).
  await expect
    .poll(() => feedWindows.length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const initialWindow = feedWindows[0];
  expect(initialWindow.timeMax - initialWindow.timeMin).toBeGreaterThanOrEqual(
    41 * ONE_DAY_MS,
  );
  expect(initialWindow.timeMax - initialWindow.timeMin).toBeLessThanOrEqual(
    43 * ONE_DAY_MS,
  );

  // Day selection is a real client-side state change: the agenda panel's
  // accessible name carries the raw selected date key, so pick an in-month,
  // event-free day (the 15th, or the 16th when today IS the 15th, so the
  // click always changes the selection) and assert the agenda re-targets it
  // with the designed empty state.
  const today = new Date();
  const targetDay = today.getDate() === 15 ? 16 : 15;
  const targetKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
  const targetCell = page.locator(
    `[data-agent-id="calendar-day-${targetKey}"]`,
  );
  await expect(targetCell).toBeVisible({ timeout: 15_000 });
  await targetCell.scrollIntoViewIfNeeded();
  await expectTopmostAtCenter(targetCell, `Calendar day cell ${targetKey}`);
  await targetCell.click();
  await expect(targetCell).toHaveAttribute("aria-pressed", "true", {
    timeout: 15_000,
  });
  await expect(
    page.locator(`section[aria-label="Events for ${targetKey}"]`),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("No plans yet").first()).toBeVisible({
    timeout: 15_000,
  });

  // Month navigation is a real server-visible state change: "Next month"
  // shifts the base date, useCalendarWeek refetches a later month-grid
  // window, and the header label changes. The mock re-anchors its events to
  // the new window start, so the event badge stays rendered.
  const monthTrigger = page.getByRole("button", {
    name: /^Choose month and year/,
  });
  await expect(monthTrigger).toBeVisible({ timeout: 15_000 });
  const initialMonthLabel = (await monthTrigger.innerText()).trim();
  const requestCountBeforeNav = feedWindows.length;
  await page.getByRole("button", { name: /^Next month/ }).click();
  await expect
    .poll(
      () =>
        feedWindows
          .slice(requestCountBeforeNav)
          .some(
            (window) =>
              window.timeMin > initialWindow.timeMin &&
              window.timeMax - window.timeMin >= 41 * ONE_DAY_MS &&
              window.timeMax - window.timeMin <= 43 * ONE_DAY_MS,
          ),
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect(monthTrigger).not.toHaveText(initialMonthLabel, {
    timeout: 15_000,
  });
  await expect(
    page.getByRole("button", { name: /\. 1 event$/ }).first(),
  ).toBeVisible({ timeout: 15_000 });

  // Reverse path: "Today" returns the grid to the current month.
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(monthTrigger).toHaveText(initialMonthLabel, {
    timeout: 15_000,
  });
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
  // branch. Selecting "Organizations" from the kind dropdown narrows the node
  // list to the organization node only; selecting "All" restores it.
  await openAppPath(page, "/relationships");
  await expect(page.getByText("3 entities", { exact: true })).toBeVisible({
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

  const kindFilter = page.locator(
    '[data-agent-id="relationships-kind-filter"]',
  );
  await expectTopmostAtCenter(kindFilter, "Relationships kind filter");
  await kindFilter.click();
  await page
    .getByRole("menuitemradio", { name: "Organizations", exact: true })
    .click();
  await expect(kindFilter).toHaveAttribute(
    "aria-label",
    "Filter relationship type, Organizations selected",
  );
  await expect(page.getByText("1 entity", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Pat Doe")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("Acme Corp").first()).toBeVisible({
    timeout: 15_000,
  });

  // #11144 guard: the kind control occupies the filter surface that used to
  // sit under the removed global corner back button. Drive the restore path
  // through the same topmost-checked control, then assert every kind is visible.
  await kindFilter.click();
  await page.getByRole("menuitemradio", { name: "All", exact: true }).click();
  await expect(kindFilter).toHaveAttribute(
    "aria-label",
    "Filter relationship type, All selected",
  );
  await expect(page.getByText("3 entities", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Pat Doe").first()).toBeVisible({
    timeout: 15_000,
  });
});
