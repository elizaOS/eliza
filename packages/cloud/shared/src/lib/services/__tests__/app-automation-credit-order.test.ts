/**
 * Regression tests for the pre-provider throwable-preparation boundary in the
 * telegram/discord/twitter app-automation generators (#11685).
 *
 * The bug: `generateAnnouncement` / `generateReply` / `generateAppTweet`
 * charged credits FIRST, then awaited `getCharacterPromptContext` (a DB read)
 * BEFORE entering the refunding try block around `generateText`. A throw in
 * that deduct→fetch window (DB error/timeout on the character lookup)
 * propagated out with the charge committed and no refund — and these run on
 * schedulers/auto-reply loops, so a transient DB failure leaked a post-cost
 * per invocation.
 *
 * The current contract keeps all throwable prep above paid admission, so these
 * tests pin that a character-context failure never creates an admission lease.
 * Each test also asserts the
 * rejection is the context error itself — proving the context fetch (the
 * armed hazard) is what fired, not some earlier failure.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

const admissionCalls: unknown[] = [];

mock.module("../organization-inference-admission", () => ({
  admitOrganizationInference: async (params: unknown) => {
    admissionCalls.push(params);
    throw new Error("admission should not be reached");
  },
}));

const CONTEXT_DB_ERROR = "character context DB read failed";

mock.module("../character-prompt-helper", () => ({
  getCharacterPromptContext: async () => {
    throw new Error(CONTEXT_DB_ERROR);
  },
  buildCharacterSystemPrompt: () => "IN CHARACTER",
}));

const { telegramAppAutomationService } = await import("../telegram-automation/app-automation");
const { discordAppAutomationService } = await import("../discord-automation/app-automation");
const { twitterAppAutomationService } = await import("../twitter-automation/app-automation");

const ORG_ID = "00000000-0000-4000-8000-00000000b001";

/** Minimal app fixture: only the fields the generators read. */
function makeApp(
  automationField: string,
): Parameters<typeof telegramAppAutomationService.generateAnnouncement>[1] {
  return {
    id: "00000000-0000-4000-8000-00000000b002",
    name: "Test App",
    description: "An app under test",
    app_url: "https://test-app.example",
    website_url: "https://test-app.example",
    [automationField]: { enabled: true, agentCharacterId: "char-under-test" },
  } as unknown as Parameters<typeof telegramAppAutomationService.generateAnnouncement>[1];
}

beforeEach(() => {
  admissionCalls.length = 0;
});

describe("app-automation generators prepare prompts before admission (#11685)", () => {
  test("telegram generateAnnouncement: context fetch rejects -> no admission", async () => {
    await expect(
      telegramAppAutomationService.generateAnnouncement(ORG_ID, makeApp("telegram_automation")),
    ).rejects.toThrow(CONTEXT_DB_ERROR);

    expect(admissionCalls).toHaveLength(0);
  });

  test("telegram generateReply: context fetch rejects -> no admission", async () => {
    await expect(
      telegramAppAutomationService.generateReply(
        ORG_ID,
        makeApp("telegram_automation"),
        "what does this app do?",
        "tester",
      ),
    ).rejects.toThrow(CONTEXT_DB_ERROR);

    expect(admissionCalls).toHaveLength(0);
  });

  test("discord generateAnnouncement: context fetch rejects -> no admission", async () => {
    await expect(
      discordAppAutomationService.generateAnnouncement(ORG_ID, makeApp("discord_automation")),
    ).rejects.toThrow(CONTEXT_DB_ERROR);

    expect(admissionCalls).toHaveLength(0);
  });

  test("twitter generateAppTweet: context fetch rejects -> no admission", async () => {
    await expect(
      twitterAppAutomationService.generateAppTweet(
        ORG_ID,
        makeApp("twitter_automation"),
        "promotional",
      ),
    ).rejects.toThrow(CONTEXT_DB_ERROR);

    expect(admissionCalls).toHaveLength(0);
  });
});
