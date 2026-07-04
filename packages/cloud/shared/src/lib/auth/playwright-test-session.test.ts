// Exercises playwright test session behavior with deterministic cloud-shared lib fixtures.
import crypto from "crypto";
import { describe, expect, it } from "vitest";
import {
  createPlaywrightTestSessionToken,
  isPlaywrightTestAuthEnabled,
  type PlaywrightTestAuthEnv,
  verifyPlaywrightTestSessionToken,
} from "./playwright-test-session";

const env = {
  PLAYWRIGHT_TEST_AUTH: "true",
  PLAYWRIGHT_TEST_AUTH_SECRET: "0123456789abcdef",
} satisfies PlaywrightTestAuthEnv;

function signPayload(claims: unknown, testEnv: PlaywrightTestAuthEnv = env): string {
  const secret = testEnv.PLAYWRIGHT_TEST_AUTH_SECRET;
  if (!secret) throw new Error("missing test secret");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

describe("playwright test session auth", () => {
  it("round trips enabled test session tokens", () => {
    const token = createPlaywrightTestSessionToken("user-1", "org-1", env);

    expect(verifyPlaywrightTestSessionToken(token, env)).toMatchObject({
      userId: "user-1",
      organizationId: "org-1",
    });
  });

  it("is disabled unless the explicit test-auth flag is true", () => {
    expect(isPlaywrightTestAuthEnabled({ PLAYWRIGHT_TEST_AUTH: "false" })).toBe(false);
    expect(() =>
      createPlaywrightTestSessionToken("user-1", "org-1", {
        ...env,
        PLAYWRIGHT_TEST_AUTH: "false",
      }),
    ).toThrow("Playwright test auth is not enabled");
    expect(verifyPlaywrightTestSessionToken(signPayload({ userId: "user-1" }), {})).toBeNull();
  });

  it("rejects weak secrets", () => {
    const weakEnv = {
      PLAYWRIGHT_TEST_AUTH: "true",
      PLAYWRIGHT_TEST_AUTH_SECRET: "too-short",
    } satisfies PlaywrightTestAuthEnv;

    expect(() => createPlaywrightTestSessionToken("user-1", "org-1", weakEnv)).toThrow(
      "Playwright test auth is not enabled",
    );
    expect(verifyPlaywrightTestSessionToken("payload.signature", weakEnv)).toBeNull();
  });

  it("rejects tampered, multi-part, and malformed tokens", () => {
    const token = createPlaywrightTestSessionToken("user-1", "org-1", env);
    const [payload, signature] = token.split(".");

    expect(verifyPlaywrightTestSessionToken(`${payload}.tampered`, env)).toBeNull();
    expect(verifyPlaywrightTestSessionToken(`${payload}.${signature}.extra`, env)).toBeNull();
    expect(verifyPlaywrightTestSessionToken("not-a-token", env)).toBeNull();
  });

  it("rejects expired tokens and non-string required claims", () => {
    expect(
      verifyPlaywrightTestSessionToken(
        signPayload({
          userId: "user-1",
          organizationId: "org-1",
          exp: Math.floor(Date.now() / 1000) - 1,
        }),
        env,
      ),
    ).toBeNull();

    expect(
      verifyPlaywrightTestSessionToken(
        signPayload({
          userId: 123,
          organizationId: "org-1",
          exp: Math.floor(Date.now() / 1000) + 60,
        }),
        env,
      ),
    ).toBeNull();
    expect(
      verifyPlaywrightTestSessionToken(
        signPayload({
          userId: "user-1",
          organizationId: "org-1",
          exp: "soon",
        }),
        env,
      ),
    ).toBeNull();
  });
});
