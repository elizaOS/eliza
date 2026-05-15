import crypto from "crypto";

export const PLAYWRIGHT_TEST_SESSION_COOKIE_NAME = "eliza-test-session";
const PLAYWRIGHT_TEST_SESSION_TTL_SECONDS = 60 * 60;

export type PlaywrightTestSessionClaims = {
  userId: string;
  organizationId: string;
  exp: number;
};

export type PlaywrightTestAuthEnv = {
  NODE_ENV?: string;
  PLAYWRIGHT_TEST_AUTH?: string;
  PLAYWRIGHT_TEST_AUTH_SECRET?: string;
};

export function isPlaywrightTestAuthEnabled(env: PlaywrightTestAuthEnv = process.env): boolean {
  return env.PLAYWRIGHT_TEST_AUTH === "true";
}

function getPlaywrightTestAuthSecret(env: PlaywrightTestAuthEnv = process.env): string | null {
  const secret = env.PLAYWRIGHT_TEST_AUTH_SECRET?.trim();
  return secret && secret.length >= 16 ? secret : null;
}

export function createPlaywrightTestSessionToken(
  userId: string,
  organizationId: string,
  env: PlaywrightTestAuthEnv = process.env,
): string {
  const secret = getPlaywrightTestAuthSecret(env);
  if (!isPlaywrightTestAuthEnabled(env) || !secret) {
    throw new Error("Playwright test auth is not enabled");
  }

  const claims: PlaywrightTestSessionClaims = {
    userId,
    organizationId,
    exp: Math.floor(Date.now() / 1000) + PLAYWRIGHT_TEST_SESSION_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyPlaywrightTestSessionToken(
  token: string,
  env: PlaywrightTestAuthEnv = process.env,
): PlaywrightTestSessionClaims | null {
  const secret = getPlaywrightTestAuthSecret(env);
  if (!isPlaywrightTestAuthEnabled(env) || !secret) {
    return null;
  }

  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return null;
  }

  const expectedSignature = crypto.createHmac("sha256", secret).update(payload).digest();
  const receivedSignature = Buffer.from(signature, "base64url");

  if (
    expectedSignature.length !== receivedSignature.length ||
    !crypto.timingSafeEqual(expectedSignature, receivedSignature)
  ) {
    return null;
  }

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as
      | PlaywrightTestSessionClaims
      | undefined;

    if (!claims?.userId || !claims.organizationId || !claims.exp) {
      return null;
    }

    if (claims.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    return claims;
  } catch {
    return null;
  }
}
