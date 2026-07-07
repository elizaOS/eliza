/**
 * Gesture-matrix e2e (L3 of the UI interaction epic) — the full press/drag/
 * swipe/flick/layer matrix on the REAL shipped app, with REAL input:
 * `page.mouse` for desktop pointer paths (including the browser's genuine
 * compat-click synthesis — the thing jsdom can never produce and the root of
 * every ghost-click bug below) and CDP `Input.dispatchTouchEvent` for the
 * hasTouch mobile project.
 *
 * Coverage:
 *   1. Short press vs long press discrimination on launcher tiles — a tap
 *      launches; a long press must NOT launch on release (regression: the
 *      compat click after a long press passed the `!editing` guard and
 *      ghost-launched the tile).
 *   2. Inline notification inbox (`home-notification-center`, rendered directly
 *      on the home column) — a seeded inbox renders its rows; a row tap marks it
 *      read IN PLACE (order ignores read state, so the row never moves under the
 *      pointer); the per-row hover-X and the right-click menu each dismiss; there
 *      is no bulk clear-all.
 *   3. Chat sheet flick/drag detents — a fast upward flick on the grabber
 *      snaps the sheet open; a slow sub-threshold drag leaves it closed.
 *   4. Drag-through prevention — dragging the sheet grabber must not deliver
 *      pointer events into (or scroll) the home screen beneath.
 *   5. (touch) Rail flick home→launcher with a genuine CDP touch swipe must
 *      not ghost-launch the tile under the finger.
 *   6. (touch) A vertical pan over `home-notification-list` is contained to the
 *      inbox (the list is `overscroll-y-contain`) — it must not flip the
 *      home↔launcher rail, chain into the home column beneath, or ghost-tap the
 *      row under the finger.
 *   7. (touch) Swiping an inline notification row sideways throws it away.
 *
 * Capture artifacts land in Playwright's `test-results` tree.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import {
  cdpTouchDrag,
  installLayerLeakRecorder,
  mousePointerDrag,
  readLeakedEvents,
} from "./helpers/gesture-inputs";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

const REPO_ROOT = process.cwd().endsWith(path.join("packages", "app"))
  ? path.resolve(process.cwd(), "..", "..")
  : process.cwd();
const OUT_DIR = path.join(
  REPO_ROOT,
  "test-results",
  "ui-smoke-artifacts",
  "ui-interaction-epic",
  "l3-gestures",
);

async function evidenceShot(page: Page, name: string): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: path.join(OUT_DIR, `${name}.png`),
    fullPage: false,
    attempts: 3,
  });
}

test.beforeEach(async ({ page }) => {
  // Skip the once-ever first-run tour so its spotlight never intercepts input.
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
});

async function openHome(page: Page): Promise<void> {
  await openAppPath(page, "/chat");
  const surface = page.getByTestId("home-launcher-surface");
  await expect(surface).toBeVisible({ timeout: 60_000 });
  await expect(surface).toHaveAttribute("data-page", "home", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("home-screen")).toBeVisible({
    timeout: 15_000,
  });
}

/** Navigate to the launcher half deterministically (setup, not the gesture
 *  under test) and wait for the rail settle. A real leftward drag across the
 *  home half drives the rail's own gesture handler into `goLauncher()` — the
 *  same store action the UI calls; there is no event-bridge shortcut. */
async function openLauncherHalf(page: Page): Promise<void> {
  const homeHalf = page.getByTestId("home-launcher-home-page");
  await expect(homeHalf).toBeVisible({ timeout: 15_000 });
  await mousePointerDrag(page, homeHalf, -220, 4, { steps: 10 });
  await expect(page.getByTestId("home-launcher-surface")).toHaveAttribute(
    "data-page",
    "launcher",
    { timeout: 10_000 },
  );
  await expect(page.getByTestId("home-launcher-launcher-page")).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForFunction(
    () => {
      const rail = document.querySelector('[data-testid="home-launcher-rail"]');
      if (!rail) return false;
      return !(rail as HTMLElement)
        .getAnimations({ subtree: true })
        .some((animation) => animation.playState === "running");
    },
    undefined,
    { timeout: 10_000 },
  );
}

test("launcher tile: tap launches, long press does NOT ghost-launch on release", async ({
  page,
}) => {
  await openHome(page);
  await openLauncherHalf(page);

  const settingsTile = page
    .getByTestId("home-launcher-launcher-page")
    .getByTestId("launcher-tile-settings");
  await expect(settingsTile).toBeVisible({ timeout: 15_000 });
  const tileButton = settingsTile.getByRole("button").first();
  await evidenceShot(page, "tile-press-before");

  // LONG PRESS (hold well past the 450ms threshold, stationary, release).
  // The browser synthesizes a compat click from this same press on release —
  // before the fix that click passed `!editing` and launched Settings.
  const box = await tileButton.boundingBox();
  if (!box) throw new Error("settings tile has no bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
  // Give a leaked launch time to navigate before asserting it did not.
  await page.waitForTimeout(400);
  await expect(page.getByTestId("settings-shell")).toHaveCount(0);
  await expect(page.getByTestId("home-launcher-surface")).toHaveAttribute(
    "data-page",
    "launcher",
  );
  await evidenceShot(page, "tile-longpress-no-launch");

  // SHORT PRESS on the same tile launches.
  await tileButton.click();
  await expect(page.getByTestId("settings-shell")).toBeVisible({
    timeout: 15_000,
  });
  await evidenceShot(page, "tile-tap-launched");
});

// ── Dashboard notification center fixtures ──────────────────────────────────

interface SeededNotification {
  id: string;
  title: string;
  body?: string;
  category: string;
  priority: "low" | "normal" | "high" | "urgent";
  source: string;
  createdAt: number;
  readAt: number | null;
}

/**
 * Eight rows spanning the priority tiers. Priority + recency fix the dashboard
 * order exactly (urgent → high → normals newest-first); the two READ rows are
 * deliberately interleaved ABOVE unread ones ("Sync report" outranks "Weekly
 * digest" on recency) to prove read state never participates in the sort. No
 * row carries a deepLink, so a tap is exactly "mark read". (The pan-scroll test
 * needs an overflowing list and seeds its own taller fixture below.)
 */
function seedInboxNotifications(): SeededNotification[] {
  const base = Date.now();
  const row = (
    id: string,
    title: string,
    priority: SeededNotification["priority"],
    ageMs: number,
    readAt: number | null = null,
  ): SeededNotification => ({
    id,
    title,
    body: `${title} — seeded by gesture-matrix`,
    category: "system",
    priority,
    source: "ui-smoke",
    createdAt: base - ageMs,
    readAt,
  });
  return [
    row("n-urgent", "Payment failed", "urgent", 30_000),
    row("n-high", "Approval needed", "high", 60_000),
    row("n-1", "Backup finished", "normal", 90_000),
    row("n-2", "Sync report", "normal", 120_000, base - 100_000),
    row("n-3", "Weekly digest", "normal", 150_000),
    row("n-4", "New follower", "normal", 180_000),
    row("n-5", "Build passed", "normal", 210_000, base - 190_000),
    row("n-6", "Disk cleanup", "normal", 240_000),
  ];
}

const SEEDED_ORDER = [
  "Payment failed",
  "Approval needed",
  "Backup finished",
  "Sync report",
  "Weekly digest",
  "New follower",
  "Build passed",
  "Disk cleanup",
];

/** Rows the pan-scroll test seeds — see {@link seedOverflowInboxNotifications}. */
const OVERFLOW_ROWS = 24;

/**
 * A deliberately tall inbox for the pan-scroll test. The inline center fills the
 * home column (flex-1, no fixed height cap), so on a tall phone viewport the
 * 8-row fixture fits without overflow and there is nothing to scroll. Seed
 * enough rows — one interrupt-tier so the rested shade arms its expand
 * affordance, the rest sub-interrupt — that the EXPANDED list always exceeds the
 * column and has real scroll travel to pan.
 */
function seedOverflowInboxNotifications(): SeededNotification[] {
  const base = Date.now();
  const rows: SeededNotification[] = [
    {
      id: "n-urgent",
      title: "Payment failed",
      body: "Payment failed — seeded by gesture-matrix",
      category: "system",
      priority: "urgent",
      source: "ui-smoke",
      createdAt: base - 10_000,
      readAt: null,
    },
  ];
  for (let i = 0; i < OVERFLOW_ROWS - 1; i += 1) {
    rows.push({
      id: `n-fill-${i}`,
      title: `Notice ${i}`,
      body: `Notice ${i} — seeded by gesture-matrix`,
      category: "system",
      priority: "normal",
      source: "ui-smoke",
      createdAt: base - 20_000 - i * 1_000,
      readAt: null,
    });
  }
  return rows;
}

/**
 * Serve the seeded inbox. Registered after `installDefaultAppRoutes` (the
 * beforeEach), so it wins over the default empty-inbox stub — Playwright
 * matches the most recently registered route first. The mutation verbs must
 * answer success: the notification store mutates optimistically and REVERTS on
 * a failed write, so a 501 from the booted zero-key stack would roll every
 * mark-read/dismiss/clear back and the assertions below would (correctly) fail.
 */
async function installSeededInboxRoutes(
  page: Page,
  notifications: SeededNotification[],
): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  const unreadCount = notifications.filter((n) => !n.readAt).length;
  await page.route("**/api/notifications**", async (route) => {
    const request = route.request();
    const method = request.method();
    const { pathname } = new URL(request.url());
    if (method === "GET" && pathname === "/api/notifications") {
      await route.fulfill(json({ notifications, unreadCount }));
      return;
    }
    if (method === "POST" && pathname === "/api/notifications/read-all") {
      await route.fulfill(json({ changed: unreadCount }));
      return;
    }
    if (
      method === "POST" &&
      /^\/api\/notifications\/[^/]+\/read$/.test(pathname)
    ) {
      await route.fulfill(json({ ok: true }));
      return;
    }
    if (method === "DELETE" && pathname === "/api/notifications") {
      await route.fulfill(json({ ok: true }));
      return;
    }
    if (method === "DELETE" && /^\/api\/notifications\/[^/]+$/.test(pathname)) {
      await route.fulfill(json({ ok: true }));
      return;
    }
    await route.fallback();
  });
}

/**
 * The rendered row order as seeded titles, from DOM order. Row text also holds
 * body/timestamp, so map each row back to the unique seeded title it contains
 * — a row matching no seeded title is a hard failure, not a skip.
 */
async function rowTitleOrder(center: Locator): Promise<string[]> {
  const texts = await center.getByTestId("notification-row").allTextContents();
  return texts.map((text) => {
    const match = SEEDED_ORDER.find((title) => text.includes(title));
    if (!match)
      throw new Error(`notification row with unseeded content: ${text}`);
    return match;
  });
}

/**
 * Fan the rested shade open so every seeded row renders flat. The inbox is
 * priority-triaged: at rest only interrupt-tier rows (high/urgent) show,
 * Z-stacked by view group, so a mixed-priority seed collapses to a single
 * visible row. Driving the sr-only expand toggle runs the same pull-to-expand
 * transition an AT/keyboard user takes, fanning all rows out (one un-stacked
 * `notification-row` per seeded item).
 */
async function expandNotificationShade(page: Page): Promise<void> {
  await page.getByTestId("notifications-expand-toggle").dispatchEvent("click");
}

test("dashboard notification center: row tap marks read in place, hover-X dismiss removes, context menu dismisses, no clear-all", async ({
  page,
}, testInfo) => {
  // The hover-X and right-click paths are MOUSE affordances (the X is
  // `pointer-coarse:hidden`; touch has no right-click). The touch equivalents —
  // sideways swipe + long-press menu — are covered by the real-touch describe
  // below, so this pointer test only runs on the non-touch projects.
  test.skip(
    Boolean(testInfo.project.use?.hasTouch),
    "mouse-pointer paths (hover-X, right-click); touch paths live in the real-touch describe",
  );
  await installSeededInboxRoutes(page, seedInboxNotifications());
  await openHome(page);

  // (a) The inbox renders INLINE on the home column (no shade, no hint pill):
  // it carries every seeded row in priority-bucket-then-recency order, and the
  // unread badge counts the six unread rows.
  const center = page.getByTestId("home-notification-center");
  await expect(center).toBeVisible({ timeout: 15_000 });
  // Inline on the same layer — inside the home scroller, not a portal shade.
  await expect(page.getByTestId("notifications-shade")).toHaveCount(0);
  await expect(
    page.getByTestId("home-screen").getByTestId("home-notification-center"),
  ).toBeVisible();
  await expect(center.getByTestId("notification-row")).toHaveCount(8, {
    timeout: 15_000,
  });
  await expect(center.getByTestId("notifications-unread-badge")).toHaveText(
    "6",
  );
  expect(await rowTitleOrder(center)).toEqual(SEEDED_ORDER);
  await evidenceShot(page, "notification-center-seeded");

  // (b) Tapping a row marks it read WITHOUT moving it. The tapped row is the
  // top (urgent, unread) one — under an unread-first inbox sort it would sink
  // below the six remaining unread rows, so an identical order is a real
  // no-reshuffle proof, not a tautology.
  const urgentRow = center
    .getByTestId("notification-row")
    .filter({ hasText: "Payment failed" });
  await expect(urgentRow).toHaveAttribute("data-unread", "true");
  await urgentRow.click();
  await expect(urgentRow).not.toHaveAttribute("data-unread", "true", {
    timeout: 10_000,
  });
  await expect(center.getByTestId("notifications-unread-badge")).toHaveText(
    "5",
  );
  expect(await rowTitleOrder(center)).toEqual(SEEDED_ORDER);
  // The tap had no deepLink: the home surface must not have navigated.
  await expect(page.getByTestId("home-screen")).toBeVisible();
  await expect(page.getByTestId("continuous-chat-overlay")).not.toHaveAttribute(
    "data-open",
    "true",
  );
  await evidenceShot(page, "notification-center-row-read-in-place");

  // (c) The per-row X removes exactly that row.
  await center
    .locator("li[data-notif-row]")
    .filter({ hasText: "Approval needed" })
    .getByTestId("notification-row-dismiss")
    .click();
  await expect(
    center
      .getByTestId("notification-row")
      .filter({ hasText: "Approval needed" }),
  ).toHaveCount(0, { timeout: 10_000 });
  await expect(center.getByTestId("notification-row")).toHaveCount(7);

  // (d) There is no bulk clear-all trash button any more — rows are dismissed
  // one at a time. The right-click contextual menu is a second per-row path:
  // open it on a remaining row and dismiss from it.
  await expect(center.getByTestId("notifications-clear-all")).toHaveCount(0);
  // Right-click the row button; the contextmenu bubbles to the row li, which
  // opens the menu.
  const menuTarget = center
    .getByTestId("notification-row")
    .filter({ hasText: "Payment failed" });
  await menuTarget.click({ button: "right" });
  await expect(page.getByTestId("notification-row-menu")).toBeVisible({
    timeout: 10_000,
  });
  await page.getByTestId("notification-menu-dismiss").click();
  await expect(
    center
      .getByTestId("notification-row")
      .filter({ hasText: "Payment failed" }),
  ).toHaveCount(0, { timeout: 10_000 });
  await expect(center.getByTestId("notification-row")).toHaveCount(6);
  await evidenceShot(page, "notification-center-row-menu-dismiss");
});

test("chat sheet: fast flick snaps open, slow sub-threshold drag stays closed, and the drag never leaks under the sheet", async ({
  page,
}) => {
  await openHome(page);
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });
  await expect(overlay).not.toHaveAttribute("data-open", "true");
  const grabber = page.locator('[data-testid="chat-sheet-grabber"]').first();
  await expect(grabber).toBeVisible({ timeout: 15_000 });

  // Record any pointer event that lands INSIDE the home screen (the layer
  // beneath the sheet) plus its scroll position — a grabber drag must produce
  // neither.
  await installLayerLeakRecorder(page, "home-screen");
  const scrollBefore = await page
    .getByTestId("home-screen")
    .evaluate((el) => el.scrollTop);

  // SLOW sub-threshold drag (~30px, well under the 56px distance gate, slow
  // enough to be under the flick velocity gate) — the sheet must NOT open.
  await mousePointerDrag(page, grabber, 0, -30, { steps: 6, pauseMs: 40 });
  await page.waitForTimeout(300);
  await expect(overlay).not.toHaveAttribute("data-open", "true");
  await evidenceShot(page, "sheet-slow-subthreshold-stays-closed");

  // FAST flick up (past distance AND velocity) — snaps to the open detent.
  await mousePointerDrag(page, grabber, 0, -160, { steps: 5 });
  await expect(overlay).toHaveAttribute("data-open", "true", {
    timeout: 10_000,
  });
  await evidenceShot(page, "sheet-flick-opened");

  // DRAG-THROUGH: no pointer event reached the home screen beneath, and it
  // did not scroll.
  const leaks = await readLeakedEvents(page);
  expect(
    leaks,
    `pointer events leaked into the home screen during sheet gestures: ${JSON.stringify(leaks)}`,
  ).toEqual([]);
  const scrollAfter = await page
    .getByTestId("home-screen")
    .evaluate((el) => el.scrollTop);
  expect(scrollAfter).toBe(scrollBefore);

  // Close with a downward flick on the grabber — back to the collapsed detent.
  await mousePointerDrag(page, grabber, 0, 200, { steps: 5 });
  await expect(overlay).not.toHaveAttribute("data-open", "true", {
    timeout: 10_000,
  });
  await evidenceShot(page, "sheet-flick-closed");
});

test.describe("real touch (hasTouch project)", () => {
  test("rail flick home→launcher via CDP touch does not ghost-launch the tile under the finger", async ({
    page,
    browserName,
  }, testInfo) => {
    const hasTouch = Boolean(testInfo.project.use?.hasTouch);
    test.skip(!hasTouch, "requires a touch-enabled project (hasTouch)");
    test.skip(
      browserName !== "chromium",
      "CDP Input.dispatchTouchEvent is Chromium-only; non-Chromium touch runs on the real-device capture lanes",
    );

    await openHome(page);
    const surface = page.getByTestId("home-launcher-surface");
    const homeHalf = page.getByTestId("home-launcher-home-page");

    // Genuine touch flick LEFT across the home half → the launcher page.
    await cdpTouchDrag(page, homeHalf, -220, 4, 10);
    await expect(surface).toHaveAttribute("data-page", "launcher", {
      timeout: 10_000,
    });
    await evidenceShot(page, "touch-rail-flick-to-launcher");

    // GHOST-CLICK: the release must not tap-launch whatever tile ended up
    // under the finger — no view opened, the launcher is still showing.
    await page.waitForTimeout(500);
    await expect(page.getByTestId("settings-shell")).toHaveCount(0);
    await expect(surface).toHaveAttribute("data-page", "launcher");
    await expect(
      page.getByTestId("continuous-chat-overlay"),
    ).not.toHaveAttribute("data-open", "true");

    // Flick RIGHT on the launcher half → back home (the paired back gesture).
    const launcherHalf = page.getByTestId("home-launcher-launcher-page");
    await cdpTouchDrag(page, launcherHalf, 220, 4, 10);
    await expect(surface).toHaveAttribute("data-page", "home", {
      timeout: 10_000,
    });
    await evidenceShot(page, "touch-rail-flick-back-home");
  });

  test("vertical pan over the notification list is contained — no rail flip, no home scroll, no ghost row-tap", async ({
    page,
    browserName,
  }, testInfo) => {
    const hasTouch = Boolean(testInfo.project.use?.hasTouch);
    test.skip(!hasTouch, "requires a touch-enabled project (hasTouch)");
    test.skip(
      browserName !== "chromium",
      "CDP Input.dispatchTouchEvent is Chromium-only; non-Chromium touch runs on the real-device capture lanes",
    );

    await installSeededInboxRoutes(page, seedOverflowInboxNotifications());
    await openHome(page);

    // Fan the shade out and seed a tall inbox so the home-screen scroller
    // genuinely overflows — the column CAN scroll, which makes the containment
    // assertion below meaningful rather than vacuous.
    const center = page.getByTestId("home-notification-center");
    await expect(center).toBeVisible({ timeout: 15_000 });
    await expandNotificationShade(page);
    const list = page.getByTestId("home-notification-list");
    await expect(list.getByTestId("notification-row")).toHaveCount(
      OVERFLOW_ROWS,
      { timeout: 15_000 },
    );
    const homeScreen = page.getByTestId("home-screen");
    const overflows = await homeScreen.evaluate(
      (el) => el.scrollHeight > el.clientHeight + 8,
    );
    expect(
      overflows,
      "seeded home column must overflow so containment is not vacuous",
    ).toBe(true);
    const homeScrollBefore = await homeScreen.evaluate((el) => el.scrollTop);

    // Genuine touch pan UP over the notification list (a slight horizontal
    // wobble, like a real finger). The list is `overscroll-y-contain`, so the pan
    // is CONTAINED to the notification area: it must not be hijacked into the
    // horizontal home↔launcher rail, must not chain into the (scrollable) home
    // column beneath, and its touch release must not ghost-tap the row under the
    // finger.
    await cdpTouchDrag(page, list, 4, -160, 10);
    await page.waitForTimeout(400);

    // Rail did not flip; the home column beneath did not scroll (the pan was
    // contained); every seeded row is still present and none expanded its option
    // strip (a tap would expand `notification-row-options`); the chat overlay
    // stayed closed.
    await expect(page.getByTestId("home-launcher-surface")).toHaveAttribute(
      "data-page",
      "home",
    );
    const homeScrollAfter = await homeScreen.evaluate((el) => el.scrollTop);
    expect(homeScrollAfter).toBe(homeScrollBefore);
    await expect(list.getByTestId("notification-row")).toHaveCount(
      OVERFLOW_ROWS,
    );
    await expect(center.getByTestId("notification-row-options")).toHaveCount(0);
    await expect(
      page.getByTestId("continuous-chat-overlay"),
    ).not.toHaveAttribute("data-open", "true");
    await evidenceShot(page, "touch-notification-list-pan-contained");
  });

  test("swipe an inline row sideways throws it away", async ({
    page,
    browserName,
  }, testInfo) => {
    const hasTouch = Boolean(testInfo.project.use?.hasTouch);
    test.skip(!hasTouch, "requires a touch-enabled project (hasTouch)");
    test.skip(
      browserName !== "chromium",
      "CDP Input.dispatchTouchEvent is Chromium-only; non-Chromium touch runs on the real-device capture lanes",
    );

    await installSeededInboxRoutes(page, seedInboxNotifications());
    await openHome(page);
    // The inbox is inline on the home column — no shade to open.
    const center = page.getByTestId("home-notification-center");
    await expect(center).toBeVisible({ timeout: 15_000 });
    // Fan the priority-triaged shade out so the sub-interrupt "Backup finished"
    // row is present to swipe (rested it stays stacked behind the top card).
    await expandNotificationShade(page);
    await expect(center.getByTestId("notification-row")).toHaveCount(8, {
      timeout: 15_000,
    });

    // Throw a specific row LEFT past the dismiss threshold — the touch swipe
    // idiom that replaces the hover X on coarse pointers.
    const swipeTarget = center
      .locator("li[data-notif-row]")
      .filter({ hasText: "Backup finished" })
      .first()
      .getByTestId("notification-row-swipe");
    await expect(swipeTarget).toBeVisible();
    await cdpTouchDrag(page, swipeTarget, -160, 0, 14);
    await expect(center.getByTestId("notification-row")).toHaveCount(7, {
      timeout: 10_000,
    });
    await evidenceShot(page, "swipe-row-dismissed");
  });
});
