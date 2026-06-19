// Settings → Organization → Members — the invite-member write flow. The org
// tab rendered its members list in settings-tabs-flow.spec but the invite
// dialog (the only org write path on this surface) had no behavioral coverage.
// This drives: open the "Invite Member" dialog, type an email, pick a role,
// submit → POST /api/organizations/invites with { email, role }; and asserts the
// existing member row renders. Runs against the local dev build
// (VITE_PLAYWRIGHT_TEST_AUTH=true); all /api/** is mocked.

import { expect, type Page, type Route, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "settings-org-invite-flow uses local mocks; skipped in live-prod mode",
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

// The page gates on user.organization, and MembersTab only renders the Invite
// button when role is owner/admin — so this user is an owner with an org.
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

async function installOrgMocks(page: Page, sink: Captured[]) {
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;

      if (req.method() !== "GET") {
        record(sink, route);
      }

      if (path === "/api/v1/user") {
        return route.fulfill({ json: { success: true, data: CURRENT_USER } });
      }

      if (path === "/api/organizations/members") {
        return route.fulfill({
          json: {
            success: true,
            data: [
              {
                id: "user_1",
                email: "test@example.com",
                name: "Test User",
                role: "owner",
                wallet_address: CURRENT_USER.wallet_address,
                wallet_chain_type: "evm",
                created_at: NOW,
              },
            ],
          },
        });
      }

      if (path === "/api/organizations/invites") {
        if (req.method() === "POST") {
          return route.fulfill({
            json: {
              success: true,
              data: {
                id: "invite_1",
                email: "newbie@example.com",
                role: "member",
                status: "pending",
                created_at: NOW,
              },
            },
          });
        }
        return route.fulfill({ json: { success: true, data: [] } });
      }

      return route.fulfill({
        json: {
          success: true,
          data: [],
          items: [],
          balance: 123.45,
          user: CURRENT_USER,
        },
      });
    },
  );
}

test.beforeEach(async ({ page }) => {
  await setTestAuth(page);
});

test("organization: invite member dialog POSTs /api/organizations/invites with email + role", async ({
  page,
}) => {
  const calls: Captured[] = [];
  await installOrgMocks(page, calls);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/dashboard/settings?tab=organization", {
    waitUntil: "domcontentloaded",
  });
  await expect(page).not.toHaveURL(/\/login/);

  // Org overview + members list render first.
  await expect(page.getByText("Team Members")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("test@example.com")).toBeVisible();

  // Open the invite dialog via the "Invite Member" button.
  await page
    .getByRole("button", { name: /invite member/i })
    .first()
    .click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Invite Team Member")).toBeVisible({
    timeout: 10_000,
  });

  // The email field is the only required input; default role is "member".
  await dialog.locator("#email").fill("newbie@example.com");

  // Submit ("Send Invitation").
  await dialog.getByRole("button", { name: /send invitation/i }).click();

  await expect
    .poll(() =>
      calls.find(
        (c) => c.path === "/api/organizations/invites" && c.method === "POST",
      ),
    )
    .toBeTruthy();
  const invite = calls.find(
    (c) => c.path === "/api/organizations/invites" && c.method === "POST",
  );
  expect(invite?.body).toMatchObject({
    email: "newbie@example.com",
    role: "member",
  });
});
