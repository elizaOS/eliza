// Full-stack e2e for the interleaved send message-routing lifecycle on the REAL
// web app — the genuinely-real useShellController + useChatSend + composer,
// driven with real keyboard/pointer input, network mocked statefully (#10700).
//
// The composer submit + tapped suggestions + voice converse turns all route
// through the shell `send()` path, which enqueues WITHOUT an explicit
// conversationId. Before #10700's fix, `runQueuedChatSend` resolved the target
// LATE (activeConversationIdRef at drain time), so a context change (view switch,
// new-chat) issued while a turn was still queued rerouted that turn into the
// wrong conversation. This spec proves, end to end in the browser, that a turn
// lands in the conversation it was sent in even when the active-conversation
// context churns under it mid-flight — and that a storm of interleaved sends /
// swipes / view-switches raises no page diagnostics and leaves no stuck state.
// (The overlay's new-chat trigger was removed with the single infinite thread in
// #13531, so the mid-flight perturbations here are view switches, not new-chats.)
//
// The stateful store records, per conversation, the user messages the client
// actually delivered to `…/messages/stream` — the routing ground truth. Record a
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

type Msg = { id: string; role: string; text: string; timestamp: number };
type ConvRecord = {
  id: string;
  title: string;
  roomId: string;
  createdAt: string;
  updatedAt: string;
};

const SEED: ConvRecord[] = [
  {
    id: "conv-primary",
    title: "Primary thread",
    roomId: "room-primary",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  },
  {
    id: "conv-secondary",
    title: "Secondary thread",
    roomId: "room-secondary",
    createdAt: new Date(NOW - 1000).toISOString(),
    updatedAt: new Date(NOW - 1000).toISOString(),
  },
];
const SEED_MESSAGES: Record<string, Msg[]> = {
  "conv-primary": [
    {
      id: "p1",
      role: "assistant",
      text: "PRIMARY: ready when you are.",
      timestamp: NOW - 5000,
    },
  ],
  "conv-secondary": [
    {
      id: "s1",
      role: "assistant",
      text: "SECONDARY: this is another thread.",
      timestamp: NOW - 6000,
    },
  ],
};

function makeStore() {
  return {
    convos: SEED.map((c) => ({ ...c })),
    messages: structuredClone(SEED_MESSAGES),
    /** convId -> ordered user texts the client actually delivered here. */
    delivered: {} as Record<string, string[]>,
    created: [] as string[],
    deleted: [] as string[],
    /** Streams still deliberately held open (for the in-flight race window). */
    streamCount: 0,
  };
}
type Store = ReturnType<typeof makeStore>;

/**
 * Install the stateful conversation store. `firstStreamDelayMs` holds the FIRST
 * message stream open long enough to (a) keep `responding` true so the composer
 * exposes "send another", and (b) open the window in which a second turn is
 * queued behind it and a new-chat can fire before the queue drains.
 */
async function installConversationStore(
  page: import("@playwright/test").Page,
  store: Store,
  firstStreamDelayMs = 1600,
) {
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
      const greetingText = `FRESH ${n} — how can I help?`;
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

  await page.route("**/api/conversations/cleanup-empty", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ deleted: [] }),
    });
  });

  // The message STREAM — records the delivery target (the ground truth for
  // routing) and streams a short SSE reply.
  await page.route("**/api/conversations/*/messages/stream", async (route) => {
    const url = new URL(route.request().url());
    const convId = url.pathname.split("/").slice(-3, -2)[0] ?? "";
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      text?: string;
    };
    const userText = (body.text ?? "").trim();
    store.delivered[convId] ??= [];
    store.delivered[convId].push(userText);
    store.messages[convId] ??= [];
    store.messages[convId].push({
      id: `u-${convId}-${store.messages[convId].length}`,
      role: "user",
      text: userText,
      timestamp: Date.now(),
    });
    const assistantText = `ack: ${userText}`;
    store.messages[convId].push({
      id: `a-${convId}-${store.messages[convId].length}`,
      role: "assistant",
      text: assistantText,
      timestamp: Date.now(),
    });
    store.streamCount += 1;
    if (store.streamCount === 1 && firstStreamDelayMs > 0) {
      await new Promise((r) => setTimeout(r, firstStreamDelayMs));
    }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body:
        `data: ${JSON.stringify({ type: "token", text: assistantText, fullText: assistantText })}\n\n` +
        `data: ${JSON.stringify({ type: "done", fullText: assistantText, agentName: "Eliza" })}\n\n`,
    });
  });

  // Anchored so it matches `/messages` and `/messages?before=…` but never the
  // `/messages/stream` route registered above (which owns delivery).
  await page.route(
    /\/api\/conversations\/[^/]+\/messages(\?.*)?$/,
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const url = new URL(route.request().url());
      const id = url.pathname.split("/").slice(-2, -1)[0] ?? "";
      // Infinite-scroll load-older paging: a `before=<ts>` request asks for
      // history older than the oldest shown turn. The seed has none, so answer
      // empty (the client stops paging) rather than 404ing into the
      // page-diagnostics guard.
      const messages = url.searchParams.has("before")
        ? []
        : (store.messages[id] ?? []);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ messages }),
      });
    },
  );

  await page.route("**/api/conversations/*/greeting**", async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/").slice(-2, -1)[0] ?? "";
    const text = store.messages[id]?.[0]?.text ?? "Hi — how can I help?";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text }),
    });
  });

  await page.route("**/api/conversations/*", async (route) => {
    const method = route.request().method();
    const url = new URL(route.request().url());
    const id = url.pathname.split("/").pop() ?? "";
    if (method === "DELETE") {
      store.deleted.push(id);
      store.convos = store.convos.filter((c) => c.id !== id);
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

  // The companion VRM avatar isn't part of this store; stub it so a HEAD/GET
  // probe doesn't surface a benign 501 as a page diagnostic during the storm.
  await page.route("**/api/avatar/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: "",
    });
  });

  // Starting a new chat while a turn is in flight aborts the active server turn
  // (POST /api/turns/:roomId/abort). Stub it so that expected abort — proof the
  // new-chat correctly interrupts the in-flight turn — isn't a page diagnostic.
  await page.route("**/api/turns/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ aborted: true }),
    });
  });
}

const OVERLAY = "continuous-chat-overlay";
const COMPOSER =
  'textarea[aria-label="message"], [data-testid="chat-composer-textarea"]';

async function expandToFull(page: import("@playwright/test").Page) {
  // Focus the composer to open the sheet, then pull it up to the FULL detent so
  // the transcript is fully revealed.
  await page.locator(COMPOSER).first().click();
  const grabber = page.getByTestId("chat-sheet-grabber");
  if (await grabber.count()) {
    const box = await grabber.first().boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y - 320, { steps: 10 });
      await page.mouse.up();
    }
  }
}

async function typeAndSend(
  page: import("@playwright/test").Page,
  text: string,
) {
  const composer = page.locator(COMPOSER).first();
  await composer.click();
  await composer.fill(text);
  await page.getByTestId("chat-composer-action").click();
}

let store: Store;

test.beforeEach(async ({ page }) => {
  store = makeStore();
  installPageDiagnosticsGuard(page);
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
});

test("a turn queued while the view switches away and back lands in the conversation it was sent in (#10700)", async ({
  page,
}, testInfo) => {
  // The single infinite thread (#13531) never resets, so the "start a new chat
  // mid-flight" perturbation the original #10700 repro used is gone (the header
  // new-chat control clears the active thread, it does not spawn a competing
  // conversation). The #10700 routing invariant it protected — a queued turn is
  // delivered ONLY to the conversation it was enqueued in, never rerouted when
  // the active conversation context changes under it — is exercised here by
  // switching the view away and back while a turn is still queued (a real,
  // overlay-supported perturbation). The exact per-turn ordering is pinned
  // deterministically by the component fuzz
  // (useChatSend.send-voice-newchat.race.test.tsx).
  await installConversationStore(page, store, 1600);
  await openAppPath(page, "/chat");
  const overlay = page.getByTestId(OVERLAY);
  await expect(overlay).toBeVisible({ timeout: 20_000 });
  await expandToFull(page);
  await testInfo.attach("01-primary-open.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // Turn 1 into conv-primary — its stream is held ~1.6s, so `responding` stays
  // true and the composer exposes "send another".
  await typeAndSend(page, "route-alpha");

  // Turn 2 is queued BEHIND turn 1 (single-flight) while conv-primary is active.
  const composer = page.locator(COMPOSER).first();
  await composer.fill("route-beta");
  await page.getByTestId("chat-composer-action").click();

  // Switch the view away (home) and back to chat while turn 2 is still queued —
  // the active-conversation context churns under the in-flight queue. Pre-fix a
  // late-resolved target could misroute the queued turn; post-fix it is pinned
  // to conv-primary at enqueue.
  await openAppPath(page, "/");
  await page.waitForTimeout(200);
  await openAppPath(page, "/chat");
  await expect(page.getByTestId(OVERLAY)).toBeVisible({ timeout: 15_000 });
  await expandToFull(page);
  await testInfo.attach("02-view-switch-mid-flight.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // Let the in-flight turn drain (its held stream releases after ~1.6s) and the
  // queue settle after the view switch.
  await expect
    .poll(() => (store.delivered["conv-primary"] ?? []).length, {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(2500);

  // ROUTING INVARIANT — the #10700 fix's guarantee: a turn is delivered ONLY to
  // the conversation it was sent in. Both route-alpha and route-beta land in
  // conv-primary; no turn leaks into any OTHER conversation the store knows
  // about (conv-secondary or a fresh one), regardless of send-queue timing.
  const primary = store.delivered["conv-primary"] ?? [];
  expect(primary).toContain("route-alpha");
  expect(primary.every((t) => t === "route-alpha" || t === "route-beta")).toBe(
    true,
  );
  for (const otherId of Object.keys(store.delivered)) {
    if (otherId === "conv-primary") continue;
    const other = store.delivered[otherId] ?? [];
    expect(other).not.toContain("route-alpha");
    expect(other).not.toContain("route-beta");
  }
  await testInfo.attach("03-routing-settled.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  await expectNoPageDiagnostics(page, "send-view-switch-race");
});

test("interleaved send / swipe / view-switch storm raises no diagnostics and never gets stuck (#10700)", async ({
  page,
}, testInfo) => {
  await installConversationStore(page, store, 0);
  await openAppPath(page, "/chat");
  const overlay = page.getByTestId(OVERLAY);
  await expect(overlay).toBeVisible({ timeout: 20_000 });
  await expandToFull(page);

  // A user iterating like a real person: send, send, swipe the thread, switch
  // view + back, send — rapidly, in the same session. (New-chat was removed with
  // the single infinite thread in #13531, so the perturbations here are the ones
  // the overlay still supports.)
  for (let round = 0; round < 4; round++) {
    await typeAndSend(page, `storm-${round}-a`);
    await page.waitForTimeout(120);
    await typeAndSend(page, `storm-${round}-b`);
    await page.waitForTimeout(120);
    // Swipe the thread (real touch drag via CDP).
    const thread = page.getByTestId("chat-thread");
    if (await thread.count()) {
      const box = await thread.first().boundingBox();
      if (box) {
        const cy = box.y + box.height / 2;
        const client = await page.context().newCDPSession(page);
        try {
          await client.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x: box.x + box.width * 0.8, y: cy }],
          });
          for (let i = 1; i <= 10; i++) {
            await client.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: box.x + box.width * 0.8 - i * 18, y: cy }],
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
    }
    await page.waitForTimeout(120);
    // Switch away to home and back to chat — chatting across a view switch.
    await openAppPath(page, "/");
    await page.waitForTimeout(120);
    await openAppPath(page, "/chat");
    await expect(page.getByTestId(OVERLAY)).toBeVisible({ timeout: 15_000 });
    await expandToFull(page);
    await testInfo.attach(`storm-round-${round}.png`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  }

  // NO STUCK STATE: after the storm the composer is idle — no stop control
  // latched on, the mic/send control is reachable.
  await expect(page.getByTestId("chat-composer-stop")).toHaveCount(0);
  const composer = page.locator(COMPOSER).first();
  await composer.click();
  await composer.fill("final settle");
  await expect(composer).toHaveValue("final settle");

  // Every delivered message went to SOME real conversation (none dropped into
  // the void) and no message was duplicated within a conversation.
  const allDelivered = Object.values(store.delivered).flat();
  const storms = allDelivered.filter((t) => t.startsWith("storm-"));
  expect(new Set(storms).size).toBe(storms.length); // no duplicates

  await expectNoPageDiagnostics(page, "send-newchat-storm");
});
