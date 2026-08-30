/**
 * Mounts the three manual app-automation post routes and proves a combined
 * standing denial stops the service boundary before any provider-capable call.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const discordPost = mock(async () => ({ success: true }));
const telegramPost = mock(async () => ({ success: true }));
const twitterPost = mock(async () => ({ success: true }));

mock.module("@/api-app/lib/generative-route-auth", () => ({
  requireGenerativeRouteCaller: mock(async () => {
    throw new Error("cached standing denied");
  }),
  getGenerativeOperationContext: mock(() => {
    throw new Error("operation context must not be created after denial");
  }),
  asGenerativeCacheApiError: () => null,
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_c: unknown, error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 403 },
    ),
}));
mock.module("@/lib/services/generative-operation", () => ({
  isGenerativeOperationAdmissionError: () => false,
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
  logger: { info: mock(() => undefined), error: mock(() => undefined) },
}));

const { default: discordRoute } = await import(
  "./discord-automation/post/route"
);
const { default: telegramRoute } = await import(
  "./telegram-automation/post/route"
);
const { default: twitterRoute } = await import(
  "./twitter-automation/post/route"
);

const app = new Hono()
  .route("/:id/discord", discordRoute)
  .route("/:id/telegram", telegramRoute)
  .route("/:id/twitter", twitterRoute);

beforeEach(() => {
  discordPost.mockClear();
  telegramPost.mockClear();
  twitterPost.mockClear();
});

describe("manual app automation standing boundary", () => {
  test.each(["discord", "telegram", "twitter"])(
    "denies %s before its provider-capable service call",
    async (platform) => {
      const response = await app.request(`/app-1/${platform}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "cached standing denied",
      });
      expect(discordPost).not.toHaveBeenCalled();
      expect(telegramPost).not.toHaveBeenCalled();
      expect(twitterPost).not.toHaveBeenCalled();
    },
  );
});
