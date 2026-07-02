// Interaction coverage for the decomposed personal-assistant domain views
// (calendar, finances, focus, goals, health, inbox, todos, relationships).
// These are dynamic plugin views; the ui-smoke stub registers their bundles so
// they render (not the launcher fallback). Each `<Domain>View` is the unified
// spatial wrapper (the author-once GUI/XR/TUI component) — it renders the SAME
// DOM on the desktop `chromium` and Pixel-7 `mobile-chromium` lanes, so every
// assertion below is a viewport-independent semantic outcome: populated content
// from the mocked lifeops endpoints plus a real state-changing interaction
// (channel/kind/status filters, the calendar mode control). This is the
// interaction owner that closes INTERACTION_DEBT in
// view-interaction-coverage.test.ts.

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

  // #11144 regressed when ShellBackButton visually cleared the content but kept
  // intercepting first-chip pointer input. This guard asserts the target chip is
  // the DOM hit-test winner at its own center before clicking it.
  expect(
    isTopmost,
    `${owner} should be topmost at its center, not occluded by the shell back button (#11144)`,
  ).toBe(true);
}

test("calendar decomposed view: day/week/month view-mode control switches", async ({
  page,
}) => {
  // /calendar mounts the unified CalendarView (period nav + Day/Week/Month mode
  // control + agenda). The feed mock anchors "Design sync" at the window start,
  // so the agenda renders populated.
  await openAppPath(page, "/calendar");
  const day = page.getByRole("button", { name: "Day", exact: true }).first();
  const week = page.getByRole("button", { name: "Week", exact: true }).first();
  await expect(week).toBeVisible({ timeout: 60_000 });
  await expect(day).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Design sync").first()).toBeVisible({
    timeout: 15_000,
  });

  // Switching Week → Day is a real state change: useCalendarWeek refetches the
  // feed with a single-day window (week fetches 7 days, month a whole grid).
  // Assert the narrowed window request, then that the agenda re-renders
  // populated (the mock re-anchors its events to the new window start).
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const dayWindowFeed = page.waitForRequest(
    (request) => {
      if (!request.url().includes("/api/lifeops/calendar/feed")) return false;
      const url = new URL(request.url());
      const timeMin = Date.parse(url.searchParams.get("timeMin") ?? "");
      const timeMax = Date.parse(url.searchParams.get("timeMax") ?? "");
      if (!Number.isFinite(timeMin) || !Number.isFinite(timeMax)) return false;
      return timeMax - timeMin <= 2 * ONE_DAY_MS;
    },
    { timeout: 15_000 },
  );
  await day.click();
  await dayWindowFeed;
  await expect(page.getByText("Design sync").first()).toBeVisible({
    timeout: 15_000,
  });
});

// NOTE: "documents" is intentionally not covered here — its `/documents` view
// path collides with the built-in "documents" tab (which is /character/documents),
// so registering it in the stub hijacks that route. Tracked as documented debt in
// view-interaction-coverage.test.ts.

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
  await expect(page.getByText("Graph (3)").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Pat Doe").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Acme Corp").first()).toBeVisible({
    timeout: 15_000,
  });

  await page
    .getByRole("button", { name: "Organizations", exact: true })
    .click();
  await expect(page.getByText("Graph (1)").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Pat Doe")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("Acme Corp").first()).toBeVisible({
    timeout: 15_000,
  });

  // #11144 guard: the first "All" kind chip is the one that used to sit under
  // ShellBackButton. Drive the real restore path through it, then assert every
  // kind is visible again.
  const allChip = page
    .getByRole("button", { name: "All", exact: true })
    .first();
  await expectTopmostAtCenter(allChip, "Relationships All kind chip");
  await allChip.click();
  await expect(page.getByText("Graph (3)").first()).toBeVisible({
    timeout: 15_000,
  });
});

/**
 * Drive a REAL two-finger pinch via CDP `Input.dispatchTouchEvent` (genuine
 * multi-touch input, not desktop mouse) — #9943 item 6 "pinch case". `scale > 1`
 * spreads the fingers apart (pinch-out → zoom in). Touch input is enabled at the
 * CDP level so the view keeps its desktop layout; only the gesture is touch.
 */
async function touchPinch(
  page: Page,
  selector: string,
  scale: number,
  steps = 16,
) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("no viewport size");
  // Defensive (post-#11145): the graph container is now viewport-clamped, so
  // its box should already fit on-screen — but a partially-scrolled or
  // off-origin target is still possible, so pinch at the centre of the
  // container ∩ viewport intersection to guarantee fingers land on VISIBLE
  // pixels regardless.
  const left = Math.max(box.x, 0);
  const right = Math.min(box.x + box.width, viewport.width);
  const top = Math.max(box.y, 0);
  const bottom = Math.min(box.y + box.height, viewport.height);
  if (right - left < 80 || bottom - top < 40) {
    throw new Error(`${selector} is not sufficiently on-screen for a pinch`);
  }
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const startGap = Math.min(60, (right - left) / 4);
  const points = (gap: number) => [
    { x: cx - gap, y: cy, id: 0 },
    { x: cx + gap, y: cy, id: 1 },
  ];
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 2,
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: points(startGap),
    });
    for (let i = 1; i <= steps; i += 1) {
      const gap = startGap * (1 + (scale - 1) * (i / steps));
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: points(gap),
      });
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }
}

/**
 * A populated RelationshipsGraphSnapshot for the BUILT-IN relationships
 * workspace at /apps/relationships (a shell-reserved path), whose
 * RelationshipsGraphPanel is the app's zoomable `[data-graph-container]` pinch
 * surface. (The decomposed /relationships plugin view above is the spatial node
 * LIST — it has no zoom surface.) Shape mirrors
 * packages/ui/src/api/client-types-relationships.ts, wrapped in the `{ data }`
 * envelope `getRelationshipsGraph` unwraps.
 */
function graphPerson(groupId: string, displayName: string, isOwner: boolean) {
  return {
    groupId,
    primaryEntityId: `${groupId}-entity`,
    memberEntityIds: [`${groupId}-entity`],
    displayName,
    aliases: [],
    platforms: ["discord"],
    identities: [],
    emails: [],
    phones: [],
    websites: [],
    preferredCommunicationChannel: null,
    categories: [],
    tags: [],
    factCount: 1,
    relationshipCount: 1,
    isOwner,
    profiles: [],
  };
}

const PINCH_GRAPH_SNAPSHOT = {
  data: {
    people: [
      graphPerson("grp-owner", "Owner", true),
      graphPerson("grp-pat", "Pat Doe", false),
    ],
    relationships: [
      {
        id: "edge-owner-pat",
        sourcePersonId: "grp-owner",
        targetPersonId: "grp-pat",
        sourcePersonName: "Owner",
        targetPersonName: "Pat Doe",
        relationshipTypes: ["colleague_of"],
        sentiment: "positive",
        strength: 3,
        interactionCount: 12,
        rawRelationshipIds: ["rel-1"],
      },
    ],
    stats: { totalPeople: 2, totalRelationships: 1, totalIdentities: 2 },
    candidateMerges: [],
  },
};

test("relationships graph: two-finger pinch-out zooms in under REAL touch (not mouse)", async ({
  page,
}) => {
  await page.route("**/api/relationships/graph**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(PINCH_GRAPH_SNAPSHOT),
    });
  });
  await openAppPath(page, "/apps/relationships");
  const container = page.locator("[data-graph-container]");
  await expect(container).toBeVisible({ timeout: 60_000 });

  // #11145 (fixed): the graph container is clamped to the viewport
  // (`w-full max-w-full` + internal `overflow-auto`), so the zoomed SVG pans
  // inside it instead of stretching the layout box to the SVG width.
  const viewport = page.viewportSize();
  if (viewport) {
    const box = await container.boundingBox();
    expect(box, "graph container should be laid out").not.toBeNull();
    if (box) {
      // +1px slack for sub-pixel rounding.
      expect(box.width).toBeLessThanOrEqual(viewport.width + 1);
    }
  }

  const graphSvg = container.locator("svg").first();
  await expect(graphSvg).toBeVisible({ timeout: 15_000 });
  const widthOf = () =>
    graphSvg.evaluate((el) => {
      const styled = Number.parseFloat((el as SVGElement).style.width);
      return Number.isFinite(styled)
        ? styled
        : el.getBoundingClientRect().width;
    });
  const before = await widthOf();

  // Spread two fingers apart → the graph zooms in → its rendered width grows.
  await touchPinch(page, "[data-graph-container]", 2);

  await expect.poll(widthOf, { timeout: 10_000 }).toBeGreaterThan(before);
});
