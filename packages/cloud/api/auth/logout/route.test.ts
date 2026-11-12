/**
 * Logout keeps credentials only when revocation infrastructure is down. A
 * token this deployment can never accept (here: signed with RS256 instead of
 * the HS256 session key) is a rejected credential, so the cookies must clear.
 */
import { expect, test } from "bun:test";

process.env.MOCK_REDIS = "1";

const { generateKeyPair, SignJWT } = await import("jose");
const { LEGACY_STEWARD_COOKIES } = await import(
  "@elizaos/cloud-shared/lib/auth/steward-cookies"
);
const { default: app } = await import("./route");

const env = {
  NODE_ENV: "test",
  STEWARD_JWT_SECRET: "logout-route-test-secret-0123456789abcdef",
};

test("logout with an RS256 cookie clears credentials", async () => {
  const { privateKey } = await generateKeyPair("RS256");
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ userId: "steward-user-logout" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setSubject("steward-user-logout")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const response = await app.request(
    "https://cloud.test/",
    {
      method: "POST",
      headers: {
        host: "cloud.test",
        origin: "https://cloud.test",
        cookie: `${LEGACY_STEWARD_COOKIES.token}=${token}`,
      },
    },
    env,
  );

  expect(response.status).toBe(200);
  const cleared = response.headers.getSetCookie().join("\n");
  expect(cleared).toContain(`${LEGACY_STEWARD_COOKIES.token}=;`);
  expect(cleared).toContain(`${LEGACY_STEWARD_COOKIES.refreshToken}=;`);
});
