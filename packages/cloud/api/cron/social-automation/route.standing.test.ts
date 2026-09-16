/**
 * Mounts the scheduled social-automation route and proves due jobs without a
 * delegated standing snapshot fail closed before provider-capable services.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const discordPost = mock(async () => ({ success: true }));
const telegramPost = mock(async () => ({ success: true }));
const twitterPost = mock(async () => ({ success: true }));

const appRow = {
  id: "app-1",
  organization_id: "org-1",
  created_by_user_id: "user-1",
  api_key_id: "key-1",
  name: "Scheduled App",
};
const configRow = {
  app_id: "app-1",
  discord_automation: { enabled: true, autoAnnounce: true },
  telegram_automation: { enabled: true, autoAnnounce: true },
  twitter_automation: { enabled: true, autoPost: true },
};

mock.module("drizzle-orm", () => ({
  eq: () => ({}),
  or: () => ({}),
  sql: () => ({}),
}));
mock.module("@/db/client", () => ({
  dbRead: {
    select: () => ({
      from: () => ({ where: async () => [configRow] }),
    }),
    query: { apps: { findFirst: async () => appRow } },
  },
}));
mock.module("@/db/schemas", () => ({ apps: { id: {} } }));
mock.module("@/db/schemas/app-config", () => ({
  appConfig: {
    discord_automation: {},
    telegram_automation: {},
    twitter_automation: {},
  },
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireCronSecret: () => undefined,
}));
mock.module("@/lib/services/discord-automation/app-automation", () => ({
  discordAppAutomationService: { postAnnouncement: discordPost },
}));
mock.module("@/lib/services/telegram-automation/app-automation", () => ({
  telegramAppAutomationService: { postAnnouncement: telegramPost },
}));
mock.module("@/lib/services/twitter-automation/app-automation", () => ({
  twitterAppAutomationService: { postAppTweet: twitterPost },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/cron/social-automation", route);

beforeEach(() => {
  discordPost.mockClear();
  telegramPost.mockClear();
  twitterPost.mockClear();
});

describe("social automation cron standing boundary", () => {
  test("reports due jobs as blocked without dispatching any provider-capable service", async () => {
    const response = await app.request("/cron/social-automation", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      stats: { postsAttempted: 3, successful: 0, failed: 3 },
    });
    expect(discordPost).not.toHaveBeenCalled();
    expect(telegramPost).not.toHaveBeenCalled();
    expect(twitterPost).not.toHaveBeenCalled();
  });
});
