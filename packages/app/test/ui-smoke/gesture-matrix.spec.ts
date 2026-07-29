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
 *      on the home column) — the rested shade shows interrupt-tier rows, expands
 *      to every priority, and supports platform-style tap acknowledgement and
 *      horizontal dismiss.
 *   3. Chat sheet flick/drag detents — a fast upward flick on the grabber
 *      snaps the sheet open; a slow sub-threshold drag leaves it closed.
 *   4. Drag-through prevention — dragging the sheet grabber must not deliver
 *      pointer events into (or scroll) the home screen beneath.
 *   5. (touch) A genuine CDP touch rail flick that starts on a launcher tile
 *      must return home without ghost-launching that tile.
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
import { navigateHomeLauncher } from "./helpers/launcher-navigation";
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

test("launcher tile: tap launches, long press does NOT ghost-launch on release", async ({
  page,
}) => {
  await openHome(page);
  const grid = await navigateHomeLauncher(page, "launcher");

  const settingsTile = grid.getByTestId("launcher-tile-settings");
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
 *
 * Each row carries a DISTINCT `source` so the shade groups it as its own
 * single-row producer stack — the realistic many-producer inbox. Same-source
 * rows collapse into one Z-stacked producer card (1 visible row + peeks) that
 * only fans on a tap, so a shared source would render one row where these
 * gesture tests need every seeded row flat (`NotificationsHomeCenter.test.tsx`
 * pins the stacking behaviour).
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
    source: `ui-smoke-${id}`,
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
 *
 * Every row uses a DISTINCT `source` so each is its own single-row producer
 * group: the expanded shade then renders all OVERFLOW_ROWS rows flat (a genuine
 * multi-producer overflow) instead of one Z-stacked producer card. A shared
 * source would collapse the whole fixture into a single tap-to-fan stack and the
 * list would never overflow.
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
      source: "ui-smoke-n-urgent",
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
      source: `ui-smoke-n-fill-${i}`,
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
 * Z-stacked by producer. The notification-count button is the
 * keyboard-accessible form of the same pull-to-expand transition, fanning all
 * priorities out.
 */
async function expandNotificationShade(page: Page): Promise<void> {
  await page.getByTestId("notifications-count-button").click();
  await expect(page.getByTestId("home-notification-list")).toHaveAttribute(
    "data-shade-mode",
    "expanded",
  );
}

test("dashboard notification center: rested priority, expansion, tap acknowledgement, and horizontal dismiss", async ({
  page,
}, testInfo) => {
  // This test drives the mouse implementation of horizontal dismiss. The same
  // interaction runs through genuine CDP touch in the real-touch describe.
  test.skip(
    Boolean(testInfo.project.use?.hasTouch),
    "mouse-pointer path; touch dismissal lives in the real-touch describe",
  );
  await installSeededInboxRoutes(page, seedInboxNotifications());
  await openHome(page);

  // At rest the inline center shows only interrupt-tier rows while preserving
  // the full inbox count as the explicit expand affordance.
  const center = page.getByTestId("home-notification-center");
  await expect(center).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("notifications-shade")).toHaveCount(0);
  await expect(
    page.getByTestId("home-screen").getByTestId("home-notification-center"),
  ).toBeVisible();
  await expect(center.getByTestId("notification-row")).toHaveCount(2, {
    timeout: 15_000,
  });
  expect(await rowTitleOrder(center)).toEqual(SEEDED_ORDER.slice(0, 2));
  await expect(center.getByTestId("notifications-count-button")).toHaveText(
    "8 Notifications",
  );

  await expandNotificationShade(page);
  await expect(center.getByTestId("notification-row")).toHaveCount(8);
  expect(await rowTitleOrder(center)).toEqual(SEEDED_ORDER);
  await evidenceShot(page, "notification-center-expanded");

  // Platform-shade acknowledgement clears a row after acting on its safe
  // destination. This fixture has no destination, so the tap only clears.
  const urgentRow = center
    .getByTestId("notification-row")
    .filter({ hasText: "Payment failed" });
  await urgentRow.click();
  await expect(urgentRow).toHaveCount(0, { timeout: 10_000 });
  await expect(center.getByTestId("notification-row")).toHaveCount(7);
  await expect(page.getByTestId("home-screen")).toBeVisible();
  await expect(page.getByTestId("chat-overlay")).not.toHaveAttribute(
    "data-open",
    "true",
  );
  await evidenceShot(page, "notification-center-row-acknowledged");

  // A genuine pointer drag uses the row's shipped horizontal-dismiss path.
  const approvalRow = center
    .locator("li[data-notif-row]")
    .filter({ hasText: "Approval needed" })
    .getByTestId("notification-row-swipe");
  await mousePointerDrag(page, approvalRow, -140, 0, { steps: 8 });
  await expect(
    center
      .getByTestId("notification-row")
      .filter({ hasText: "Approval needed" }),
  ).toHaveCount(0, { timeout: 10_000 });
  await expect(center.getByTestId("notification-row")).toHaveCount(6);
  await evidenceShot(page, "notification-center-row-drag-dismiss");
});

test("chat sheet: fast flick snaps open, slow sub-threshold drag stays closed, and the drag never leaks under the sheet", async ({
  page,
}) => {
  await openHome(page);
  const overlay = page.getByTestId("chat-overlay");
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
  test("rail flick starting on a launcher tile via CDP touch returns home without ghost-launching it", async ({
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

    // The shared helper uses genuine CDP touch and refuses a mouse fallback.
    const grid = await navigateHomeLauncher(page, "launcher", {
      input: "touch",
    });
    await evidenceShot(page, "touch-rail-flick-to-launcher");

    // Start the return flick on the actual Settings control. A swipe from empty
    // rail space proves navigation, but cannot catch the compat-click regression
    // this case owns.
    const settingsButton = grid
      .getByTestId("launcher-tile-settings")
      .getByRole("button", { name: "Settings" });
    await expect(settingsButton).toBeVisible({ timeout: 15_000 });
    await cdpTouchDrag(page, settingsButton, 220, 4, 10);

    // GHOST-CLICK: release must not launch the tile where the finger started.
    await page.waitForTimeout(500);
    await expect(page.getByTestId("settings-shell")).toHaveCount(0);
    await expect(surface).toHaveAttribute("data-page", "home");
    await expect(page.getByTestId("chat-overlay")).not.toHaveAttribute(
      "data-open",
      "true",
    );
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

    // Fan the shade out and seed a tall inbox so the notification LIST — the
    // internal scroller under the finger — genuinely overflows. The home column
    // itself intentionally does NOT overflow: the inbox is `flex-1 min-h-0` and
    // scrolls in place so it never grows behind the floating composer, so the
    // definite-height column has no scroll travel. Overflowing the list is what
    // gives the contained pan real travel and keeps the assertions below
    // meaningful rather than vacuous.
    const center = page.getByTestId("home-notification-center");
    await expect(center).toBeVisible({ timeout: 15_000 });
    await expandNotificationShade(page);
    const list = page.getByTestId("home-notification-list");
    await expect(list.getByTestId("notification-row")).toHaveCount(
      OVERFLOW_ROWS,
      { timeout: 15_000 },
    );
    const listOverflows = await list.evaluate(
      (el) => el.scrollHeight > el.clientHeight + 8,
    );
    expect(
      listOverflows,
      "seeded notification list must overflow so the contained pan has real scroll travel",
    ).toBe(true);
    const homeScreen = page.getByTestId("home-screen");
    const homeScrollBefore = await homeScreen.evaluate((el) => el.scrollTop);
    const listScrollBefore = await list.evaluate((el) => el.scrollTop);

    // Genuine touch pan UP over the notification list (a slight horizontal
    // wobble, like a real finger). The list is `overscroll-y-contain`, so the pan
    // is CONTAINED to the notification area: it scrolls the list IN PLACE, must
    // not be hijacked into the horizontal home↔launcher rail, must not chain into
    // the home column beneath, and its touch release must not ghost-tap the row
    // under the finger.
    await cdpTouchDrag(page, list, 4, -160, 10);
    await page.waitForTimeout(400);

    // The pan was consumed by the list (it scrolled internally) — the positive
    // proof it stayed contained there. The rail did not flip; the home column
    // beneath did not scroll; every seeded row is still present and none expanded
    // its option strip (a tap would expand `notification-row-options`); the chat
    // overlay stayed closed.
    const listScrollAfter = await list.evaluate((el) => el.scrollTop);
    expect(listScrollAfter).toBeGreaterThan(listScrollBefore);
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
    await expect(page.getByTestId("chat-overlay")).not.toHaveAttribute(
      "data-open",
      "true",
    );
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
    // Expand the priority-triaged shade so the sub-interrupt "Backup finished"
    // row is present to swipe (rested, only interrupt-tier producers show, so
    // this normal-priority producer stays hidden until the shade fans out).
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
