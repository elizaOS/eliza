// Large copy-pasted text coverage for the REAL web chat overlay (#8876, the
// "large blocks of copy-pasted text, like Claude Code" objective). Pasting a
// block at/over LARGE_PASTE_CHAR_THRESHOLD into the composer must convert it
// into a collapsed `pasted-text.md` attachment chip (instead of flooding the
// textarea), and that text attachment must ship in the outbound stream body —
// not in the message text. Keyless against the stubbed chat API; recordable via
// E2E_RECORD=1 for a journey video.
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';

// > LARGE_PASTE_CHAR_THRESHOLD (2000), with internal whitespace so it is treated
// as a document, not a lone URL.
const BIG_TEXT = "The quick brown fox jumps over the lazy dog. ".repeat(60);

type StreamCall = {
  text?: string;
  images?: Array<{ data?: string; mimeType?: string; name?: string }>;
};

async function installPasteStreamMock(
  page: Page,
): Promise<{ streamCalls: () => StreamCall[] }> {
  const streamCalls: StreamCall[] = [];
  let created = false;
  const ts = () => new Date().toISOString();
  const convo = () => ({
    id: "paste-conversation",
    roomId: "paste-room",
    title: "Large paste smoke",
    createdAt: ts(),
    updatedAt: ts(),
  });

  await page.route("**/api/conversations", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversations: created ? [convo()] : [] }),
      });
      return;
    }
    if (method === "POST") {
      created = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversation: convo() }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route(
    "**/api/conversations/paste-conversation/messages",
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
    "**/api/conversations/paste-conversation/messages/stream",
    async (route) => {
      streamCalls.push(JSON.parse(route.request().postData() ?? "{}"));
      const text = "Got your pasted text.";
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
    "**/api/conversations/paste-conversation/greeting**",
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
    "**/api/conversations/paste-conversation",
    async (route: Route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ conversation: convo() }),
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

test("chat overlay: a large paste becomes a pasted-text.md attachment and ships in the stream body", async ({
  page,
}) => {
  const conversations = await installPasteStreamMock(page);

  await openAppPath(page, "/chat");
  await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
    timeout: 60_000,
  });

  const composer = page.locator(CHAT_COMPOSER_SELECTOR).first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.click();

  // 1) Dispatch a real paste event carrying the large text block. The overlay's
  //    onPaste converts it to a collapsed attachment chip.
  await composer.evaluate((el, text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, BIG_TEXT);

  // 2) The pending text-attachment chip renders (named pasted-text.md), and the
  //    huge block did NOT flood the textarea.
  await expect(page.getByText("pasted-text.md").first()).toBeVisible({
    timeout: 10_000,
  });
  expect(((await composer.inputValue()) ?? "").length).toBeLessThan(100);

  // 3) Add a short caption + send.
  await composer.fill("here's the doc");
  const send = page.getByTestId("chat-composer-action");
  await expect(send).toBeVisible({ timeout: 10_000 });
  await send.click();

  // 4) The outbound stream body carries the pasted text as an ATTACHMENT (not in
  //    the message text) — the load-bearing assertion.
  await expect
    .poll(() => conversations.streamCalls().length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const last = conversations.streamCalls().at(-1);
  expect(last?.text).toBe("here's the doc");
  const images = last?.images ?? [];
  expect(images).toHaveLength(1);
  expect(images[0]?.name).toBe("pasted-text.md");
  expect(images[0]?.mimeType ?? "").toMatch(/^text\//);
  const decoded = Buffer.from(images[0]?.data ?? "", "base64").toString("utf8");
  expect(decoded).toBe(BIG_TEXT);
});
