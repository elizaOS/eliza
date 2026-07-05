// Browser-level evidence for #10713: the real app chat overlay exposes a
// click-to-reveal per-message action row. The component-level tests prove the
// exact callbacks; this smoke records the shipped UI at desktop + mobile sizes.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

const CONVERSATION_ID = "message-actions-conversation";
const ROOM_ID = "message-actions-room";
const ASSISTANT_TEXT = "Action row assistant reply for copy and read aloud.";
const USER_TEXT = "draft me an action row";
const EDITED_TEXT = "draft me a polished action row";
const OUT_DIR = path.join(
  process.cwd(),
  "packages",
  "app",
  "test-results",
  "10713-message-actions",
);

type StreamCall = Record<string, unknown>;

async function installMessageActionConversationRoutes(
  page: Page,
): Promise<{ streamCalls: StreamCall[] }> {
  const now = Date.now();
  const conversation = {
    id: CONVERSATION_ID,
    roomId: ROOM_ID,
    title: "Message action row",
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  const messages = [
    {
      id: "seed-user-action-row",
      role: "user" as const,
      text: USER_TEXT,
      source: "eliza",
      roomId: ROOM_ID,
      timestamp: now - 5_000,
    },
    {
      id: "seed-assistant-action-row",
      role: "assistant" as const,
      text: ASSISTANT_TEXT,
      source: "eliza",
      roomId: ROOM_ID,
      timestamp: now - 2_000,
    },
  ];
  const streamCalls: StreamCall[] = [];

  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversations: [conversation] }),
      });
      return;
    }
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversation }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route(`**/api/conversations/${CONVERSATION_ID}`, async (route) => {
    if (
      route.request().method() === "GET" ||
      route.request().method() === "PATCH"
    ) {
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
    `**/api/conversations/${CONVERSATION_ID}/messages`,
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
    `**/api/conversations/${CONVERSATION_ID}/messages/stream`,
    async (route) => {
      streamCalls.push(JSON.parse(route.request().postData() ?? "{}"));
      const text = "Edited message received.";
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `data: ${JSON.stringify({ type: "token", text, fullText: text })}\n\n` +
          `data: ${JSON.stringify({ type: "done", fullText: text, agentName: "Eliza" })}\n\n`,
      });
    },
  );

  await page.route(
    `**/api/conversations/${CONVERSATION_ID}/greeting**`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ text: "Ready.", localInference: null }),
      });
    },
  );

  return { streamCalls };
}

async function openThread(page: Page): Promise<void> {
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("chat-sheet-grabber").click();
  await expect(overlay).toHaveAttribute("data-open", "true", {
    timeout: 15_000,
  });
  await expect(page.getByText(ASSISTANT_TEXT)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(USER_TEXT)).toBeVisible();
}

async function screenshot(page: Page, name: string): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: path.join(OUT_DIR, `${name}.png`),
    fullPage: false,
    attempts: 4,
  });
}

for (const viewport of [
  { name: "desktop", size: { width: 1280, height: 900 } },
  { name: "mobile", size: { width: 390, height: 844 } },
] as const) {
  test(`chat overlay message action row works on ${viewport.name}`, async ({
    page,
    context,
  }) => {
    const consoleLines: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => consoleLines.push(msg.text()));
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize(viewport.size);
    await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
    await installDefaultAppRoutes(page);
    const { streamCalls } = await installMessageActionConversationRoutes(page);

    await openAppPath(page, "/chat");
    await openThread(page);
    await screenshot(page, `${viewport.name}-chat-open`);

    await page.getByText(ASSISTANT_TEXT).click();
    await expect(page.getByTestId("thread-line-actions")).toBeVisible();
    await expect(page.getByTestId("thread-line-copy")).toBeVisible();
    await expect(page.getByTestId("thread-line-speak")).toBeVisible();
    await expect(page.getByTestId("thread-line-edit")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /copy conversation/i }),
    ).toHaveCount(0);
    await screenshot(page, `${viewport.name}-assistant-actions`);

    await page.getByTestId("thread-line-copy").click();
    await expect(page.getByTestId("thread-line-copy")).toHaveAttribute(
      "aria-label",
      "Copied",
      {
        timeout: 5_000,
      },
    );
    // #10713: the "Copied" affordance flipping is necessary but not sufficient —
    // prove the assistant text actually reached the system clipboard. The context
    // grants clipboard-read above, so read the bytes back and compare.
    const copiedClipboardText = await page.evaluate(() =>
      navigator.clipboard.readText(),
    );
    expect(copiedClipboardText).toBe(ASSISTANT_TEXT);
    await screenshot(page, `${viewport.name}-assistant-copied`);

    await page.getByTestId("thread-line-speak").click();
    await expect(page.getByTestId("thread-line-speak")).toBeVisible();
    await screenshot(page, `${viewport.name}-assistant-play`);

    const userBubble = page.getByText(USER_TEXT);
    await userBubble.click();
    if ((await page.getByTestId("thread-line-copy").count()) === 0) {
      await userBubble.click();
    }
    await expect(page.getByTestId("thread-line-copy")).toBeVisible();
    await expect(page.getByTestId("thread-line-edit")).toBeVisible();
    await expect(page.getByTestId("thread-line-speak")).toHaveCount(0);
    await screenshot(page, `${viewport.name}-user-actions`);

    await page.getByTestId("thread-line-edit").click();
    const editor = page.getByTestId("thread-line-edit-input");
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue(USER_TEXT);
    await editor.fill(EDITED_TEXT);
    await screenshot(page, `${viewport.name}-user-editing`);
    await page.getByTestId("thread-line-edit-save").click();

    await expect.poll(() => streamCalls.length, { timeout: 15_000 }).toBe(1);
    expect(JSON.stringify(streamCalls[0])).toContain(EDITED_TEXT);
    expect(pageErrors, "no uncaught page errors").toEqual([]);

    await test.info().attach(`${viewport.name} console`, {
      body: consoleLines.join("\n") || "N/A - no console output",
      contentType: "text/plain",
    });
  });
}

// ── Persistent message delete (#13533) ──────────────────────────────────────
// The delete affordance is part of the SAME click-to-reveal glass action row
// (thread-line-delete). These tests drive it end to end in a real browser: a
// reveal → delete removes the row AND the server DELETE fires; a reload proves
// the removal is server truth (the store no longer serves the message), not a
// client-only hide; the failure leg (server 500) rolls the row back WITH a
// visible error notice — never a silent success.

const DELETE_CONVERSATION_ID = "delete-message-conversation";
const DELETE_ROOM_ID = "delete-message-room";
const DELETE_KEEP_TEXT = "Keep this reply — it must survive the delete.";
const DELETE_TARGET_TEXT = "Delete this reply — the trash control removes it.";

interface DeleteMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  source: string;
  roomId: string;
  timestamp: number;
}

interface DeleteStore {
  messages: DeleteMessage[];
  deleted: string[];
  /** When true the DELETE route answers 500 so the client rolls back. */
  failDelete: boolean;
}

function makeDeleteStore(): DeleteStore {
  const now = Date.now();
  return {
    messages: [
      {
        id: "seed-keep",
        role: "assistant",
        text: DELETE_KEEP_TEXT,
        source: "eliza",
        roomId: DELETE_ROOM_ID,
        timestamp: now - 6_000,
      },
      {
        id: "seed-delete-target",
        role: "assistant",
        text: DELETE_TARGET_TEXT,
        source: "eliza",
        roomId: DELETE_ROOM_ID,
        timestamp: now - 3_000,
      },
    ],
    deleted: [],
    failDelete: false,
  };
}

async function installDeleteConversationRoutes(
  page: Page,
  store: DeleteStore,
): Promise<void> {
  const now = Date.now();
  const conversation = {
    id: DELETE_CONVERSATION_ID,
    roomId: DELETE_ROOM_ID,
    title: "Delete message",
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };

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

  await page.route(
    `**/api/conversations/${DELETE_CONVERSATION_ID}`,
    async (route) => {
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
    },
  );

  // DELETE one message: /api/conversations/:id/messages/:messageId. Registered
  // BEFORE the list GET so the more-specific path wins.
  await page.route(
    `**/api/conversations/${DELETE_CONVERSATION_ID}/messages/*`,
    async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.fallback();
        return;
      }
      const messageId = new URL(route.request().url()).pathname
        .split("/")
        .pop();
      if (store.failDelete) {
        // Server-truth failure → the client must roll the row back + notice.
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "delete failed" }),
        });
        return;
      }
      if (messageId) {
        store.deleted.push(messageId);
        store.messages = store.messages.filter((m) => m.id !== messageId);
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, deletedCount: 1 }),
      });
    },
  );

  await page.route(
    `**/api/conversations/${DELETE_CONVERSATION_ID}/messages`,
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ messages: store.messages }),
        });
        return;
      }
      await route.fallback();
    },
  );

  await page.route(
    `**/api/conversations/${DELETE_CONVERSATION_ID}/greeting**`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ text: "Ready.", localInference: null }),
      });
    },
  );
}

/**
 * Open the thread and wait for a stable message to render. `waitFor` defaults to
 * the always-present KEEP message so this works both before AND after a delete
 * (the target message is gone after deletion + reload).
 */
async function openDeleteThread(
  page: Page,
  waitFor: string = DELETE_KEEP_TEXT,
): Promise<void> {
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("chat-sheet-grabber").click();
  await expect(overlay).toHaveAttribute("data-open", "true", {
    timeout: 15_000,
  });
  await expect(page.getByText(waitFor)).toBeVisible({
    timeout: 15_000,
  });
}

/** Reveal the glass action row for a message, then click its delete control. */
async function revealAndDelete(page: Page, messageText: string): Promise<void> {
  const bubble = page.getByText(messageText);
  await bubble.click();
  // The action row reveal is a single click; a stray first click that only
  // focuses can need a second (mirrors the copy/edit reveal above).
  if ((await page.getByTestId("thread-line-delete").count()) === 0) {
    await bubble.click();
  }
  await expect(page.getByTestId("thread-line-delete")).toBeVisible({
    timeout: 10_000,
  });
  await page.getByTestId("thread-line-delete").click();
}

test("desktop: delete removes the message, the server DELETE fires, and it stays gone after reload", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const store = makeDeleteStore();
  await page.setViewportSize({ width: 1280, height: 900 });
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
  await installDeleteConversationRoutes(page, store);

  await openAppPath(page, "/chat");
  await openDeleteThread(page);

  await revealAndDelete(page, DELETE_TARGET_TEXT);

  // The row leaves the transcript; the kept message survives.
  await expect(page.getByText(DELETE_TARGET_TEXT)).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(page.getByText(DELETE_KEEP_TEXT)).toBeVisible();
  // The server DELETE actually fired for the target id (not a client-only hide).
  await expect
    .poll(() => store.deleted, { timeout: 10_000 })
    .toContain("seed-delete-target");

  // PERSISTENCE: reload the page. The store no longer serves the message, so a
  // fresh mount rehydrates WITHOUT it — server truth, not a client hide.
  await openAppPath(page, "/chat");
  await openDeleteThread(page);
  await expect(page.getByText(DELETE_KEEP_TEXT)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(DELETE_TARGET_TEXT)).toHaveCount(0);

  expect(pageErrors, "no uncaught page errors").toEqual([]);
});

test("mobile: tap-reveal delete removes the message and fires the server DELETE", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const store = makeDeleteStore();
  await page.setViewportSize({ width: 390, height: 844 });
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
  await installDeleteConversationRoutes(page, store);

  await openAppPath(page, "/chat");
  await openDeleteThread(page);

  await revealAndDelete(page, DELETE_TARGET_TEXT);

  await expect(page.getByText(DELETE_TARGET_TEXT)).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(page.getByText(DELETE_KEEP_TEXT)).toBeVisible();
  await expect
    .poll(() => store.deleted, { timeout: 10_000 })
    .toContain("seed-delete-target");

  expect(pageErrors, "no uncaught page errors").toEqual([]);
});

test("failure: a 500 on DELETE rolls the message back and shows an error notice (no silent success)", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const store = makeDeleteStore();
  store.failDelete = true;
  await page.setViewportSize({ width: 1280, height: 900 });
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
  await installDeleteConversationRoutes(page, store);

  await openAppPath(page, "/chat");
  await openDeleteThread(page);

  await revealAndDelete(page, DELETE_TARGET_TEXT);

  // ROLLBACK: after the server 500 the optimistically-removed message returns
  // (the pipeline is not left in a locally-hidden-but-still-persisted state).
  await expect(page.getByText(DELETE_TARGET_TEXT)).toBeVisible({
    timeout: 10_000,
  });
  // A visible error notice — the three-state rule: the failure surfaces, it is
  // not a silent success.
  await expect(page.getByText(/failed to delete message/i)).toBeVisible({
    timeout: 10_000,
  });
  // The store never recorded a successful delete.
  expect(store.deleted).not.toContain("seed-delete-target");

  expect(pageErrors, "no uncaught page errors").toEqual([]);
});
