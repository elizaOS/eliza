// Opt-in app smoke against the real UI stack and a real LLM-backed agent.
//
// Default UI smoke runs force the lightweight harness API for speed. Enable this
// test with ELIZA_UI_SMOKE_LIVE_STACK=1 plus a provider key accepted by
// selectLiveProvider() to verify the app shell can send a real chat message to
// a live runtime.

import { expect, type Page, test } from "@playwright/test";
import { selectLiveProviderAsync } from "../../../app-core/test/helpers/live-provider";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const LIVE_AGENT_CHAT_ENABLED = process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";
const LIVE_PROVIDER = await selectLiveProviderAsync();
const REPORT_LIVE_TIMINGS = process.env.ELIZA_UI_SMOKE_REPORT_TIMINGS === "1";
const LIVE_AGENT_RESPONSE_MARKER = "LIVE_AGENT_RESPONSE_OK";
const LIVE_GENERAL_PROMPTS: ReadonlyArray<{
  marker: string;
  prompt: string;
}> = [
  {
    marker: "LIVE_TIME_CHECK_OK",
    prompt:
      "For a Playwright end-to-end smoke test, start your reply with exactly LIVE_TIME_CHECK_OK, then answer this user request in one sentence: what time is it?",
  },
  {
    marker: "LIVE_BTC_CHECK_OK",
    prompt:
      "For a Playwright end-to-end smoke test, start your reply with exactly LIVE_BTC_CHECK_OK, then answer this tool-free user request in one sentence: in plain terms, what is BTC? Do not look up live prices.",
  },
  {
    marker: "LIVE_BTC_PRICE_HANDLED_OK",
    prompt:
      "For a Playwright end-to-end smoke test, start your reply with exactly LIVE_BTC_PRICE_HANDLED_OK, then answer this tool-free user request in one sentence: what is the price of BTC? Do not call tools or look up live prices; say live market data is unavailable.",
  },
  {
    marker: "LIVE_WEBSITE_CODE_OK",
    prompt:
      "For a Playwright end-to-end smoke test, start your reply with exactly LIVE_WEBSITE_CODE_OK, then provide a tiny complete HTML example for a simple personal website.",
  },
];
const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';
const CHAT_SEND_SELECTOR =
  '[data-testid="chat-composer-action"], button[aria-label="Send"], button[aria-label="Send message"]';
const OPTIONAL_LIVE_ENDPOINTS = [
  /\/build-info\.json(?:\?|$)/,
  /\/api\/cloud\/status(?:\?|$)/,
  /\/api\/coding-agents(?:\?|$)/,
  /\/api\/connectors\/google\/accounts(?:\?|$)/,
  /\/api\/i18n\/locale(?:\?|$)/,
  /\/api\/lifeops\/activity-signals(?:\?|$)/,
  /\/api\/lifeops\/goals(?:\?|$)/,
  /\/api\/lifeops\/todos(?:\?|$)/,
  /\/api\/orchestrator\/status(?:\?|$)/,
  /\/api\/orchestrator\/tasks(?:\?|$)/,
  /\/api\/tts\/cloud(?:\?|$)/,
  /\/api\/wallet\/market-overview(?:\?|$)/,
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

type ApiConversationResponse = {
  conversation?: {
    id?: string;
  };
};

type LivePromptTiming = {
  marker: string;
  promptLength: number;
  sendToUserVisibleMs: number;
  sendToAssistantMarkerMs: number;
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

async function installOptionalLiveChromeRoutes(page: Page): Promise<void> {
  const orchestratorUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    state: "unavailable",
    byProvider: [],
  };
  await page.route("**/api/orchestrator/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        taskCount: 0,
        activeTaskCount: 0,
        pausedTaskCount: 0,
        blockedTaskCount: 0,
        validatingTaskCount: 0,
        sessionCount: 0,
        activeSessionCount: 0,
        usage: orchestratorUsage,
        byStatus: {
          open: 0,
          active: 0,
          waiting_on_user: 0,
          blocked: 0,
          validating: 0,
          done: 0,
          failed: 0,
          archived: 0,
          interrupted: 0,
        },
      }),
    });
  });
  await page.route("**/api/orchestrator/tasks**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname === "/api/orchestrator/tasks"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tasks: [] }),
      });
      return;
    }
    await route.fallback();
  });
}

function chatComposer(page: Page) {
  return page.locator(CHAT_COMPOSER_SELECTOR).first();
}

function chatSendButton(page: Page) {
  return page.locator(CHAT_SEND_SELECTOR).first();
}

function conversationLog(page: Page) {
  return page.getByRole("region", { name: /conversation history/i });
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

async function sendPromptAndExpectAssistantMarker(
  page: Page,
  prompt: string,
  marker: string,
): Promise<LivePromptTiming> {
  await expect(chatComposer(page)).toBeVisible({
    timeout: 60_000,
  });
  await chatComposer(page).fill(prompt);
  await expect(chatSendButton(page)).toBeEnabled();
  const sentAt = Date.now();
  await chatSendButton(page).click();

  await expect(userMessage(page, prompt)).toBeVisible({ timeout: 30_000 });
  const userVisibleAt = Date.now();
  await expect(assistantMessage(page, new RegExp(marker, "i"))).toBeVisible({
    timeout: 120_000,
  });
  return {
    marker,
    promptLength: prompt.length,
    sendToUserVisibleMs: userVisibleAt - sentAt,
    sendToAssistantMarkerMs: Date.now() - sentAt,
  };
}

function reportLiveTiming(timing: LivePromptTiming): void {
  if (!REPORT_LIVE_TIMINGS) return;
  console.log(
    `[live-agent-chat][timing] marker=${timing.marker} promptLength=${timing.promptLength} userVisibleMs=${timing.sendToUserVisibleMs} assistantMarkerMs=${timing.sendToAssistantMarkerMs}`,
  );
}

async function createAndActivateLiveConversation(
  page: Page,
  title: string,
): Promise<void> {
  const response = await page.request.post("/api/conversations", {
    data: { title, metadata: { scope: "general" } },
  });
  const responseText = await response.text();
  expect(
    response.ok(),
    `live runtime should create an isolated chat (status=${response.status()}, body=${responseText.slice(0, 500)})`,
  ).toBe(true);

  const body = JSON.parse(responseText) as ApiConversationResponse;
  const conversationId = body.conversation?.id?.trim();
  expect(conversationId, "created live conversation id").toBeTruthy();

  await seedAppStorage(page, {
    "eliza:chat:activeConversationId": conversationId,
  });
  await installOptionalLiveChromeRoutes(page);
  await openAppPath(page, "/chat");
  await expect(chatComposer(page)).toBeVisible({ timeout: 60_000 });
}

test("app chat sends a message to the deterministic keyless agent and renders parseable JSON", async ({
  page,
}) => {
  test.skip(
    LIVE_AGENT_CHAT_ENABLED,
    "deterministic keyless assertions are only valid against the stub stack",
  );
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
  test.skip(
    LIVE_AGENT_CHAT_ENABLED,
    "deterministic keyless assertions are only valid against the stub stack",
  );
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
    await createAndActivateLiveConversation(page, "live-agent-marker");

    const prompt = `For a Playwright end-to-end smoke test, reply with exactly ${LIVE_AGENT_RESPONSE_MARKER} and no other words.`;
    reportLiveTiming(
      await sendPromptAndExpectAssistantMarker(
        page,
        prompt,
        LIVE_AGENT_RESPONSE_MARKER,
      ),
    );

    expect(failures, "live agent chat browser/runtime failures").toEqual([]);
  });

  for (const { marker, prompt } of LIVE_GENERAL_PROMPTS) {
    test(`app chat handles live general prompt ${marker}`, async ({ page }) => {
      const failures = installFailureCollectors(page);
      await createAndActivateLiveConversation(page, `live-agent-${marker}`);
      reportLiveTiming(
        await sendPromptAndExpectAssistantMarker(page, prompt, marker),
      );

      expect(
        failures,
        `live prompt ${marker} browser/runtime failures`,
      ).toEqual([]);
    });
  }
});
