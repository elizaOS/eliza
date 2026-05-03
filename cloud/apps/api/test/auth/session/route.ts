/**
 * POST /api/test/auth/session
 * Playwright-only helper: exchanges an API key for a short-lived test
 * session cookie. Disabled outside test runs.
 */

import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import {
  createPlaywrightTestSessionToken,
  PLAYWRIGHT_TEST_SESSION_COOKIE_NAME,
  type PlaywrightTestAuthEnv,
} from "@/lib/auth/playwright-test-session";
import { apiKeysService } from "@/lib/services/api-keys";
import { usersService } from "@/lib/services/users";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

function isEnabled(c: AppContext): boolean {
  return c.env.PLAYWRIGHT_TEST_AUTH === "true";
}

function testAuthEnv(c: AppContext): PlaywrightTestAuthEnv {
  return {
    PLAYWRIGHT_TEST_AUTH:
      typeof c.env.PLAYWRIGHT_TEST_AUTH === "string" ? c.env.PLAYWRIGHT_TEST_AUTH : undefined,
    PLAYWRIGHT_TEST_AUTH_SECRET:
      typeof c.env.PLAYWRIGHT_TEST_AUTH_SECRET === "string"
        ? c.env.PLAYWRIGHT_TEST_AUTH_SECRET
        : undefined,
  };
}

function getApiKeyFromRequest(c: AppContext): string | null {
  const apiKeyHeader = c.req.header("x-api-key")?.trim();
  if (apiKeyHeader) return apiKeyHeader;
  const authHeader = c.req.header("authorization")?.trim();
  if (authHeader?.startsWith("Bearer ")) {
    const t = authHeader.slice(7).trim();
    return t || null;
  }
  return null;
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  if (!isEnabled(c)) return c.json({ error: "Not found" }, 404);

  const apiKeyValue = getApiKeyFromRequest(c);
  if (!apiKeyValue) return c.json({ error: "API key required" }, 401);

  const apiKey = await apiKeysService.validateApiKey(apiKeyValue);
  if (!apiKey) return c.json({ error: "Invalid API key" }, 401);
  if (!apiKey.is_active) return c.json({ error: "API key is inactive" }, 403);
  if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
    return c.json({ error: "API key has expired" }, 401);
  }

  const user = await usersService.getWithOrganization(apiKey.user_id);
  if (!user || !user.organization_id || !user.organization) {
    return c.json({ error: "User organization not found" }, 403);
  }
  if (!user.is_active || !user.organization.is_active) {
    return c.json({ error: "User or organization is inactive" }, 403);
  }

  const token = createPlaywrightTestSessionToken(user.id, user.organization_id, testAuthEnv(c));

  const url = new URL(c.req.url);
  setCookie(c, PLAYWRIGHT_TEST_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: url.protocol === "https:",
    path: "/",
    maxAge: 60 * 60,
  });

  return c.json(
    {
      token,
      cookieName: PLAYWRIGHT_TEST_SESSION_COOKIE_NAME,
      user: { id: user.id, organizationId: user.organization_id },
    },
    200,
    { "Cache-Control": "no-store" },
  );
});

export default app;
