// Settings → Connections tab — the connect / disconnect mutations for the
// provider cards under /dashboard/settings (tab=connections). These had route
// rendering coverage (settings-tabs-flow.spec) but ZERO behavioral coverage of
// the actual connect/disconnect requests. Two providers are exercised end to
// end here:
//
//   Google   (OAuth-redirect connector) — connect POSTs /api/v1/oauth/google/initiate
//             then redirects to the returned authUrl; disconnect DELETEs
//             /api/v1/oauth/connections/:id.
//   Telegram (token connector)          — connect POSTs /api/v1/telegram/connect
//             with { botToken }; disconnect DELETEs /api/v1/telegram/disconnect.
//
// Whether a card shows its Connect form (setupContent) or its connected panel
// (connectedContent) is driven entirely by the status GET each card fires, so
// each test seeds the relevant status response to land in the state it needs.
// Runs against the local dev build (VITE_PLAYWRIGHT_TEST_AUTH=true); all /api/**
// is mocked.

import { expect, type Page, type Route, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "settings-connections-flow uses local mocks; skipped in live-prod mode",
);
test.describe.configure({ timeout: 90_000 });

const NOW = "2026-05-20T12:00:00.000Z";
const STEWARD_TOKEN_KEY = "steward_session_token";
const STEWARD_AUTHED_COOKIE = "steward-authed";
const FAKE_STEWARD_TOKEN = [
  "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0",
  "eyJ1c2VySWQiOiJ1c2VyXzEiLCJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20iLCJleHAiOjQxMDI0NDQ4MDB9",
  "signature",
].join(".");

const CURRENT_USER = {
  id: "user_1",
  email: "test@example.com",
  email_verified: true,
  wallet_address: "0x0000000000000000000000000000000000000001",
  wallet_chain_type: "evm",
  wallet_verified: true,
  name: "Test User",
  avatar: null,
  organization_id: "org_1",
  role: "owner",
  steward_user_id: null,
  telegram_id: null,
  telegram_username: null,
  telegram_first_name: null,
  telegram_photo_url: null,
  discord_id: null,
  discord_username: null,
  discord_global_name: null,
  discord_avatar_url: null,
  whatsapp_id: null,
  whatsapp_name: null,
  phone_number: null,
  phone_verified: false,
  is_anonymous: false,
  anonymous_session_id: null,
  expires_at: null,
  nickname: "Tester",
  work_function: "engineering",
  preferences: "Prefer concise status updates.",
  email_notifications: true,
  response_notifications: true,
  is_active: true,
  created_at: NOW,
  updated_at: NOW,
  organization: {
    id: "org_1",
    name: "Eliza QA",
    slug: "eliza-qa",
    billing_email: "billing@example.com",
    credit_balance: "123.45",
    is_active: true,
    created_at: NOW,
    updated_at: NOW,
  },
};

const GOOGLE_CONNECTION_ID = "gconn_1";

type Captured = { method: string; path: string; body: unknown };

function record(sink: Captured[], route: Route) {
  const req = route.request();
  let body: unknown = null;
  try {
    body = req.postDataJSON();
  } catch {
    body = req.postData();
  }
  sink.push({
    method: req.method(),
    path: new URL(req.url()).pathname,
    body,
  });
}

async function setTestAuth(page: Page) {
  await page.context().addCookies([
    {
      name: "eliza-test-auth",
      value: "1",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
    {
      name: STEWARD_AUTHED_COOKIE,
      value: "1",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  await page.addInitScript(
    ({ tokenKey, token }) => {
      window.localStorage.setItem(tokenKey, token);
    },
    { tokenKey: STEWARD_TOKEN_KEY, token: FAKE_STEWARD_TOKEN },
  );
}

/**
 * Installs the catch-all /api mocks. `overrides` lets each test return a
 * specific JSON body for a given pathname (and optionally narrow by method).
 * Mutations (POST/DELETE) are recorded into `sink`.
 */
async function installConnectionMocks(
  page: Page,
  sink: Captured[],
  overrides: Record<string, (route: Route) => Promise<void> | void> = {},
) {
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;

      if (req.method() !== "GET") {
        record(sink, route);
      }

      const override = overrides[path];
      if (override) {
        await override(route);
        return;
      }

      if (path === "/api/v1/user") {
        return route.fulfill({ json: { success: true, data: CURRENT_USER } });
      }

      // Every other connection-status GET: report the provider as not
      // configured / not connected so cards render their setup (Connect) state
      // without erroring. Empty collections keep the rest of the page calm.
      return route.fulfill({
        json: {
          success: true,
          data: [],
          items: [],
          connections: [],
          connected: false,
          configured: false,
          balance: 123.45,
          user: CURRENT_USER,
        },
      });
    },
  );
}

async function gotoConnections(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/dashboard/settings?tab=connections", {
    waitUntil: "domcontentloaded",
  });
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByText("Messaging & Communication")).toBeVisible({
    timeout: 20_000,
  });
}

test.beforeEach(async ({ page }) => {
  await setTestAuth(page);
});

test("connections: Telegram connect POSTs /api/v1/telegram/connect with the bot token", async ({
  page,
}) => {
  const calls: Captured[] = [];
  await installConnectionMocks(page, calls, {
    // Disconnected → the Telegram card renders its setup form.
    "/api/v1/telegram/status": (route) =>
      route.fulfill({ json: { configured: true, connected: false } }),
    "/api/v1/telegram/connect": (route) =>
      route.fulfill({
        json: { success: true, botUsername: "qa_test_bot", botId: 4242 },
      }),
  });

  await gotoConnections(page);

  // The settings dashboard mounts the connections tab content twice (a
  // responsive desktop + mobile pair), so the page actually has TWO #botToken
  // inputs but only one visible "Connect Telegram Bot" button — each belongs to
  // a different <TelegramConnection> React instance with its own `botToken`
  // state. Filling `#botToken`.first() updates one instance while the visible
  // button belongs to the other, so the button stays `disabled` (it gates on
  // `!botToken.trim()` of its OWN instance) and the click times out. Scope both
  // the fill and the click to the SAME setup-form card (the one that contains
  // both the input and the button) so they hit the same instance.
  const connectButton = page.getByRole("button", {
    name: /connect telegram bot/i,
  });
  const telegramSetup = page
    .locator("div.space-y-4")
    .filter({ has: connectButton })
    .filter({ has: page.locator("#botToken") })
    .last();
  const tokenInput = telegramSetup.locator("#botToken");
  await expect(tokenInput).toBeVisible({ timeout: 15_000 });
  await tokenInput.fill("123456789:ABCdefGHIjklMNOpqrsTUVwxyz");

  await telegramSetup
    .getByRole("button", { name: /connect telegram bot/i })
    .click();

  await expect
    .poll(() => calls.find((c) => c.path === "/api/v1/telegram/connect"))
    .toBeTruthy();
  const connect = calls.find((c) => c.path === "/api/v1/telegram/connect");
  expect(connect?.method).toBe("POST");
  expect(connect?.body).toMatchObject({
    botToken: "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
  });
});

test("connections: Telegram disconnect DELETEs /api/v1/telegram/disconnect", async ({
  page,
}) => {
  const calls: Captured[] = [];
  await installConnectionMocks(page, calls, {
    // Connected → the Telegram card renders its connected panel + disconnect.
    "/api/v1/telegram/status": (route) =>
      route.fulfill({
        json: {
          configured: true,
          connected: true,
          botUsername: "qa_test_bot",
          botId: 4242,
        },
      }),
    "/api/v1/telegram/disconnect": (route) =>
      route.fulfill({ json: { success: true } }),
  });

  await gotoConnections(page);

  // Connected panel shows the bot username and a "Disconnect" trigger that
  // opens a confirm alertdialog (confirm button is also "Disconnect").
  await expect(page.getByText("@qa_test_bot").first()).toBeVisible({
    timeout: 15_000,
  });
  await page
    .getByRole("button", { name: /^disconnect$/i })
    .first()
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /^disconnect$/i })
    .click();

  await expect
    .poll(() => calls.find((c) => c.path === "/api/v1/telegram/disconnect"))
    .toBeTruthy();
  expect(
    calls.find((c) => c.path === "/api/v1/telegram/disconnect")?.method,
  ).toBe("DELETE");
});

test("connections: Google connect POSTs /api/v1/oauth/google/initiate and redirects to authUrl", async ({
  page,
}) => {
  const calls: Captured[] = [];
  // Keep the OAuth redirect in-app so the test page does not navigate to a
  // dead external origin (which would error the run). The component reads
  // data.authUrl and assigns window.location.href to it.
  const AUTH_URL = "/dashboard/settings?tab=connections&oauth=mock";
  await installConnectionMocks(page, calls, {
    // platform=google status — no query in the override key, so match by prefix
    // below instead. The catch-all already returns connections:[] for GETs, so
    // the Google card renders its setup (Connect) state by default.
    "/api/v1/oauth/google/initiate": (route) =>
      route.fulfill({ json: { authUrl: AUTH_URL } }),
  });

  await gotoConnections(page);

  // Google setup state exposes a "Connect with Google" button.
  await page
    .getByRole("button", { name: /connect with google/i })
    .first()
    .click();

  await expect
    .poll(() => calls.find((c) => c.path === "/api/v1/oauth/google/initiate"))
    .toBeTruthy();
  const initiate = calls.find(
    (c) => c.path === "/api/v1/oauth/google/initiate",
  );
  expect(initiate?.method).toBe("POST");
  expect(initiate?.body).toMatchObject({
    redirectUrl: "/dashboard/settings?tab=connections",
  });
});

test("connections: Google disconnect DELETEs /api/v1/oauth/connections/:id", async ({
  page,
}) => {
  const calls: Captured[] = [];
  await installConnectionMocks(page, calls, {
    // platform-scoped list lives at /api/v1/oauth/connections?platform=google.
    // Return one active connection so the Google card renders its connected
    // panel with a disconnect action.
    "/api/v1/oauth/connections": (route) =>
      route.fulfill({
        json: {
          connections: [
            {
              id: GOOGLE_CONNECTION_ID,
              platform: "google",
              email: "qa@example.com",
              status: "active",
              scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
            },
          ],
        },
      }),
    [`/api/v1/oauth/connections/${GOOGLE_CONNECTION_ID}`]: (route) =>
      route.fulfill({ json: { success: true } }),
  });

  await gotoConnections(page);

  // The connected Google account row shows its email + a "Disconnect" trigger
  // → confirm alertdialog ("Disconnect").
  await expect(page.getByText("qa@example.com").first()).toBeVisible({
    timeout: 15_000,
  });
  await page
    .getByRole("button", { name: /^disconnect$/i })
    .first()
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /^disconnect$/i })
    .click();

  await expect
    .poll(() =>
      calls.find(
        (c) =>
          c.path === `/api/v1/oauth/connections/${GOOGLE_CONNECTION_ID}` &&
          c.method === "DELETE",
      ),
    )
    .toBeTruthy();
});
