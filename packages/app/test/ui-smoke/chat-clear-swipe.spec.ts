// Full-stack e2e for the collapsed chat-grabber horizontal swipe on the REAL
// web app (desktop chromium AND the Pixel-7 mobile-chromium lane — the same
// WebView viewport that ships on Capacitor iOS/Android). Drives genuine pointer
// gestures via `page.mouse` (pointerdown → moves → pointerup) and via CDP
// `Input.dispatchTouchEvent` (real finger input), so the collapsed sheet's
// swipe/axis-lock runs end to end.
//
// Scope (post-#13531 single infinite thread): the grabber swipe at rest steps
// the home↔launcher rail — a LEFT swipe reveals the launcher, a RIGHT swipe
// returns home — WITHOUT opening the chat sheet. The pre-#13531 behaviors this
// file used to cover — swipe-BETWEEN-conversations on the open thread and a
// Clear/new-chat header control — were removed with the single infinite thread
// (the thread never resets and `swipeEnabled` is gated to `!sheetOpen`), so no
// conversation-swipe or `chat-full-clear` leg remains here. The new
// maximize/restore gestures live in chat-thread-gestures.spec.ts.
//
// The conversation list / messages are mocked statefully at the network layer
// for determinism. Record a video with E2E_RECORD=1.

import { expect, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const NOW = Date.now();
const SEED = [
  { id: "conv-standup", title: "Today's standup", roomId: "room-standup" },
  { id: "conv-billing", title: "Billing thread", roomId: "room-billing" },
  { id: "conv-deploy", title: "Deploy notes", roomId: "room-deploy" },
];
type Msg = { id: string; role: string; text: string; timestamp: number };
const SEED_MESSAGES: Record<string, Msg[]> = {
  "conv-standup": [
    {
      id: "s1",
      role: "assistant",
      text: "STANDUP: what is blocking you today?",
      timestamp: NOW - 50_000,
    },
    {
      id: "s2",
      role: "user",
      text: "nothing major, shipping the chat-ux work",
      timestamp: NOW - 49_000,
    },
  ],
};

type ConvRecord = {
  id: string;
  title: string;
  roomId: string;
  createdAt: string;
  updatedAt: string;
};

/** A stateful, in-memory conversation store mirroring the server contract. */
function makeStore() {
  const convos: ConvRecord[] = SEED.map((c, i) => {
    const ts = new Date(NOW - i * 1000).toISOString();
    return { ...c, createdAt: ts, updatedAt: ts };
  });
  const messages: Record<string, Msg[]> = structuredClone(SEED_MESSAGES);
  return { convos, messages };
}

type Store = ReturnType<typeof makeStore>;

async function installConversationStore(
  page: import("@playwright/test").Page,
  store: Store,
) {
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversations: store.convos }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/conversations/*/messages", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    const id = url.pathname.split("/").slice(-2, -1)[0];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ messages: store.messages[id] ?? [] }),
    });
  });

  await page.route("**/api/conversations/*/greeting**", async (route) => {
    if (!["GET", "POST"].includes(route.request().method())) {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    const id = url.pathname.split("/").slice(-2, -1)[0];
    const text = store.messages[id]?.[0]?.text ?? "Hi — how can I help?";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text }),
    });
  });
}

/** Drive a real pointer drag from a locator's centre by (dx, dy) over N steps. */
async function pointerDrag(
  page: import("@playwright/test").Page,
  selector: string,
  dx: number,
  dy: number,
  steps = 12,
) {
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

/**
 * Drive a REAL touch drag via CDP `Input.dispatchTouchEvent` — the same touch
 * input `page.touchscreen` uses. Unlike `pointerDrag` above (`page.mouse` →
 * pointerType "mouse"), this produces genuine touch input (pointerType "touch"),
 * so the gesture is verified the way a finger drives it, not a desktop mouse
 * (issue #9943 item 6: "swipe gesture simulated via page.mouse, not real touch").
 */
async function touchDrag(
  page: import("@playwright/test").Page,
  selector: string,
  dx: number,
  dy: number,
  steps = 12,
) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: cx, y: cy }],
    });
    for (let i = 1; i <= steps; i += 1) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: cx + (dx * i) / steps, y: cy + (dy * i) / steps }],
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

let store: Store;

test.beforeEach(async ({ page }) => {
  store = makeStore();
  installPageDiagnosticsGuard(page);
  // Skip the first-run tour so its spotlight never covers the chat.
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
  await installConversationStore(page, store);
});

test("collapsed chat grabber horizontal swipe opens the launcher rail without opening chat", async ({
  page,
}, testInfo) => {
  await openAppPath(page, "/chat");
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });

  const surface = page.getByTestId("home-launcher-surface");
  await expect(surface).toHaveAttribute("data-page", "home", {
    timeout: 15_000,
  });
  await expect(overlay).not.toHaveAttribute("data-open", "true");

  await pointerDrag(page, '[data-testid="chat-sheet-grabber"]', -180, -6, 12);

  await expect(surface).toHaveAttribute("data-page", "launcher", {
    timeout: 10_000,
  });
  await expect(overlay).not.toHaveAttribute("data-open", "true");
  await expect(page.getByTestId("home-launcher-launcher-page")).toBeVisible();
  await expectNoPageDiagnostics(page, testInfo.title);
});

test.describe("real touch input (CDP dispatchTouchEvent) — #9943 item 6", () => {
  test.use({ hasTouch: true });

  test("collapsed chat grabber swipe under REAL TOUCH (not desktop mouse) opens the launcher rail", async ({
    page,
  }, testInfo) => {
    await openAppPath(page, "/chat");
    const overlay = page.getByTestId("continuous-chat-overlay");
    await expect(overlay).toBeVisible({ timeout: 60_000 });

    const surface = page.getByTestId("home-launcher-surface");
    await expect(surface).toHaveAttribute("data-page", "home", {
      timeout: 15_000,
    });
    await expect(overlay).not.toHaveAttribute("data-open", "true");

    // Genuine finger swipe (touch input), not page.mouse.
    await touchDrag(page, '[data-testid="chat-sheet-grabber"]', -180, -6, 12);

    await expect(surface).toHaveAttribute("data-page", "launcher", {
      timeout: 10_000,
    });
    await expect(overlay).not.toHaveAttribute("data-open", "true");
    await expect(page.getByTestId("home-launcher-launcher-page")).toBeVisible();
    await expectNoPageDiagnostics(page, testInfo.title);
  });
});

test("single-thread open thread: header search + new-chat controls exist, but no swipe-between-conversations", async ({
  page,
}, testInfo) => {
  await openAppPath(page, "/chat");
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });

  // Open the sheet: flick the grabber UP (≥ distance threshold → onPullUp).
  await pointerDrag(page, '[data-testid="chat-sheet-grabber"]', 0, -220, 8);
  await expect(overlay).toHaveAttribute("data-open", "true", {
    timeout: 15_000,
  });

  const sheet = page.getByTestId("chat-sheet");
  const thread = page.locator("#continuous-thread");
  await expect(thread).toContainText("STANDUP", { timeout: 15_000 });
  const convBefore = await sheet.getAttribute("data-conversation-id");

  // Chat history UX (#14279): the header exposes a quiet search entry point and
  // a non-destructive new-chat control (the latter re-added after #13531 per
  // Shadow's ask). Opening the sheet to half+ reveals the header cluster.
  await expect(page.getByTestId("chat-full-search")).toHaveCount(1);
  await expect(page.getByTestId("chat-full-clear")).toHaveCount(1);

  // A horizontal drag across the OPEN thread must NOT switch conversations —
  // swipe-between-chats was removed with the single infinite thread
  // (`swipeEnabled: !sheetOpen`). The active conversation id is unchanged.
  await pointerDrag(page, "#continuous-thread", -180, 0, 12);
  await page.waitForTimeout(500);
  await expect(overlay).toHaveAttribute("data-open", "true");
  await expect(sheet).toHaveAttribute("data-conversation-id", convBefore ?? "");
  await expect(thread).toContainText("STANDUP");
  await expectNoPageDiagnostics(page, testInfo.title);
});
