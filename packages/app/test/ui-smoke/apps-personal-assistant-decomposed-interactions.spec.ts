// Interaction coverage for the decomposed personal-assistant domain views
// (calendar, documents, finances, focus, goals, health, inbox, todos). These are
// dynamic plugin views; the ui-smoke stub now registers their bundles so they
// render (not the launcher fallback). calendar/documents/inbox have real client
// controls (tabs, channel filters) which we drive; the rest are display
// scaffolds whose render we assert. This is the interaction owner that closes
// INTERACTION_DEBT in view-interaction-coverage.test.ts.

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

test("calendar decomposed view: day/week/month view-mode control switches", async ({
  page,
}) => {
  // /calendar now mounts the rich CalendarSection (nav + SegmentedControl
  // view-mode control + grid), not the old day/week/month placeholder switcher.
  await openAppPath(page, "/calendar");
  await expect(
    page.getByTestId("lifeops-calendar-section").first(),
  ).toBeVisible({ timeout: 60_000 });

  // The view-mode control is a SegmentedControl whose buttons expose accessible
  // names ("Day" / "Week" / "Month") with aria-pressed — drive it by role+name
  // (Playwright-preferred) rather than a testId. Week is the default selection.
  // exact:true so "Day" does not substring-match the "Today" nav button.
  const week = page.getByRole("button", { name: "Week", exact: true }).first();
  const day = page.getByRole("button", { name: "Day", exact: true }).first();
  await expect(week).toBeVisible({ timeout: 15_000 });
  await expect(week).toHaveAttribute("aria-pressed", "true", {
    timeout: 10_000,
  });
  await day.click();
  await expect(day).toHaveAttribute("aria-pressed", "true", {
    timeout: 10_000,
  });

  // The feed mock seeds events inside the window, so the grid renders populated.
  await expect(page.getByText("Design sync").first()).toBeVisible({
    timeout: 15_000,
  });
});

// NOTE: "documents" is intentionally not covered here — its `/documents` view
// path collides with the built-in "documents" tab (which is /character/documents),
// so registering it in the stub hijacks that route. Tracked as documented debt in
// view-interaction-coverage.test.ts.

test("inbox decomposed view: channel filters toggle", async ({ page }) => {
  await openAppPath(page, "/inbox");
  await expect(
    page.getByRole("heading", { name: /^Inbox$/ }).first(),
  ).toBeVisible({ timeout: 60_000 });

  const email = page.getByRole("button", { name: /^Email$/ });
  await expect(email).toBeVisible({ timeout: 15_000 });
  const before = await email.getAttribute("aria-pressed");
  await email.click();
  await expect.poll(() => email.getAttribute("aria-pressed")).not.toBe(before);
});

test("finances decomposed view: renders the financial summary", async ({
  page,
}) => {
  await openAppPath(page, "/finances");
  await expect(
    page.getByRole("heading", { name: /Balance/i }).first(),
  ).toBeVisible({ timeout: 60_000 });
  // The feed mock seeds payment sources + transactions, so FinancesView lands on
  // its populated branch (Recent transactions list), not the empty state.
  await expect(
    page.getByRole("heading", { name: /Recent transactions/i }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Latte").first()).toBeVisible({
    timeout: 15_000,
  });
});

test("focus decomposed view: renders the focus scaffold", async ({ page }) => {
  await openAppPath(page, "/focus");
  await expect(
    page.getByRole("heading", { name: /^Focus$/ }).first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByText(/No active focus session\./i).first(),
  ).toBeVisible({ timeout: 15_000 });
});

test("goals decomposed view: renders the goals scaffold", async ({ page }) => {
  await openAppPath(page, "/goals");
  await expect(
    page.getByRole("heading", { name: /^Goals$/ }).first(),
  ).toBeVisible({ timeout: 60_000 });
});

test("health decomposed view: renders the health regions", async ({ page }) => {
  await openAppPath(page, "/health");
  await expect(
    page.getByRole("heading", { name: /^Health$/ }).first(),
  ).toBeVisible({ timeout: 60_000 });
});

test("todos decomposed view: renders the todo lanes", async ({ page }) => {
  await openAppPath(page, "/todos");
  await expect(
    page.getByRole("heading", { name: /^Todos$/ }).first(),
  ).toBeVisible({ timeout: 60_000 });
});

test("relationships decomposed view: renders the graph and toggles a kind filter", async ({
  page,
}) => {
  // /relationships mounts the RelationshipsView knowledge-graph viewer. The
  // helper mocks GET /api/lifeops/entities + /api/lifeops/relationships with a
  // populated graph, so the view lands on its populated branch with entity
  // cards. Toggling the "Organizations" kind filter narrows the visible cards.
  await openAppPath(page, "/relationships");
  await expect(
    page.getByRole("heading", { name: /^Relationships$/ }).first(),
  ).toBeVisible({ timeout: 60_000 });

  const orgs = page.getByRole("button", { name: "Organizations" });
  await expect(orgs).toBeVisible({ timeout: 15_000 });
  const before = await orgs.getAttribute("aria-pressed");
  await orgs.click();
  await expect.poll(() => orgs.getAttribute("aria-pressed")).not.toBe(before);
});
