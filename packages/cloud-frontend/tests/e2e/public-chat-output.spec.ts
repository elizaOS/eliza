import { expect, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "Public chat output uses local mocks; skipped in live-prod mode",
);

const FAKE_CHARACTER_ID = "22222222-2222-2222-2222-222222222222";

test("public chat renders submitted user text and deterministic streamed output", async ({
  page,
}) => {
  await page.route(`**/api/characters/*/public`, (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          id: FAKE_CHARACTER_ID,
          name: "Playwright Agent",
          username: "playwright-agent",
          avatarUrl: null,
          bio: "A deterministic test agent.",
          creatorUsername: "playwright",
        },
      },
    }),
  );
  await page.route("**/api/v1/models", (route) =>
    route.fulfill({ json: { object: "list", data: [] } }),
  );
  await page.route("**/api/v1/models/status", async (route) => {
    const body = route.request().postDataJSON() as
      | { modelIds?: string[] }
      | undefined;
    return route.fulfill({
      json: {
        models: (body?.modelIds ?? []).map((modelId) => ({
          modelId,
          available: true,
        })),
        timestamp: Date.now(),
      },
    });
  });
  await page.route("**/api/elevenlabs/voices/user", (route) =>
    route.fulfill({ json: { voices: [] } }),
  );
  await page.route("**/api/auth/anonymous-session", (route) =>
    route.fulfill({
      json: {
        isNew: true,
        user: { id: "anonymous-user-1" },
        session: {
          id: "anonymous-session-1",
          message_count: 0,
          messages_limit: 10,
          session_token: "anonymous-session-token-1",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          is_active: true,
        },
      },
    }),
  );
  await page.route("**/api/eliza/rooms", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({ json: { roomId: "room_1" } });
    }
    return route.fulfill({ json: { rooms: [] } });
  });
  await page.route("**/api/eliza/rooms/*/messages", (route) =>
    route.fulfill({ json: { messages: [] } }),
  );
  await page.route("**/api/eliza/rooms/*/messages/stream", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        'event: message\ndata: {"type":"token","messageId":"public-chat-reply","text":"Hello from the deterministic cloud agent."}',
        'event: message\ndata: {"type":"done","fullText":"Hello from the deterministic cloud agent."}',
      ].join("\n\n"),
    }),
  );

  await page.goto(`/chat/${FAKE_CHARACTER_ID}`);

  const chatInput = page.getByPlaceholder(/type your message/i);
  await expect(chatInput).toBeVisible({ timeout: 15_000 });
  await chatInput.fill("hello agent");
  await page.locator('button[type="submit"]').last().click();

  await expect(page.getByText("hello agent")).toBeVisible();
  await expect(
    page.getByText("Hello from the deterministic cloud agent."),
  ).toBeVisible();
});
