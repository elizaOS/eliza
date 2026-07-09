/**
 * API-key auth boundary coverage keeps storage outages distinct from invalid
 * credentials so clients retry instead of prompting users to rotate good keys.
 */

import { describe, expect, mock, test } from "bun:test";

const validateApiKey = mock(async () => {
  throw new Error("database unavailable");
});

mock.module("../services/api-keys", () => ({
  apiKeysService: {
    validateApiKey,
    incrementUsageDebounced: mock(async () => undefined),
  },
}));

mock.module("../services/users", () => ({
  usersService: {
    getWithOrganization: mock(async () => null),
  },
}));

mock.module("./steward-client", () => ({
  verifyStewardTokenCached: mock(async () => null),
}));

mock.module("./playwright-test-session", () => ({
  PLAYWRIGHT_TEST_SESSION_COOKIE_NAME: "pw-test-session",
  verifyPlaywrightTestSessionToken: mock(() => null),
}));

mock.module("../utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { requireUserOrApiKey } = await import("./workers-hono-auth");

function contextWithApiKey(apiKey: string) {
  const state = new Map<string, unknown>();
  return {
    env: {},
    executionCtx: { waitUntil: mock(() => undefined) },
    req: {
      url: "https://api.example.test/v1/models",
      header: (name: string) => (name.toLowerCase() === "x-api-key" ? apiKey : null),
    },
    get: (key: string) => state.get(key),
    set: (key: string, value: unknown) => state.set(key, value),
  };
}

describe("Workers API-key auth", () => {
  test("returns a service-unavailable error when API-key storage throws", async () => {
    await expect(
      requireUserOrApiKey(contextWithApiKey("eliza_live_key") as never),
    ).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
      message: "API key validation is temporarily unavailable. Please retry.",
    });
  });
});
