/**
 * POST /api/v1/apps/:id/promote/preview used to let request.json() throw as
 * an unhandled SyntaxError 500. Malformed JSON is caller error.
 */
import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
  apiKey: null,
}));
const isAppKeyOutOfScope = mock(async () => false);
const getById = mock(async () => ({
  id: "app-1",
  organization_id: "org-1",
  name: "demo",
  description: "",
  website_url: null,
  app_url: null,
  logo_url: null,
  twitter_automation: {},
  discord_automation: {},
  telegram_automation: {},
}));
const generateAnnouncement = mock(async () => "preview");
const generateAppTweet = mock(async () => ({
  text: "preview",
  type: "promotional",
}));

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));
mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope,
}));
mock.module("@/lib/services/apps", () => ({
  appsService: { getById },
}));
mock.module("@/lib/services/automation-constants", () => ({
  getDiscordConfigWithDefaults: (v: unknown) => v ?? {},
  getTelegramConfigWithDefaults: (v: unknown) => v ?? {},
  getTwitterConfigWithDefaults: (v: unknown) => v ?? {},
}));
mock.module("@/lib/services/discord-automation/app-automation", () => ({
  discordAppAutomationService: { generateAnnouncement },
}));
mock.module("@/lib/services/telegram-automation/app-automation", () => ({
  telegramAppAutomationService: { generateAnnouncement },
}));
mock.module("@/lib/services/twitter-automation/app-automation", () => ({
  twitterAppAutomationService: { generateAppTweet },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, error: () => undefined },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:id", route);

describe("POST /api/v1/apps/:id/promote/preview malformed JSON", () => {
  test("returns 400 instead of 500 and never generates previews", async () => {
    const response = await app.request("/app-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(generateAnnouncement).not.toHaveBeenCalled();
    expect(generateAppTweet).not.toHaveBeenCalled();
  });

  test("canonical JSON still generates previews", async () => {
    const response = await app.request("/app-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platforms: ["twitter"], count: 1 }),
    });
    expect(response.status).toBe(200);
    expect(generateAppTweet).toHaveBeenCalled();
  });
});
