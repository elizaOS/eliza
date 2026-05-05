import { afterEach, describe, expect, test } from "bun:test";
import {
  createPlaywrightTestSessionToken,
  isPlaywrightTestAuthEnabled,
  verifyPlaywrightTestSessionToken,
} from "../../lib/auth/playwright-test-session";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

describe("Playwright test session auth", () => {
  afterEach(() => {
    resetEnv();
  });

  test("creates and verifies a signed test session", () => {
    process.env.PLAYWRIGHT_TEST_AUTH = "true";
    process.env.PLAYWRIGHT_TEST_AUTH_SECRET = "playwright-unit-test-secret";

    expect(isPlaywrightTestAuthEnabled()).toBe(true);

    const token = createPlaywrightTestSessionToken("user-1", "org-1");
    const claims = verifyPlaywrightTestSessionToken(token);

    expect(claims?.userId).toBe("user-1");
    expect(claims?.organizationId).toBe("org-1");
    expect(claims?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test("rejects tampered tokens", () => {
    process.env.PLAYWRIGHT_TEST_AUTH = "true";
    process.env.PLAYWRIGHT_TEST_AUTH_SECRET = "playwright-unit-test-secret";

    const token = createPlaywrightTestSessionToken("user-1", "org-1");
    const tampered = `${token}tampered`;

    expect(verifyPlaywrightTestSessionToken(tampered)).toBeNull();
  });

  test("does not issue tokens when the feature flag is disabled", () => {
    process.env.PLAYWRIGHT_TEST_AUTH = "false";
    process.env.PLAYWRIGHT_TEST_AUTH_SECRET = "playwright-unit-test-secret";

    expect(() => createPlaywrightTestSessionToken("user-1", "org-1")).toThrow(
      "Playwright test auth is not enabled",
    );
    expect(verifyPlaywrightTestSessionToken("invalid")).toBeNull();
  });
});
