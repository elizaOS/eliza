// Cross-window (same-origin) active-conversation sync — the REAL shipped
// behavior. `packages/ui/src/state/useTabSync.ts` broadcasts the active
// conversation (and a small set of UI prefs) over the `elizaos-tab-sync`
// BroadcastChannel, and AppContext applies inbound changes with echo
// suppression. Two windows of the same app must therefore follow each other's
// conversation switches without any reload or server round-trip.
//
// This spec drives it end-to-end: two pages in the SAME browser context (same
// origin → shared BroadcastChannel), each with its own conversation-store
// mocks (the sync itself is purely client-side). Swiping window A to another
// conversation must repaint window B's thread with that conversation — and
// the follow must be bidirectional without echo loops.

import { type Page, expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
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
  ],
  "conv-billing": [
    {
      id: "b1",
      role: "assistant",
      text: "BILLING: your October invoice total is $420.",
      timestamp: NOW - 40_000,
    },
  ],
  "conv-deploy": [
    {
      id: "d1",
      role: "assistant",
      text: "DEPLOY: provisioning worker is live.",
      timestamp: NOW - 30_000,
    },
  ],
};

/** Install a deterministic read-only conversation store on one window. */
async function installConversationStore(page: Page): Promise<void> {
  const convos = SEED.map((c, i) => {
    const ts = new Date(NOW - i * 1000).toISOString();
    return { ...c, createdAt: ts, updatedAt: ts };
  });

  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ conversations: convos }),
    });
  });

  await page.route("**/api/conversations/cleanup-empty", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ deleted: [] }),
    });
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
      body: JSON.stringify({ messages: SEED_MESSAGES[id] ?? [] }),
    });
  });

  await page.route("**/api/conversations/*/greeting**", async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/").slice(-2, -1)[0];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        text: SEED_MESSAGES[id]?.[0]?.text ?? "Hi — how can I help?",
      }),
    });
  });
}

/** Drive a real pointer drag from a locator's centre by (dx, dy) over N steps. */
async function pointerDrag(
  page: Page,
  selector: string,
  dx: number,
  dy: number,
  steps = 12,
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

async function openSyncedWindow(page: Page): Promise<void> {
  // Skip the first-run tour so its spotlight never covers the chat.
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
  await installConversationStore(page);
  await openAppPath(page, "/chat");
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });
  // Open the sheet (flick the grabber up) so the thread is painted.
  await pointerDrag(page, '[data-testid="chat-sheet-grabber"]', 0, -220, 8);
  await expect(overlay).toHaveAttribute("data-open", "true", {
    timeout: 15_000,
  });
  // The most-recent seeded conversation (standup) is active first.
  await expect(page.locator("#continuous-thread")).toContainText("STANDUP", {
    timeout: 15_000,
  });
}

test("switching conversations in window A follows in window B (and back) via BroadcastChannel", async ({
  context,
  page,
}) => {
  // Two windows = two pages in the SAME context so they share the same-origin
  // BroadcastChannel that useTabSync subscribes to.
  const windowA = page;
  const windowB = await context.newPage();
  await openSyncedWindow(windowA);
  await openSyncedWindow(windowB);

  const threadA = windowA.locator("#continuous-thread");
  const threadB = windowB.locator("#continuous-thread");

  // A: swipe LEFT → the next (older) conversation (standup → billing).
  await pointerDrag(windowA, "#continuous-thread", -160, 0, 12);
  await expect(threadA).toContainText("BILLING", { timeout: 15_000 });

  // B follows A's switch with NO interaction on B — pure cross-window sync.
  await expect(threadB).toContainText("BILLING", { timeout: 10_000 });

  // No echo loop: A must still be on billing after B applied the change.
  await expect(threadA).toContainText("BILLING");

  // And the sync is bidirectional: B swipes on (billing → deploy), A follows.
  await pointerDrag(windowB, "#continuous-thread", -160, 0, 12);
  await expect(threadB).toContainText("DEPLOY", { timeout: 15_000 });
  await expect(threadA).toContainText("DEPLOY", { timeout: 10_000 });

  await windowB.close();
});
