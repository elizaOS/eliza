/**
 * Guards the production chat client's incremental SSE parsing and React render
 * behavior with a deterministic streaming transport in Chromium.
 *
 * This is intentionally not a server or model latency benchmark; live turn and
 * provider latency comes from `/api/dev/inference-timing`.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import {
  annotateChatStreamRender,
  installChatStreamFixture,
  measureChatStreamRender,
} from "./lib/chat-stream-render-kpi";

const CONVERSATION = {
  id: "stream-render-thread",
  title: "Stream render probe",
  roomId: "room-stream-render",
};

const TOKENS = [
  "The ",
  "provider ",
  "results ",
  "arrive ",
  "in ",
  "parallel, ",
  "then ",
  "render ",
  "incrementally.",
];

async function seedChatRoutes(page: Page): Promise<void> {
  await seedAppStorage(page);
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const timestamp = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversations: [
          { ...CONVERSATION, createdAt: timestamp, updatedAt: timestamp },
        ],
      }),
    });
  });
  await page.route("**/api/conversations/*/messages", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ messages: [] }),
    });
  });
  await installDefaultAppRoutes(page);
  await installChatStreamFixture(page, {
    tokens: TOKENS,
    firstTokenDelayMs: 150,
    intervalMs: 45,
  });
}

test.describe("chat client stream rendering", () => {
  test.setTimeout(20_000);

  test("commits multiple assistant frames before the done event", async ({
    page,
  }, testInfo) => {
    await seedChatRoutes(page);
    await openAppPath(page, "/chat");
    await expect(page.getByTestId("chat-overlay")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
      timeout: 5_000,
    });

    const sample = await measureChatStreamRender(page, {
      message: "How are provider results composed?",
      finalText: "render incrementally.",
    });
    annotateChatStreamRender(testInfo, sample);

    expect(sample.firstFrameCommitMs).toBeGreaterThanOrEqual(100);
    expect(sample.firstFrameCommitMs).toBeLessThan(750);
    expect(sample.transportChunks).toBe(TOKENS.length + 1);
    expect(sample.transportSpreadMs).toBeGreaterThan(300);
    expect(sample.commitsBeforeDone).toBeGreaterThanOrEqual(3);
    expect(sample.distinctLengthsBeforeDone).toBeGreaterThanOrEqual(3);
    expect(sample.firstCommitLeadOverDoneMs).toBeGreaterThan(200);
    expect(
      sample.fullFrameCommitMs - sample.firstFrameCommitMs,
    ).toBeGreaterThan(200);
  });
});
