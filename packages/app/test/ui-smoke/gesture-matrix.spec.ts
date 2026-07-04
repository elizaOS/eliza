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
 *   2. Notification pull zone — pull-down opens the center; an UPWARD drag's
 *      trailing compat click must NOT open it (regression: the direction gate
 *      was defeated by the synthesized click in real browsers).
 *   3. Chat sheet flick/drag detents — a fast upward flick on the grabber
 *      snaps the sheet open; a slow sub-threshold drag leaves it closed.
 *   4. Drag-through prevention — dragging the sheet grabber must not deliver
 *      pointer events into (or scroll) the home screen beneath.
 *   5. Click-through prevention — closing the notification sheet via its
 *      backdrop must not activate the pull zone / home surface beneath.
 *   6. (touch) Rail flick home→launcher with a genuine CDP touch swipe must
 *      not ghost-launch the tile under the finger.
 *
 * Evidence: .github/issue-evidence/ui-interaction-epic/l3-gestures/.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
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
  ".github",
  "issue-evidence",
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

test("notification pull zone: pull-down opens; an upward drag's trailing click stays closed", async ({
  page,
}) => {
  await openHome(page);
  const zone = page.getByTestId("home-notification-pull-zone");
  await expect(zone).toBeVisible({ timeout: 15_000 });

  // UPWARD drag on the strip. The gesture is direction-gated (only pull-DOWN
  // opens) — but a real browser also synthesizes a click from this press,
  // which used to open the center anyway. It must stay closed. The strip hugs
  // the top of the viewport, so start at its bottom edge and pull up towards
  // y=2 (coordinates must stay inside the viewport for CDP mouse input).
  const zoneStartBox = await zone.boundingBox();
  if (!zoneStartBox) throw new Error("pull zone has no bounding box");
  const upFromX = zoneStartBox.x + zoneStartBox.width / 2;
  const upFromY = zoneStartBox.y + zoneStartBox.height - 3;
  const upToY = Math.max(2, upFromY - 26);
  await page.mouse.move(upFromX, upFromY);
  await page.mouse.down();
  for (let i = 1; i <= 6; i += 1) {
    await page.mouse.move(upFromX, upFromY + ((upToY - upFromY) * i) / 6);
    await page.waitForTimeout(15);
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect(page.getByTestId("notification-sheet")).toHaveCount(0);
  await evidenceShot(page, "pullzone-upward-drag-stays-closed");

  // Pull DOWN past the 56px distance threshold → the center opens.
  await mousePointerDrag(page, zone, 0, 90, { steps: 6, pauseMs: 15 });
  await expect(page.getByTestId("notification-sheet")).toBeVisible({
    timeout: 10_000,
  });
  await evidenceShot(page, "pullzone-pulldown-opened");

  // CLICK-THROUGH: closing via the backdrop must not activate anything on the
  // layer beneath the tap point. Click the backdrop just BELOW the sheet —
  // works on every viewport (the top-anchored sheet spans nearly the full
  // width on phones, so beside-the-sheet points don't exist there) and sits
  // over the home surface's interactive suggestion chips. If the tap leaked
  // through the backdrop, a chip would fire and spring the chat overlay open.
  const backdrop = page.getByTestId("notification-sheet-backdrop");
  await expect(backdrop).toBeVisible();
  const sheetBox = await page.getByTestId("notification-sheet").boundingBox();
  if (!sheetBox) throw new Error("notification sheet has no bounding box");
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("no viewport size");
  await page.mouse.click(
    sheetBox.x + sheetBox.width / 2,
    Math.min(viewport.height - 10, sheetBox.y + sheetBox.height + 30),
  );
  await expect(page.getByTestId("notification-sheet")).toHaveCount(0, {
    timeout: 10_000,
  });
  await page.waitForTimeout(400);
  await expect(page.getByTestId("notification-sheet")).toHaveCount(0);
  // Nothing beneath fired: the home is still resting behind a collapsed chat.
  await expect(page.getByTestId("home-screen")).toBeVisible();
  await expect(page.getByTestId("continuous-chat-overlay")).not.toHaveAttribute(
    "data-open",
    "true",
  );
  await evidenceShot(page, "backdrop-close-no-clickthrough");
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
});
