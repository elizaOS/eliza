/**
 * Provider-boundary tests for app automation generation using real shared
 * admission ordering with deterministic provider and lease doubles.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

const events: string[] = [];
let denyAdmission = false;
let providerFailure = false;
let settlementGate = Promise.resolve();
let releaseSettlement: (() => void) | undefined;
let retainedTask: Promise<unknown> | undefined;

mock.module("../organization-inference-admission", () => ({
  admitOrganizationInference: async () => {
    events.push("admit");
    if (denyAdmission) throw new Error("cached standing denied");
    return {
      mode: "cache_admission",
      affiliateAttribution: null,
      markProviderDispatched: async () => {
        events.push("mark");
      },
      settle: async () => {
        events.push("settle");
        await settlementGate;
        return null;
      },
      settleUnknown: async () => {
        events.push("settleUnknown");
        return null;
      },
    };
  },
}));

mock.module("ai", () => ({
  generateText: async () => {
    events.push("provider");
    if (providerFailure) throw new Error("provider failed");
    return { text: "A generated announcement", finishReason: "stop" };
  },
}));

mock.module("@ai-sdk/openai", () => ({ openai: () => ({ modelId: "gpt-5-mini" }) }));
mock.module("../../providers/language-model", () => ({
  getLanguageModel: () => ({ modelId: "claude-sonnet" }),
}));
mock.module("../character-prompt-helper", () => ({
  getCharacterPromptContext: async () => null,
  buildCharacterSystemPrompt: () => "",
}));

const { discordAppAutomationService } = await import("../discord-automation/app-automation");
const { telegramAppAutomationService } = await import("../telegram-automation/app-automation");
const { twitterAppAutomationService } = await import("../twitter-automation/app-automation");

const organizationId = "00000000-0000-4000-8000-00000000f001";
const operationContext = {
  organizationId,
  userId: "00000000-0000-4000-8000-00000000f002",
  apiKeyId: null,
  requestId: "automation-request",
};
const app = {
  id: "00000000-0000-4000-8000-00000000f003",
  organization_id: organizationId,
  name: "Admission Test App",
  description: "Tests paid generation",
  app_url: "https://example.test/app",
  website_url: "https://example.test",
  discord_automation: { enabled: true },
  telegram_automation: { enabled: true },
  twitter_automation: { enabled: true },
} as Parameters<typeof discordAppAutomationService.generateAnnouncement>[1];

beforeEach(() => {
  events.length = 0;
  denyAdmission = false;
  providerFailure = false;
  settlementGate = Promise.resolve();
  releaseSettlement = undefined;
  retainedTask = undefined;
});

describe("app automation provider admission", () => {
  test("marks before Discord dispatch and retains settlement asynchronously", async () => {
    settlementGate = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    const context = {
      ...operationContext,
      executionCtx: {
        waitUntil(task: Promise<unknown>) {
          events.push("waitUntil");
          retainedTask = task;
        },
      },
    };

    await discordAppAutomationService.generateAnnouncement(organizationId, app, context);
    expect(events).toEqual(["admit", "mark", "provider", "settle", "waitUntil"]);
    expect(retainedTask).toBeDefined();
    releaseSettlement?.();
    await retainedTask;
  });

  test("cached denial makes zero Telegram provider calls", async () => {
    denyAdmission = true;
    await expect(
      telegramAppAutomationService.generateAnnouncement(organizationId, app, operationContext),
    ).rejects.toThrow("cached standing denied");
    expect(events).toEqual(["admit"]);
  });

  test("post-mark Twitter failure settles unknown", async () => {
    providerFailure = true;
    await expect(
      twitterAppAutomationService.generateAppTweet(
        organizationId,
        app,
        "promotional",
        operationContext,
      ),
    ).rejects.toThrow("provider failed");
    expect(events).toEqual(["admit", "mark", "provider", "settleUnknown"]);
  });

  test("cron-style calls without caller context fail closed before providers", async () => {
    await expect(
      discordAppAutomationService.generateAnnouncement(organizationId, app),
    ).rejects.toThrow("trusted generative admission context");
    await expect(
      telegramAppAutomationService.generateAnnouncement(organizationId, app),
    ).rejects.toThrow("trusted generative admission context");
    await expect(twitterAppAutomationService.generateAppTweet(organizationId, app)).rejects.toThrow(
      "trusted generative admission context",
    );
    expect(events).toEqual([]);
  });
});
