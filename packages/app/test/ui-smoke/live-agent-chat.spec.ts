// Opt-in app smoke against the real UI stack and a real LLM-backed agent.
//
// Default UI smoke runs force the lightweight harness API for speed. Enable this
// test with ELIZA_UI_SMOKE_LIVE_STACK=1 plus a provider key accepted by
// selectLiveProvider() to verify the app shell can send a real chat message to
// a live runtime.

import { expect, type Page, test } from "@playwright/test";
import { selectLiveProvider } from "../../../app-core/test/helpers/live-provider";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const LIVE_AGENT_CHAT_ENABLED = process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";
const LIVE_PROVIDER = selectLiveProvider();
const LIVE_AGENT_RESPONSE_MARKER = "APP_LIVE_AGENT_OK";
const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';
const CHAT_SEND_SELECTOR =
  '[data-testid="chat-composer-action"], button[aria-label="Send"], button[aria-label="Send message"]';
const OPTIONAL_LIVE_ENDPOINTS = [
  /\/api\/coding-agents(?:\?|$)/,
  /\/api\/lifeops\/activity-signals(?:\?|$)/,
  /\/api\/tts\/cloud(?:\?|$)/,
  /\/api\/vincent\/status(?:\?|$)/,
];

type DeterministicAssistantFixture = {
  fixture: string;
  transport: string;
  input: {
    text: string;
  };
  action: {
    type: string;
    target: string | null;
  };
};

function isOptionalLiveEndpoint(url: string): boolean {
  return OPTIONAL_LIVE_ENDPOINTS.some((pattern) => pattern.test(url));
}

function parseAssistantFixtureText(
  text: string,
): DeterministicAssistantFixture {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  expect(
    start,
    "Assistant message should contain a JSON object",
  ).toBeGreaterThanOrEqual(0);
  expect(
    end,
    "Assistant message should contain a complete JSON object",
  ).toBeGreaterThan(start);
  return JSON.parse(
    text.slice(start, end + 1),
  ) as DeterministicAssistantFixture;
}

function installFailureCollectors(page: Page): string[] {
  const failures: string[] = [];
  page.on("pageerror", (error) => {
    failures.push(`pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/^\[RenderTelemetry\]/.test(text)) return;
    if (
      /^Failed to load resource: the server responded with a status of (401|404) /i.test(
        text,
      )
    ) {
      return;
    }
    failures.push(`console.error: ${text}`);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    if (/\/favicon(?:\.ico)?(?:\?|$)/i.test(response.url())) return;
    if (response.status() < 500 && isOptionalLiveEndpoint(response.url())) {
      return;
    }
    failures.push(`${response.status()} ${response.url()}`);
  });
  return failures;
}

function chatComposer(page: Page) {
  return page.locator(CHAT_COMPOSER_SELECTOR).first();
}

function chatSendButton(page: Page) {
  return page.locator(CHAT_SEND_SELECTOR).first();
}

function conversationLog(page: Page) {
  return page.getByRole("log", { name: /conversation history/i });
}

function userMessage(page: Page, text: string) {
  return page
    .locator('[data-testid="chat-message"][data-role="user"]')
    .filter({ hasText: text })
    .last()
    .or(
      conversationLog(page)
        .locator('[data-role="user"]')
        .filter({ hasText: text })
        .last(),
    )
    .or(conversationLog(page).getByText(text).last())
    .first();
}

function assistantMessage(page: Page, text: string | RegExp) {
  return page
    .locator('[data-testid="chat-message"][data-role="assistant"]')
    .filter({ hasText: text })
    .last()
    .or(
      conversationLog(page)
        .locator('[data-role="assistant"]')
        .filter({ hasText: text })
        .last(),
    )
    .first();
}

test("app chat sends a message to the deterministic keyless agent and renders parseable JSON", async ({
  page,
}) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);

  await openAppPath(page, "/chat");
  await expect(chatComposer(page)).toBeVisible({
    timeout: 60_000,
  });

  const prompt = "Open the wallet inventory view from this keyless smoke test.";
  await chatComposer(page).fill(prompt);
  await expect(chatSendButton(page)).toBeEnabled();
  await chatSendButton(page).click();

  await expect(userMessage(page, prompt)).toBeVisible({ timeout: 30_000 });

  const message = assistantMessage(page, /ui-smoke-assistant-v1/);
  await expect(message).toBeVisible({ timeout: 60_000 });
  const assistantText = (await message.textContent())?.trim() ?? "";
  const parsed = parseAssistantFixtureText(assistantText);
  expect(parsed).toMatchObject({
    fixture: "ui-smoke-assistant-v1",
    transport: "sse",
    input: {
      text: prompt,
    },
    action: {
      type: "navigate",
      target: "/wallet",
    },
  });
});

test("app chat rejects intentionally broken deterministic mock LLM output", async ({
  page,
}) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);

  await openAppPath(page, "/chat");
  await expect(chatComposer(page)).toBeVisible({
    timeout: 60_000,
  });

  const prompt =
    "BROKEN_LLM_RESPONSE Open the wallet inventory view from this smoke test.";
  await chatComposer(page).fill(prompt);
  await expect(chatSendButton(page)).toBeEnabled();
  await chatSendButton(page).click();

  await expect(userMessage(page, prompt)).toBeVisible({ timeout: 30_000 });

  const message = assistantMessage(page, /BROKEN_MOCK_LLM_RESPONSE/);
  await expect(message).toBeVisible({ timeout: 60_000 });
  const assistantText = (await message.textContent())?.trim() ?? "";

  expect(assistantText).toContain("BROKEN_MOCK_LLM_RESPONSE");
  expect(() => parseAssistantFixtureText(assistantText)).toThrow();
  expect(assistantText).not.toMatch(/}\s*$/);
});

test.describe("live agent chat", () => {
  test.skip(
    !LIVE_AGENT_CHAT_ENABLED,
    "set ELIZA_UI_SMOKE_LIVE_STACK=1 to run against the real app runtime",
  );
  test.skip(
    !LIVE_PROVIDER,
    "set a supported live provider key for the app runtime",
  );

  test("app chat sends a message to the live agent and renders the response", async ({
    page,
  }) => {
    const failures = installFailureCollectors(page);
    await seedAppStorage(page);

    await openAppPath(page, "/chat");
    await expect(chatComposer(page)).toBeVisible({
      timeout: 60_000,
    });

    const prompt = `For a Playwright end-to-end smoke test, reply with exactly ${LIVE_AGENT_RESPONSE_MARKER} and no other words.`;
    await chatComposer(page).fill(prompt);
    await expect(chatSendButton(page)).toBeEnabled();
    await chatSendButton(page).click();

    await expect(userMessage(page, prompt)).toBeVisible({ timeout: 30_000 });

    await expect(
      assistantMessage(page, new RegExp(LIVE_AGENT_RESPONSE_MARKER, "i")),
    ).toBeVisible({ timeout: 120_000 });

    expect(failures, "live agent chat browser/runtime failures").toEqual([]);
  });
});
