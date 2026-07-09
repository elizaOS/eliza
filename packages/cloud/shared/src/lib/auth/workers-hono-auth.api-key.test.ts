/**
 * API-key auth boundary coverage keeps storage outages distinct from invalid
 * credentials so clients retry instead of prompting users to rotate good keys:
 * a validateApiKey THROW (datastore down) must map to 503 on BOTH guards, while
 * a null return (genuinely invalid key) stays a 401.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let validateBehavior: () => Promise<unknown> = async () => {
  throw new Error("database unavailable");
};
const validateApiKey = mock(() => validateBehavior());

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

const { requireUserOrApiKey, requireUserOrApiKeyWithOrg } = await import("./workers-hono-auth");

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

beforeEach(() => {
  validateBehavior = async () => {
    throw new Error("database unavailable");
  };
});

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

  test("requireUserOrApiKeyWithOrg maps the same storage throw to 503", async () => {
    await expect(
      requireUserOrApiKeyWithOrg(contextWithApiKey("eliza_live_key") as never),
    ).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
    });
  });

  test("a null validation result stays 401 invalid-key on requireUserOrApiKey", async () => {
    validateBehavior = async () => null;
    await expect(
      requireUserOrApiKey(contextWithApiKey("eliza_bad_key") as never),
    ).rejects.toMatchObject({
      status: 401,
      code: "authentication_required",
    });
  });

  test("a null validation result stays 401 invalid-key on requireUserOrApiKeyWithOrg", async () => {
    validateBehavior = async () => null;
    await expect(
      requireUserOrApiKeyWithOrg(contextWithApiKey("eliza_bad_key") as never),
    ).rejects.toMatchObject({
      status: 401,
      code: "authentication_required",
    });
  });
});
