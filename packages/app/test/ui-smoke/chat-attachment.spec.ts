// Image-attachment coverage for the REAL web chat surface (the continuous-chat
// overlay on /chat). Drives the overlay's attach control with a real PNG file,
// asserts the pending thumbnail renders in the composer, sends, and asserts the
// outbound stream POST body carries the base64 attachment. Keyless against the
// stub.
//
// Surface notes (verified against source, load-bearing for the asserts):
//   * The overlay (ContinuousChatOverlay.tsx) renders pending attachments as
//     `<img alt={img.name}>` in the composer BEFORE send, then clears them on
//     submit (setPendingImages([])) — so the thumbnail is a pre-send assertion.
//   * `send(text, { images })` -> useShellController.send -> sendChatText(text,
//     { images }) -> client.sendConversationMessageStream(..., images, ...),
//     which POSTs `{ text, channelType, images:[{ data, mimeType, name }] }` to
//     /api/conversations/<id>/messages/stream (client-chat.ts). The user turn
//     renders in-thread as a text ThreadLine (the overlay thread is text-only;
//     it does not re-render the sent image in the transcript by design).

import { expect, type Page, type Route, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';

// A real 1x1 PNG (the bytes matter only insofar as the renderer base64-encodes
// them into the attachment payload; this is a valid decodable PNG).
const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

type StreamCall = { text?: string; images?: unknown };

/** Captures the stream POST body so the attachment payload is assertable. */
async function installAttachmentStreamMock(page: Page): Promise<{
  streamCalls: () => StreamCall[];
}> {
  const streamCalls: StreamCall[] = [];
  let created = false;

  await page.route("**/api/conversations", async (route) => {
    const method = route.request().method();
    const timestamp = new Date().toISOString();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversations: created
            ? [
                {
                  id: "attach-conversation",
                  roomId: "attach-room",
                  title: "Attachment smoke",
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
              ]
            : [],
        }),
      });
      return;
    }
    if (method === "POST") {
      created = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversation: {
            id: "attach-conversation",
            roomId: "attach-room",
            title: "Attachment smoke",
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route(
    "**/api/conversations/attach-conversation/messages",
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ messages: [] }),
        });
        return;
      }
      await route.fallback();
    },
  );

  await page.route(
    "**/api/conversations/attach-conversation/messages/stream",
    async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as StreamCall;
      streamCalls.push(body);
      const assistantText = "Got the image.";
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
    "**/api/conversations/attach-conversation/greeting**",
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
    "**/api/conversations/attach-conversation",
    async (route: Route) => {
      if (route.request().method() === "PATCH") {
        const timestamp = new Date().toISOString();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            conversation: {
              id: "attach-conversation",
              roomId: "attach-room",
              title: "Attachment smoke",
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          }),
        });
        return;
      }
      await route.fallback();
    },
  );

  return { streamCalls: () => [...streamCalls] };
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("chat overlay: attaching an image renders a pending thumbnail and sends the attachment in the stream body", async ({
  page,
}) => {
  const conversations = await installAttachmentStreamMock(page);

  await openAppPath(page, "/chat");
  await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
    timeout: 60_000,
  });

  const composer = page.locator(CHAT_COMPOSER_SELECTOR).first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  // 1) Set a file on the hidden input behind the attach control.
  const attach = page.getByTestId("chat-composer-attach");
  await expect(attach).toBeVisible({ timeout: 15_000 });
  const fileInput = page.locator('input[type="file"][accept="image/*"]');
  await fileInput.setInputFiles({
    name: "smoke.png",
    mimeType: "image/png",
    buffer: ONE_PX_PNG,
  });

  // 2) The pending thumbnail renders in the composer (alt = file name).
  const pendingThumb = page.locator('img[alt="smoke.png"]');
  await expect(pendingThumb).toBeVisible({ timeout: 10_000 });

  // 3) Add caption text + send. The send button swaps in once there is a draft
  //    or a pending image (chat-composer-action).
  await composer.fill("describe this");
  const send = page.getByTestId("chat-composer-action");
  await expect(send).toBeVisible({ timeout: 10_000 });
  await send.click();

  // 4) The user turn renders in-thread (the overlay thread is text-only).
  await expect(
    page
      .getByTestId("thread-line")
      .filter({ hasText: "describe this" })
      .first(),
  ).toBeVisible({ timeout: 30_000 });

  // 5) The outbound stream POST body carries the base64 attachment.
  await expect
    .poll(() => conversations.streamCalls().length)
    .toBeGreaterThan(0);
  const lastCall = conversations.streamCalls().at(-1);
  expect(lastCall?.text).toBe("describe this");
  expect(Array.isArray(lastCall?.images)).toBe(true);
  const images = (lastCall?.images ?? []) as Array<{
    data?: string;
    mimeType?: string;
    name?: string;
  }>;
  expect(images).toHaveLength(1);
  expect(images[0]).toEqual(
    expect.objectContaining({
      mimeType: "image/png",
      name: "smoke.png",
      data: ONE_PX_PNG.toString("base64"),
    }),
  );

  // 6) Sending clears the pending strip — the thumbnail is gone post-send.
  await expect(pendingThumb).toHaveCount(0, { timeout: 10_000 });
});
