// Full-stack e2e for the single-infinite-thread chat gestures (#13531) on the
// REAL web app — the genuinely-real ContinuousChatOverlay over the shell,
// driven with genuine pointer/touch input. Covers the gestures that REPLACED
// the removed maximize/minimize/clear header buttons and the removed
// conversation edge-swipe:
//
//   1. Over-pull-past-FULL → full-bleed MAXIMIZE (`data-maximized="true"`,
//      `data-chat-state="MAXIMIZED"`), transcript content survives the flip.
//   2. Top restore-zone pull-DOWN → back to the inset FULL overlay
//      (`data-maximized` cleared, sheet still `data-open`, thread intact).
//   3. ArrowDown on the restore zone → same restore path (WCAG 2.1.1 operable).
//   4. Escape from MAXIMIZED collapses the WHOLE sheet (not a restore) — the
//      documented back/Escape semantics.
//   5. Header contract: the live new-chat control remains present, the removed
//      maximize button stays absent, and a horizontal drag on the OPEN thread
//      does NOT switch conversations (swipe-to-switch removed;
//      `swipeEnabled: !sheetOpen`).
//
// The conversation is mocked statefully at the network layer for determinism.
// Record a video with E2E_RECORD=1.

import { expect, type Page, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const NOW = Date.now();
const CONVERSATION_ID = "conv-thread-gestures";
const ROOM_ID = "room-thread-gestures";
const FIRST_TEXT = "GESTURE THREAD: this is the oldest visible turn.";
const LAST_TEXT = "GESTURE THREAD: and this is the newest turn.";

type Msg = { id: string; role: string; text: string; timestamp: number };

function seedMessages(): Msg[] {
  const msgs: Msg[] = [
    {
      id: "g-first",
      role: "assistant",
      text: FIRST_TEXT,
      timestamp: NOW - 40_000,
    },
  ];
  // A few filler turns so the transcript has real content to survive the flip.
  for (let i = 0; i < 6; i += 1) {
    msgs.push({
      id: `g-fill-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      text: `Filler turn ${i} in the single infinite thread.`,
      timestamp: NOW - 30_000 + i * 1000,
    });
  }
  msgs.push({
    id: "g-last",
    role: "assistant",
    text: LAST_TEXT,
    timestamp: NOW - 2_000,
  });
  return msgs;
}

async function installConversationRoutes(page: Page): Promise<void> {
  const conversation = {
    id: CONVERSATION_ID,
    roomId: ROOM_ID,
    title: "Gesture thread",
    createdAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
  const messages = seedMessages();

  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversations: [conversation] }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route(`**/api/conversations/${CONVERSATION_ID}`, async (route) => {
    const method = route.request().method();
    if (method === "GET" || method === "PATCH") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversation }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route(
    `**/api/conversations/${CONVERSATION_ID}/messages**`,
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ messages }),
        });
        return;
      }
      await route.fallback();
    },
  );

  await page.route(
    `**/api/conversations/${CONVERSATION_ID}/greeting**`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ text: FIRST_TEXT, localInference: null }),
      });
    },
  );
}

const SHEET = '[data-testid="chat-sheet"]';
const GRABBER = '[data-testid="chat-sheet-grabber"]';
const RESTORE_ZONE = '[data-testid="chat-maximize-restore-zone"]';

/**
 * Drive a real pointer drag from a locator's centre by (dx, dy) over N steps.
 * Positive dy pulls DOWN, negative pulls UP.
 */
async function pointerDrag(
  page: Page,
  selector: string,
  dx: number,
  dy: number,
  steps = 16,
): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(cx + (dx * i) / steps, cy + (dy * i) / steps);
  }
  await page.mouse.up();
}

async function cdpTouchDrag(
  page: Page,
  selector: string,
  dx: number,
  dy: number,
  steps = 20,
  startXRatio = 0.5,
  startYRatio = 0.5,
): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  const cx = box.x + box.width * startXRatio;
  const cy = box.y + box.height * startYRatio;
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 1,
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: cx, y: cy }],
    });
    for (let i = 1; i <= steps; i += 1) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: cx + (dx * i) / steps, y: cy + (dy * i) / steps }],
      });
      await page.waitForTimeout(6);
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }
}

/** Drive a genuine finger drag on `selector` by (dx, dy) via CDP touch. */
async function cdpTouchDragFromGrabber(
  page: Page,
  dx: number,
  dy: number,
  steps = 26,
): Promise<void> {
  const box = await page.locator(GRABBER).first().boundingBox();
  if (!box) throw new Error("no bounding box for chat-sheet-grabber");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 1,
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: cx, y: cy }],
    });
    for (let i = 1; i <= steps; i += 1) {
      const y = Math.max(1, cy + (dy * i) / steps);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: cx + (dx * i) / steps, y }],
      });
      await page.waitForTimeout(6);
    }
    // Hold at the top so the RAF-coalesced drag samples the peak travel before
    // release commits the maximize decision.
    await page.waitForTimeout(80);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }
}

/**
 * Over-pull the grabber past the FULL detent to full-bleed. The peak raw upward
 * travel (`maxPullRawRef = baseH + offset`) must clear the maximize threshold
 * (`max(viewportH*0.8, openH) + MAXIMIZE_OVERPULL_PX`). From the collapsed INPUT
 * state `baseH=0`, so the offset alone would have to exceed ~80% of the viewport
 * — but the grabber rests too high for a single drag to travel that far. Opening
 * to HALF first sets `baseH=halfH`, so a full-height over-pull from the HALF
 * grabber clears the threshold with margin. A pilled drag can't be used — it
 * maps to the pill→input morph and never advances the maximize tracker. Retries
 * a couple of times in case the first release only lands at FULL.
 */
async function overPullToMaximize(page: Page): Promise<void> {
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });
  const sheet = page.locator(SHEET);
  const viewport = page.viewportSize();
  const dy = -(viewport?.height ?? 812);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (
      (await sheet.getAttribute("data-maximized").catch(() => null)) === "true"
    ) {
      return;
    }
    // Open to the HALF detent first so `baseH` is non-zero (the over-pull from
    // INPUT alone can't travel far enough to clear the ~80%-viewport threshold).
    if (
      (await overlay.getAttribute("data-open").catch(() => null)) !== "true"
    ) {
      await page.getByTestId("chat-sheet-grabber").click();
      await expect(overlay).toHaveAttribute("data-open", "true", {
        timeout: 10_000,
      });
    }
    // One big over-pull from the (now higher) HALF grabber to the top.
    await cdpTouchDragFromGrabber(page, 0, dy);
    await page.waitForTimeout(300);
  }
  await expect(sheet).toHaveAttribute("data-maximized", "true", {
    timeout: 5_000,
  });
}

async function openSheetToFull(page: Page): Promise<void> {
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });
  // Focus the composer to open, then flick the grabber up to FULL.
  await page.getByTestId("chat-sheet-grabber").click();
  await expect(overlay).toHaveAttribute("data-open", "true", {
    timeout: 15_000,
  });
  await pointerDrag(page, GRABBER, 0, -400, 12);
  await expect(page.getByText(LAST_TEXT)).toBeVisible({ timeout: 15_000 });
}

// A mobile (Pixel-7-like) viewport: the pull-to-maximize / restore-zone gestures
// are the shipped mobile touch surface, and the smaller viewport keeps the
// grabber's upward travel comfortably past the ~80%-viewport maximize threshold.
test.use({ viewport: { width: 393, height: 812 }, hasTouch: true });

test.beforeEach(async ({ page }) => {
  installPageDiagnosticsGuard(page);
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
  await installConversationRoutes(page);
});

test("over-pull past FULL maximizes to full-bleed and the transcript content survives", async ({
  page,
}, testInfo) => {
  await openAppPath(page, "/chat");
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });
  const sheet = page.locator(SHEET);

  // Not maximized at rest, and the restore zone only mounts once maximized.
  await expect(sheet).not.toHaveAttribute("data-maximized", "true");
  await expect(page.locator(RESTORE_ZONE)).toHaveCount(0);

  await overPullToMaximize(page);

  await expect(sheet).toHaveAttribute("data-maximized", "true", {
    timeout: 10_000,
  });
  await expect(sheet).toHaveAttribute("data-chat-state", "MAXIMIZED");
  // Content is intact through the flip — the thread never resets (#13531).
  await expect(page.getByText(LAST_TEXT)).toBeVisible({ timeout: 15_000 });
  // The restore zone is now mounted.
  await expect(page.locator(RESTORE_ZONE)).toHaveCount(1);
  await expectNoPageDiagnostics(page, testInfo.title);
});

test("a downward pull in the top restore zone exits full-bleed back to the inset overlay (not a full collapse)", async ({
  page,
}, testInfo) => {
  await openAppPath(page, "/chat");
  const sheet = page.locator(SHEET);

  await overPullToMaximize(page);
  await expect(sheet).toHaveAttribute("data-maximized", "true", {
    timeout: 10_000,
  });

  // Pull DOWN starting inside the top restore zone.
  await pointerDrag(page, RESTORE_ZONE, 0, 260, 14);

  // Back to the inset overlay: no longer maximized, but the sheet stays OPEN
  // (it did NOT collapse to the input) and the thread is intact.
  await expect(sheet).not.toHaveAttribute("data-maximized", "true", {
    timeout: 10_000,
  });
  await expect(page.getByTestId("continuous-chat-overlay")).toHaveAttribute(
    "data-open",
    "true",
  );
  await expect(page.getByText(LAST_TEXT)).toBeVisible();
  await expectNoPageDiagnostics(page, testInfo.title);
});

test("ArrowDown on the restore zone exits full-bleed (keyboard-operable restore)", async ({
  page,
}, testInfo) => {
  await openAppPath(page, "/chat");
  const sheet = page.locator(SHEET);

  await overPullToMaximize(page);
  await expect(sheet).toHaveAttribute("data-maximized", "true", {
    timeout: 10_000,
  });

  const zone = page.locator(RESTORE_ZONE);
  await zone.focus();
  await zone.press("ArrowDown");

  await expect(sheet).not.toHaveAttribute("data-maximized", "true", {
    timeout: 10_000,
  });
  await expect(page.getByTestId("continuous-chat-overlay")).toHaveAttribute(
    "data-open",
    "true",
  );
  await expectNoPageDiagnostics(page, testInfo.title);
});

test("Escape from maximized collapses the whole sheet (not just restore)", async ({
  page,
}, testInfo) => {
  await openAppPath(page, "/chat");
  const sheet = page.locator(SHEET);
  const overlay = page.getByTestId("continuous-chat-overlay");

  await overPullToMaximize(page);
  await expect(sheet).toHaveAttribute("data-maximized", "true", {
    timeout: 10_000,
  });

  await page.keyboard.press("Escape");

  // Escape from MAXIMIZED fully collapses the sheet — it is no longer maximized
  // AND no longer open (distinct from the restore-zone paths above).
  await expect(sheet).not.toHaveAttribute("data-maximized", "true", {
    timeout: 10_000,
  });
  await expect(overlay).not.toHaveAttribute("data-open", "true", {
    timeout: 10_000,
  });
  await expectNoPageDiagnostics(page, testInfo.title);
});

test("header controls: new-chat exists, maximize is removed, and open-thread swipe does not switch", async ({
  page,
}, testInfo) => {
  await openAppPath(page, "/chat");
  await openSheetToFull(page);
  const sheet = page.locator(SHEET);

  // The new-chat control was restored after #13531; only the maximize button is
  // genuinely removed because over-pull owns full-bleed maximize.
  await expect(page.getByTestId("chat-full-clear")).toHaveCount(1);
  await expect(page.getByTestId("chat-full-maximize")).toHaveCount(0);

  // A horizontal drag across the OPEN thread must NOT switch conversations —
  // swipe-between-chats was removed (`swipeEnabled: !sheetOpen`).
  const convBefore = await sheet.getAttribute("data-conversation-id");
  await cdpTouchDrag(page, "#continuous-thread", -200, 0, 14, 0.9, 0.35);
  await page.waitForTimeout(500);
  await expect(sheet).toHaveAttribute("data-conversation-id", convBefore ?? "");
  await expect(page.getByText(LAST_TEXT)).toBeVisible();
  await expect(page.getByTestId("continuous-chat-overlay")).toHaveAttribute(
    "data-open",
    "true",
  );
  await expectNoPageDiagnostics(page, testInfo.title);
});
