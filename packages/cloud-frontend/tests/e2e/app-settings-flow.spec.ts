// App detail → Settings tab (/dashboard/apps/:id?tab=settings) — the write
// flows in app-settings.tsx that had no behavioral coverage:
//
//   Save              → PUT /api/v1/apps/:id  { name, app_url, allowed_origins, ... }
//   Regenerate key    → POST /api/v1/apps/:id/regenerate-api-key (confirm dialog)
//   Allowed origins   → add + remove an origin, Save, assert the PUT body carries
//                       the updated allowed_origins array.
//
// (Delete is already covered by app-delete-flow.spec via the apps-list row
// action, so it is not repeated here.) The page redirects unless :id is a valid
// UUID, so a real v4 UUID is used. Runs against the local dev build
// (VITE_PLAYWRIGHT_TEST_AUTH=true); all /api/** is mocked.

import { expect, type Page, type Route, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "app-settings-flow uses local mocks; skipped in live-prod mode",
);
test.describe.configure({ timeout: 90_000 });

const APP_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-05-20T12:00:00.000Z";
const NEW_API_KEY = "eliza_app_pk_REGENERATED_DO_NOT_USE";

// A complete-enough App record for the GET /api/v1/apps/:id render. app-settings
// reads name, description, app_url, website_url, contact_email, is_active,
// allowed_origins, and id.
function existingApp() {
  return {
    id: APP_ID,
    name: "Settings App",
    description: "An app under test",
    slug: "settings-app",
    organization_id: "org_1",
    created_by_user_id: "user_1",
    app_url: "https://settings-app.example.com",
    allowed_origins: ["https://origin-seed.example.com"],
    api_key_id: "key_1",
    affiliate_code: null,
    referral_bonus_credits: null,
    total_requests: 0,
    total_users: 0,
    total_credits_used: null,
    logo_url: null,
    website_url: "https://settings-app.example.com",
    contact_email: "owner@example.com",
    metadata: {},
    deployment_status: "draft",
    production_url: null,
    last_deployed_at: null,
    github_repo: null,
    linked_character_ids: null,
    monetization_enabled: false,
    inference_markup_percentage: null,
    purchase_share_percentage: null,
    platform_offset_amount: null,
    custom_pricing_enabled: null,
    total_creator_earnings: null,
    total_platform_revenue: null,
    discord_automation: null,
    telegram_automation: null,
    twitter_automation: null,
    promotional_assets: null,
    email_notifications: null,
    response_notifications: null,
    is_active: true,
    is_approved: true,
    created_at: NOW,
    updated_at: NOW,
    last_used_at: null,
  };
}

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

async function installAppMocks(page: Page, sink: Captured[]) {
  // Regenerate is a more specific path than the :id route — register first.
  await page.route("**/api/v1/apps/*/regenerate-api-key", async (route) => {
    record(sink, route);
    return route.fulfill({ json: { success: true, apiKey: NEW_API_KEY } });
  });

  await page.route("**/api/v1/apps/*", async (route) => {
    const req = route.request();
    if (req.method() === "PUT") {
      record(sink, route);
      return route.fulfill({ json: { success: true, app: existingApp() } });
    }
    if (req.method() === "DELETE") {
      record(sink, route);
      return route.fulfill({ json: { success: true } });
    }
    // GET /api/v1/apps/:id → single app record.
    return route.fulfill({ json: { app: existingApp() } });
  });

  await page.route("**/api/v1/apps", (route) =>
    route.fulfill({ json: { apps: [existingApp()] } }),
  );

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith("/api/v1/apps")) return route.fallback();
      return route.fulfill({
        json: { success: true, data: [], items: [], apps: [], balance: 100 },
      });
    },
  );
}

async function gotoSettingsTab(page: Page) {
  await page.goto(`/dashboard/apps/${APP_ID}?tab=settings`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page).not.toHaveURL(/\/dashboard\/apps$/);

  // The first-run onboarding tour overlays the apps pages and intercepts clicks.
  await page
    .getByRole("button", { name: /skip tour/i })
    .first()
    .click({ timeout: 8000 })
    .catch(() => {});

  // The app_url input is unique to the settings tab — wait for it.
  await expect(page.locator("#app_url").first()).toBeVisible({
    timeout: 20_000,
  });
}

test.beforeEach(async ({ context, browserName }) => {
  await context.addCookies([
    {
      name: "eliza-test-auth",
      value: "1",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  if (browserName === "chromium") {
    const origin = new URL(
      process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:4173",
    ).origin;
    await context
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin })
      .catch(() => {});
  }
});

test("app-settings: Save PUTs /api/v1/apps/:id with the edited fields", async ({
  page,
}) => {
  const calls: Captured[] = [];
  await installAppMocks(page, calls);
  await gotoSettingsTab(page);

  // Edit name + app_url, then Save.
  await page.locator("#name").first().fill("Renamed Settings App");
  await page.locator("#app_url").first().fill("https://renamed.example.com");

  await page
    .getByRole("button", { name: /save changes/i })
    .first()
    .click();

  await expect
    .poll(() =>
      calls.find(
        (c) => c.path === `/api/v1/apps/${APP_ID}` && c.method === "PUT",
      ),
    )
    .toBeTruthy();
  const put = calls.find(
    (c) => c.path === `/api/v1/apps/${APP_ID}` && c.method === "PUT",
  );
  expect(put?.body).toMatchObject({
    name: "Renamed Settings App",
    app_url: "https://renamed.example.com",
    allowed_origins: ["https://origin-seed.example.com"],
  });
});

test("app-settings: Regenerate API key POSTs /api/v1/apps/:id/regenerate-api-key", async ({
  page,
}) => {
  const calls: Captured[] = [];
  await installAppMocks(page, calls);
  await gotoSettingsTab(page);

  // Danger zone "Regenerate" trigger → confirm alertdialog
  // ("Regenerate API Key").
  await page
    .getByRole("button", { name: /^regenerate$/i })
    .first()
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /regenerate api key/i })
    .click();

  await expect
    .poll(() => calls.find((c) => c.path.endsWith("/regenerate-api-key")))
    .toBeTruthy();
  const regen = calls.find((c) => c.path.endsWith("/regenerate-api-key"));
  expect(regen?.method).toBe("POST");
  expect(regen?.path).toBe(`/api/v1/apps/${APP_ID}/regenerate-api-key`);

  // On success the component routes to the overview tab (where the one-time key
  // surfaces). Assert we landed there.
  await expect(page).toHaveURL(/tab=overview/, { timeout: 10_000 });
});

test("app-settings: add + remove an allowed origin, Save sends the updated allowed_origins", async ({
  page,
}) => {
  const calls: Captured[] = [];
  await installAppMocks(page, calls);
  await gotoSettingsTab(page);

  // The Allowed Origins section has a text input + a "+" icon button. Add a new
  // origin; it appears as a removable Badge.
  const originInput = page.getByPlaceholder("https://example.com").first();
  await originInput.fill("https://added.example.com");
  await originInput.press("Enter");
  await expect(page.getByText("https://added.example.com")).toBeVisible({
    timeout: 10_000,
  });

  // Remove the seeded origin. Each origin renders as a Badge <div> whose text
  // node is the origin, with a child remove <button> (the X). getByText lands
  // on the Badge div; click the button nested inside it. After this only the
  // newly-added origin should remain.
  const seededBadge = page.getByText("https://origin-seed.example.com").first();
  await seededBadge.getByRole("button").first().click();
  await expect(page.getByText("https://origin-seed.example.com")).toHaveCount(
    0,
  );

  await page
    .getByRole("button", { name: /save changes/i })
    .first()
    .click();

  await expect
    .poll(() =>
      calls.find(
        (c) => c.path === `/api/v1/apps/${APP_ID}` && c.method === "PUT",
      ),
    )
    .toBeTruthy();
  const put = calls.find(
    (c) => c.path === `/api/v1/apps/${APP_ID}` && c.method === "PUT",
  );
  expect(put?.body).toMatchObject({
    allowed_origins: ["https://added.example.com"],
  });
});
