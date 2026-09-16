/**
 * Renderer-level proof of the Steward JWT token lifecycle. It covers both a
 * near-expiry readable token and a warm tab whose readable token disappeared
 * while its HttpOnly cookie session remains authoritative.
 *
 * The real path under test lives in `useCloudState`'s token-lifecycle effect
 * (packages/ui/src/state/useCloudState.ts): while a stored Steward JWT is
 * within `STEWARD_REFRESH_AHEAD_SECS` of expiry it POSTs the same-origin
 * `/api/auth/steward-refresh` endpoint and mirrors the rotated access token
 * back into localStorage via `writeStoredStewardToken`. The cloud API is faked
 * so the renderer drives the whole exchange.
 */

import { STEWARD_SESSION_CHANGE_EVENT } from "@elizaos/shared/steward-session-client";
import { expect, type Route, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  openAppPath,
  readLocalStorage,
  seedAppStorage,
} from "./helpers";
import {
  createStewardSessionToken,
  STEWARD_SESSION_TOKEN_KEY,
  seedStewardSession,
} from "./helpers/test-auth";

const VOICE_PREFIX_DONE_STORAGE_KEY = "eliza:voice:prefix-done";
const STEWARD_REFRESH_ENDPOINT = "**/api/auth/steward-refresh";
const CLOUD_USER_ID = "ui-smoke-token-expiry-user";

async function fulfillJson(
  route: Route,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

test("cloud session survives a mid-suite JWT expiry by renewing the token", async ({
  page,
}) => {
  // The renewed token the refresh endpoint hands back: a decodable JWT that is
  // comfortably beyond the refresh-ahead window, so the lifecycle no-ops after
  // this one rotation.
  const renewedToken = createStewardSessionToken({
    jwt: true,
    subject: CLOUD_USER_ID,
    userId: CLOUD_USER_ID,
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });

  let refreshRequests = 0;
  let refreshRequestHeaders: Record<string, string> | null = null;
  await page.route(STEWARD_REFRESH_ENDPOINT, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    refreshRequests += 1;
    refreshRequestHeaders = route.request().headers();
    await fulfillJson(route, 200, { token: renewedToken, expiresIn: 3_600 });
  });

  await installDefaultAppRoutes(page);
  await page.route("**/api/cloud/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      connected: true,
      enabled: true,
      cloudVoiceProxyAvailable: true,
      hasApiKey: true,
      userId: CLOUD_USER_ID,
    });
  });
  await page.route("**/api/cloud/credits", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      balance: 100,
      low: false,
      critical: false,
      authRejected: false,
    });
  });

  await seedAppStorage(page, {
    [VOICE_PREFIX_DONE_STORAGE_KEY]: "1",
    "eliza:mobile-runtime-mode": "cloud",
  });

  // Seed a genuinely near-expiry JWT: inside the refresh-ahead window
  // (STEWARD_REFRESH_AHEAD_SECS = 120) so the lifecycle effect must renew it on
  // mount rather than let the authenticated connection expire.
  const seededToken = await seedStewardSession(page, {
    jwt: true,
    subject: CLOUD_USER_ID,
    userId: CLOUD_USER_ID,
    exp: Math.floor(Date.now() / 1000) + 30,
  });

  await openAppPath(page, "/", { allowOnboardingToast: true });

  // The refresh network exchange fires and the rotated token replaces the
  // near-expiry one in the canonical Steward localStorage slot.
  await expect
    .poll(() => refreshRequests, { timeout: 30_000 })
    .toBeGreaterThan(0);
  expect(refreshRequestHeaders?.["x-eliza-csrf"]).toBe("1");
  expect(refreshRequestHeaders?.["content-type"]).toBe("application/json");
  await expect
    .poll(
      () =>
        page.evaluate(
          (key) => localStorage.getItem(key),
          STEWARD_SESSION_TOKEN_KEY,
        ),
      { timeout: 30_000 },
    )
    .toBe(renewedToken);
  expect(renewedToken).not.toBe(seededToken);

  // The suite continues past the expiry: re-navigating boots cleanly on the
  // renewed session, and no auth-rejected notice surfaced.
  await openAppPath(page, "/settings");
  await expect(page.getByText(/auth.*rejected|session expired/i)).toHaveCount(
    0,
  );
});

test("warm shared-cloud tab recovers its cookie-only session without dropping the binding", async ({
  page,
}) => {
  const agentId = "19127000-0000-4000-8000-000000000001";
  const apiBase = `https://api.eliza.app/api/v1/eliza/agents/${agentId}`;
  const initialToken = createStewardSessionToken({
    jwt: true,
    subject: CLOUD_USER_ID,
    userId: CLOUD_USER_ID,
  });
  const refreshedToken = createStewardSessionToken({
    jwt: true,
    subject: `${CLOUD_USER_ID}-refreshed`,
    userId: CLOUD_USER_ID,
  });
  let refreshRequests = 0;

  await page.route(STEWARD_REFRESH_ENDPOINT, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    refreshRequests += 1;
    await fulfillJson(route, 200, { token: refreshedToken, expiresIn: 3_600 });
  });
  await installDefaultAppRoutes(page);
  await seedStewardSession(page, { token: initialToken });
  await seedAppStorage(page, {
    [VOICE_PREFIX_DONE_STORAGE_KEY]: "1",
    "eliza:mobile-runtime-mode": "cloud",
    "eliza:ui-shell-mode": "web",
    "elizaos:active-server": JSON.stringify({
      id: `cloud:${agentId}`,
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase,
      accessToken: "shared-agent-token",
    }),
  });

  await openAppPath(page, "/settings");
  await expect
    .poll(async () => {
      const raw = await readLocalStorage(page, "elizaos:active-server");
      return raw ? JSON.parse(raw) : null;
    })
    .toMatchObject({ id: `cloud:${agentId}`, apiBase });
  await page
    .context()
    .addCookies([
      { name: "steward-authed", value: "1", url: page.url(), sameSite: "Lax" },
    ]);
  await page.evaluate(
    ({ eventName, tokenKey }) => {
      localStorage.removeItem(tokenKey);
      window.dispatchEvent(
        new CustomEvent(eventName, { detail: { state: "present" } }),
      );
    },
    {
      eventName: STEWARD_SESSION_CHANGE_EVENT,
      tokenKey: STEWARD_SESSION_TOKEN_KEY,
    },
  );
  await expect
    .poll(() => page.evaluate(() => document.cookie))
    .toContain("steward-authed=1");

  await expect.poll(() => refreshRequests).toBe(1);
  await expect
    .poll(() => readLocalStorage(page, STEWARD_SESSION_TOKEN_KEY))
    .toBe(refreshedToken);
  await expect
    .poll(async () => {
      const raw = await readLocalStorage(page, "elizaos:active-server");
      return raw ? JSON.parse(raw) : null;
    })
    .toMatchObject({
      id: `cloud:${agentId}`,
      apiBase,
      accessToken: "shared-agent-token",
    });
  await expect(page.getByTestId("settings-shell")).toBeVisible();
  await expect(page.getByText(/auth.*rejected|session expired/i)).toHaveCount(
    0,
  );
  await expectNoPageDiagnostics(page, "cookie-only warm shared-cloud auth");
});
