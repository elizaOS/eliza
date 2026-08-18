/**
 * Exercises the Playwright session exchange route's production kill switch
 * through the real Hono handler; persistence collaborators are mocked because
 * production must reject before an API-key lookup.
 */

import { expect, mock, test } from "bun:test";

const validateApiKey = mock(async () => {
  throw new Error("production gate must run before API-key validation");
});
const getWithOrganization = mock(async () => {
  throw new Error("production gate must run before user hydration");
});

mock.module("@/lib/services/api-keys", () => ({
  apiKeysService: { validateApiKey },
}));
mock.module("@/lib/services/users", () => ({
  usersService: { getWithOrganization },
}));

const { default: app } = await import("../test/auth/session/route");

test.each([{ NODE_ENV: "production" }, { ENVIRONMENT: "production" }])(
  "test-session exchange is unavailable in production (%o)",
  async (productionEnv) => {
    const response = await app.request(
      "https://api.eliza.app/",
      {
        method: "POST",
        headers: { authorization: "Bearer eliza_test_key" },
      },
      {
        ...productionEnv,
        PLAYWRIGHT_TEST_AUTH: "true",
        PLAYWRIGHT_TEST_AUTH_SECRET: "0123456789abcdef", // gitleaks:allow synthetic HMAC fixture
      },
    );

    expect(response.status).toBe(404);
    expect(validateApiKey).not.toHaveBeenCalled();
    expect(getWithOrganization).not.toHaveBeenCalled();
  },
);
