// Full-stack e2e for the continuous-chat overlay's clear + swipe behavior on the
// REAL web app (runs on desktop chromium AND the Pixel-7 mobile-chromium lane —
// the same WebView viewport that ships on Capacitor iOS/Android). Drives genuine
// pointer gestures via the mouse (pointerdown → moves → pointerup), so the
// overlay's real swipe/axis-lock runs end-to-end, and exercises three iOS-build
// bug fixes:
//
//   1. Clearing a conversation shows NO "conversation cleared / undo" toast.
//   2. Clearing lands on a fresh greeted chat (the regression where the new
//      conversation was created server-side but never activated, leaving an
//      empty collapsed sheet — root cause: the create epoch guard always fired).
//   3. Swiping left/right navigates between conversations, and clearing an empty
//      draft REPLACES it (a DELETE is issued) instead of piling up orphans.
//
// The conversation lifecycle (list / messages / create+greeting / delete /
// cleanup) is mocked statefully at the network layer for determinism. Record a
// video with E2E_RECORD=1.

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
  "conv-billing": [
    {
      id: "b1",
      role: "user",
      text: "what is my October invoice?",
      timestamp: NOW - 40_000,
    },
    {
      id: "b2",
      role: "assistant",
      text: "BILLING: your October invoice total is $420.",
      timestamp: NOW - 39_000,
    },
  ],
  "conv-deploy": [
    {
      id: "d1",
      role: "user",
      text: "deploy the worker please",
      timestamp: NOW - 30_000,
    },
    {
      id: "d2",
      role: "assistant",
      text: "DEPLOY: provisioning worker is live.",
      timestamp: NOW - 29_000,
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
  return {
    convos,
    messages,
    created: [] as string[],
    deleted: [] as string[],
    cleanupCalls: 0,
  };
}

type Store = ReturnType<typeof makeStore>;

async function installConversationStore(
  page: import("@playwright/test").Page,
  store: Store,
) {
  // GET list / POST create (exact path — no trailing segment).
  await page.route("**/api/conversations", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversations: store.convos }),
      });
      return;
    }
    if (method === "POST") {
      const n = store.created.length + 1;
      const id = `conv-fresh-${n}`;
      const ts = new Date(NOW + n * 1000).toISOString();
      const record: ConvRecord = {
        id,
        title: "New chat",
        roomId: `room-fresh-${n}`,
        createdAt: ts,
        updatedAt: ts,
      };
      const greetingText = `FRESH START ${n} — how can I help?`;
      store.convos.unshift(record);
      store.messages[id] = [
        {
          id: `g-${id}`,
          role: "assistant",
          text: greetingText,
          timestamp: NOW + n * 1000,
        },
      ];
      store.created.push(id);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversation: record,
          greeting: { text: greetingText },
        }),
      });
      return;
    }
    await route.fallback();
  });

  // POST cleanup-empty — registered before the id-level handler so it wins for
  // this exact path (the single-segment id glob would otherwise match it). The
  // client prunes its own empty drafts, so the server reports nothing extra.
  await page.route("**/api/conversations/cleanup-empty", async (route) => {
    store.cleanupCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ deleted: [] }),
    });
  });

  // GET messages for a conversation.
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

  // Greeting fallback (used when the inline greeting is absent).
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

  // DELETE / PATCH a single conversation by id (single path segment — does NOT
  // match the /messages or /greeting sub-paths).
  await page.route("**/api/conversations/*", async (route) => {
    const method = route.request().method();
    const url = new URL(route.request().url());
    const id = url.pathname.split("/").pop() ?? "";
    if (method === "DELETE") {
      store.deleted.push(id);
      store.convos = store.convos.filter((c) => c.id !== id);
      delete store.messages[id];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
      return;
    }
    if (method === "PATCH") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
      return;
    }
    await route.fallback();
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
  await expect(
    page.getByTestId("home-launcher-launcher-page"),
  ).toBeVisible();
  await expectNoPageDiagnostics(page, testInfo.title);
});

test("swipe navigates conversations; clear lands on a fresh greeted chat with no undo toast", async ({
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

  const thread = page.locator("#continuous-thread");
  // Brief dwells make each step legible in the recorded video.
  const dwell = () => page.waitForTimeout(700);
  // The most-recent conversation (standup) is active first.
  await expect(thread).toContainText("STANDUP", { timeout: 15_000 });
  await dwell();

  // Swipe LEFT → next (older) conversation (standup → billing).
  await pointerDrag(page, "#continuous-thread", -160, 0, 12);
  await expect(thread).toContainText("BILLING", { timeout: 15_000 });
  await dwell();

  // Swipe LEFT again → deploy.
  await pointerDrag(page, "#continuous-thread", -160, 0, 12);
  await expect(thread).toContainText("DEPLOY", { timeout: 15_000 });
  await dwell();

  // Swipe RIGHT → previous (newer) conversation (deploy → billing).
  await pointerDrag(page, "#continuous-thread", 160, 0, 12);
  await expect(thread).toContainText("BILLING", { timeout: 15_000 });
  await dwell();

  // Expand to FULL so the clear control is in the header, then clear.
  await pointerDrag(page, '[data-testid="chat-sheet-grabber"]', 0, -400, 8);
  const clear = page.getByTestId("chat-full-clear");
  await expect(clear).toBeVisible({ timeout: 15_000 });
  await clear.click();

  // BUG 2 FIX: clearing creates AND activates a fresh greeted conversation — the
  // thread now shows the new greeting, not the old billing messages, not an empty
  // collapsed sheet. (Before the epoch-guard fix, handleNewConversation
  // early-returned, so the new conversation was orphaned and never shown.)
  await expect(thread).toContainText("FRESH START 1", { timeout: 15_000 });
  await expect(thread).not.toContainText("BILLING");
  await dwell();

  // BUG 1 FIX: NO "conversation cleared / undo" toast is ever shown.
  await expect(page.getByTestId("conversation-undo-toast")).toHaveCount(0);
  expect(store.created.length).toBe(1);

  // BUG 3 FIX (kept): clearing a NON-empty conversation keeps it — billing was
  // not deleted and stays swipe-reachable. The fresh chat sits at index 0, so
  // swipe LEFT twice (fresh → standup → billing) returns to it.
  expect(store.deleted).not.toContain("conv-billing");
  await pointerDrag(page, "#continuous-thread", -160, 0, 12);
  await expect(thread).toContainText("STANDUP", { timeout: 15_000 });
  await dwell();
  await pointerDrag(page, "#continuous-thread", -160, 0, 12);
  await expect(thread).toContainText("BILLING", { timeout: 15_000 });
  await dwell();
  await expectNoPageDiagnostics(page, testInfo.title);
});

test("clearing an empty draft replaces it instead of piling up orphan conversations", async ({
  page,
}, testInfo) => {
  await openAppPath(page, "/chat");
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });
  await pointerDrag(page, '[data-testid="chat-sheet-grabber"]', 0, -400, 8);

  const thread = page.locator("#continuous-thread");
  const clear = page.getByTestId("chat-full-clear");

  // First clear (from the seeded standup conversation) → fresh-1 (greeting only,
  // an empty draft).
  await expect(clear).toBeVisible({ timeout: 15_000 });
  await clear.click();
  await expect(thread).toContainText("FRESH START 1", { timeout: 15_000 });
  expect(store.created).toEqual(["conv-fresh-1"]);
  expect(store.deleted).not.toContain("conv-fresh-1");

  // Clear AGAIN from the empty fresh-1 draft → fresh-2 is created and fresh-1 is
  // DELETED (replaced), so empty drafts never accumulate.
  await expect(clear).toBeVisible({ timeout: 15_000 });
  await clear.click();
  await expect(thread).toContainText("FRESH START 2", { timeout: 15_000 });
  await expect
    .poll(() => store.deleted.includes("conv-fresh-1"), { timeout: 15_000 })
    .toBe(true);
  // No undo toast on this path either.
  await expect(page.getByTestId("conversation-undo-toast")).toHaveCount(0);
  await expectNoPageDiagnostics(page, testInfo.title);
});

test("clearing activates a fast, greeting-less conversation and backfills the greeting (no frozen spinner)", async ({
  page,
}, testInfo) => {
  // Device-like create: the conversation record comes back WITHOUT an inline
  // greeting (the client no longer asks the create to bootstrap one — that work
  // is model-bound and on the single-threaded on-device agent it would block
  // the create for many seconds, freezing the new chat behind the loading
  // spinner). The create is intentionally delayed to mimic that queueing; the
  // greeting then arrives via the separate /greeting endpoint. The fresh chat
  // must activate and the greeting must backfill — never hang on a spinner.
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const n = store.created.length + 1;
    const id = `conv-fresh-${n}`;
    const ts = new Date(NOW + n * 1000).toISOString();
    const record: ConvRecord = {
      id,
      title: "New chat",
      roomId: `room-fresh-${n}`,
      createdAt: ts,
      updatedAt: ts,
    };
    store.convos.unshift(record);
    // The greeting is registered for the /greeting endpoint, NOT returned inline.
    store.messages[id] = [
      {
        id: `g-${id}`,
        role: "assistant",
        text: `FRESH GREETING ${n} — how can I help?`,
        timestamp: NOW + n * 1000,
      },
    ];
    store.created.push(id);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ conversation: record }), // no `greeting` field
    });
  });

  await openAppPath(page, "/chat");
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });
  await pointerDrag(page, '[data-testid="chat-sheet-grabber"]', 0, -400, 8);

  const thread = page.locator("#continuous-thread");
  const clear = page.getByTestId("chat-full-clear");
  await expect(clear).toBeVisible({ timeout: 15_000 });
  await clear.click();

  // The greeting-less create activates the fresh conversation and the greeting
  // backfills from /greeting — the thread shows it (not the old standup, not a
  // permanently empty/spinning sheet).
  await expect(thread).toContainText("FRESH GREETING 1", { timeout: 20_000 });
  await expect(thread).not.toContainText("STANDUP");
  expect(store.created.length).toBe(1);
  // The spinner must have resolved — it is gone once the greeting is shown.
  await expect(page.getByTestId("chat-thread-loading")).toHaveCount(0);
  await expectNoPageDiagnostics(page, testInfo.title);
});
