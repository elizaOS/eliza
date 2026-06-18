// Conversation persistence coverage for the REAL web chat surface (the
// continuous-chat overlay on /chat). A message sent through the overlay must
// survive a full page reload — the reloaded shell rehydrates the active
// conversation from GET /api/conversations + GET .../messages and re-renders
// the thread. Keyless against a stateful in-spec store.
//
// SCOPE NOTE — page-scoped clear is intentionally NOT driven here. The
// page-scoped-chat-clear-<scope> control + truncate endpoint live in
// PageScopedChatPane, which is mounted only by AppWorkspaceChrome when a
// `chatScope` is set AND `chatDisabled` is false. The single chatScope caller
// (BrowserWorkspaceView at /browser) passes `chatDisabled`, so the chrome
// renders `null` for the chat content (AppWorkspaceChrome.tsx). The web /chat
// route is overlay-only and the overlay carries no per-conversation
// clear/truncate affordance (ContinuousChatOverlay.tsx). So no keyless web
// route exposes the clear control; that path stays covered by the component
// tests. This spec asserts the reachable half: send + persistence.

import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';
const USER_TEXT = "remember this across a reload";

/**
 * A stateful conversation store that survives reloads (the routes persist for
 * the page's lifetime, not per-navigation). Mirrors the stub's real in-memory
 * store semantics: POST creates, stream appends user+assistant turns, GET
 * messages returns the full thread.
 */
async function installPersistentConversationStore(page: Page): Promise<void> {
  const messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    timestamp: number;
  }> = [];
  let created = false;
  let sequence = 0;
  const conversationRecord = () => ({
    id: "persist-conversation",
    roomId: "persist-room",
    title: "Persistence smoke",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await page.route("**/api/conversations", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversations: created ? [conversationRecord()] : [],
        }),
      });
      return;
    }
    if (method === "POST") {
      created = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversation: conversationRecord() }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route(
    "**/api/conversations/persist-conversation/messages",
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
    "**/api/conversations/persist-conversation/messages/stream",
    async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        text?: string;
      };
      const userText = (body.text ?? "").trim();
      sequence += 1;
      const assistantText = "Saved — I'll keep this.";
      messages.push({
        id: `persist-user-${sequence}`,
        role: "user",
        text: userText,
        timestamp: Date.now(),
      });
      messages.push({
        id: `persist-assistant-${sequence}`,
        role: "assistant",
        text: assistantText,
        timestamp: Date.now(),
      });
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `data: ${JSON.stringify({
            type: "token",
            text: assistantText,
            fullText: assistantText,
          })}\n\n` +
          `data: ${JSON.stringify({
            type: "done",
            fullText: assistantText,
            agentName: "Eliza",
          })}\n\n`,
      });
    },
  );

  await page.route(
    "**/api/conversations/persist-conversation/greeting**",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          text: "Ready when you are.",
          localInference: null,
        }),
      });
    },
  );

  await page.route(
    "**/api/conversations/persist-conversation",
    async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ conversation: conversationRecord() }),
        });
        return;
      }
      await route.fallback();
    },
  );
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await installPersistentConversationStore(page);
});

test("chat overlay: a sent message persists across a full page reload", async ({
  page,
}) => {
  await openAppPath(page, "/chat");
  await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
    timeout: 60_000,
  });

  const composer = page.locator(CHAT_COMPOSER_SELECTOR).first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  // Send a message and confirm both turns render in-thread.
  await composer.fill(USER_TEXT);
  const send = page.getByTestId("chat-composer-action");
  await expect(send).toBeVisible({ timeout: 10_000 });
  await send.click();

  await expect(
    page.getByTestId("thread-line").filter({ hasText: USER_TEXT }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page
      .getByTestId("thread-line")
      .filter({ hasText: "Saved — I'll keep this." })
      .first(),
  ).toBeVisible({ timeout: 30_000 });

  // Reload: a fresh shell must rehydrate the same conversation thread from the
  // persistent store (GET conversations -> GET messages), not start empty.
  await openAppPath(page, "/chat");
  await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
    timeout: 60_000,
  });

  // The persisted user turn must reappear. The chat rests collapsed (just the
  // input); pull it up (the grabber is keyboard-operable) to reveal the whole
  // scrollable transcript.
  const grabber = page.getByTestId("chat-sheet-grabber");
  await expect(grabber).toBeVisible({ timeout: 15_000 });
  await grabber.focus();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("continuous-chat-overlay")).toHaveAttribute(
    "data-open",
    "true",
    { timeout: 10_000 },
  );

  await expect(
    page.getByTestId("thread-line").filter({ hasText: USER_TEXT }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page
      .getByTestId("thread-line")
      .filter({ hasText: "Saved — I'll keep this." })
      .first(),
  ).toBeVisible({ timeout: 30_000 });
});
