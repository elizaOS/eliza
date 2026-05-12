import { type APIRequestContext, type BrowserContext, expect, test } from "@playwright/test";
import { ensureLocalTestAuth } from "../../infrastructure/local-test-auth";

const PLAYWRIGHT_TEST_AUTH_MARKER_COOKIE_NAME = "eliza-test-auth";
const STEWARD_AUTHED_COOKIE_NAME = "steward-authed";
const STEWARD_TOKEN_KEY = "steward_session_token";

function resolveBaseUrl(baseUrl?: string): URL {
  return new URL(baseUrl || process.env.TEST_BASE_URL || "http://localhost:3000");
}

export async function authenticateBrowserContext(
  _request: APIRequestContext,
  context: BrowserContext,
  baseUrl?: string,
): Promise<void> {
  const auth = await ensureLocalTestAuth();
  const url = resolveBaseUrl(baseUrl);

  await context.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
      window.dispatchEvent(new CustomEvent("steward-token-sync"));
    },
    { key: STEWARD_TOKEN_KEY, value: auth.sessionToken },
  );

  await context.addCookies([
    {
      name: auth.sessionCookieName,
      value: auth.sessionToken,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: url.protocol === "https:",
    },
    {
      name: STEWARD_AUTHED_COOKIE_NAME,
      value: "1",
      domain: url.hostname,
      path: "/",
      httpOnly: false,
      sameSite: "Lax",
      secure: url.protocol === "https:",
    },
    {
      name: PLAYWRIGHT_TEST_AUTH_MARKER_COOKIE_NAME,
      value: "1",
      domain: url.hostname,
      path: "/",
      httpOnly: false,
      sameSite: "Lax",
      secure: url.protocol === "https:",
    },
  ]);
}

export { expect, test };
