// Behavioral coverage for the PUBLIC signing/action pages that were previously
// only render-smoked. Each page loads a pending entity over a public GET, then
// fires a POST mutation the test captures and asserts (method + path + body).
//
// Three of the four pages (approve, ballot, sensitive-request) are fully public:
// they self-authenticate via a signature or scoped token in the request body /
// URL, so NO test-auth cookie is set. The invite-accept page is the exception —
// its Accept button only POSTs when the visitor is authenticated (otherwise it
// redirects to /login), so that test installs the eliza-test-auth cookie.
//
// Runs against the local dev build (VITE_PLAYWRIGHT_TEST_AUTH=true). All /api/**
// calls are mocked; no real backend is touched.

import { expect, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "Public signing flows use local mocks; skipped in live-prod mode",
);

interface Captured {
  method: string;
  url: string;
  body: unknown;
}

function readBody(req: import("@playwright/test").Request): unknown {
  try {
    return req.postDataJSON();
  } catch {
    return req.postData();
  }
}

// A generic catch-all so any incidental /api/** the shell pulls during render
// (theme, i18n, telemetry, etc.) resolves cleanly instead of hanging.
async function installApiCatchAll(
  page: import("@playwright/test").Page,
  isHandled: (pathname: string) => boolean,
) {
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      const p = new URL(route.request().url()).pathname;
      if (isHandled(p)) return route.fallback();
      return route.fulfill({
        json: { success: true, data: [], items: [], balance: 100 },
      });
    },
  );
}

// Some public pages can have the first-run onboarding tour overlay; dismiss it
// if present (no-op otherwise).
async function dismissTour(page: import("@playwright/test").Page) {
  await page
    .getByRole("button", { name: /skip tour/i })
    .first()
    .click({ timeout: 4000 })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// 1) APPROVE — /approve/:approvalId
//    GET  /api/v1/approval-requests/:id?public=1  -> { success, approvalRequest }
//    POST /api/v1/approval-requests/:id/approve   body { signature }
//    POST /api/v1/approval-requests/:id/deny       body { reason }
// ---------------------------------------------------------------------------
test.describe("approve page", () => {
  const APPROVAL_ID = "appr_test_1";

  function pendingApproval(status = "pending") {
    return {
      id: APPROVAL_ID,
      organizationId: "org_1",
      agentId: "agent_1",
      userId: null,
      challengeKind: "signature",
      challengePayload: {
        message: "Approve transfer of 10 USDC to 0xabc...",
        signerKind: "wallet",
        walletAddress: "0x1111111111111111111111111111111111111111",
      },
      expectedSignerIdentityId: "ident_1",
      status,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: null,
    };
  }

  async function installRoutes(
    page: import("@playwright/test").Page,
    sink: Captured[],
  ) {
    await page.route("**/api/v1/approval-requests/*/approve", async (route) => {
      sink.push({
        method: route.request().method(),
        url: new URL(route.request().url()).pathname,
        body: readBody(route.request()),
      });
      return route.fulfill({
        json: { success: true, approvalRequest: pendingApproval("approved") },
      });
    });
    await page.route("**/api/v1/approval-requests/*/deny", async (route) => {
      sink.push({
        method: route.request().method(),
        url: new URL(route.request().url()).pathname,
        body: readBody(route.request()),
      });
      return route.fulfill({
        json: { success: true, approvalRequest: pendingApproval("denied") },
      });
    });
    // GET the public approval (the `?public=1` query is on the path).
    await page.route("**/api/v1/approval-requests/*", (route) => {
      return route.fulfill({
        json: { success: true, approvalRequest: pendingApproval() },
      });
    });
    await installApiCatchAll(page, (p) =>
      p.startsWith("/api/v1/approval-requests"),
    );
  }

  test("Approve POSTs the signature to /approve", async ({ page }) => {
    const calls: Captured[] = [];
    await installRoutes(page, calls);

    await page.goto(`/approve/${APPROVAL_ID}`);
    await dismissTour(page);

    const approveBtn = page.getByRole("button", { name: /^approve$/i }).first();
    await expect(approveBtn).toBeVisible({ timeout: 15_000 });

    // Approve is disabled until a signature is entered.
    await expect(approveBtn).toBeDisabled();
    await page.locator("#approval-signature").fill("0xdeadbeefsignature");
    await expect(approveBtn).toBeEnabled();
    await approveBtn.click();

    await expect
      .poll(() => calls.find((c) => c.url.endsWith("/approve")))
      .toBeTruthy();
    const approve = calls.find((c) => c.url.endsWith("/approve"));
    expect(approve?.method).toBe("POST");
    expect(approve?.url).toBe(
      `/api/v1/approval-requests/${APPROVAL_ID}/approve`,
    );
    expect(approve?.body).toMatchObject({ signature: "0xdeadbeefsignature" });

    // The accepted state replaces the form.
    await expect(page.getByText(/signature accepted/i)).toBeVisible();
  });

  test("Deny POSTs to /deny with a reason", async ({ page }) => {
    const calls: Captured[] = [];
    await installRoutes(page, calls);

    await page.goto(`/approve/${APPROVAL_ID}`);
    await dismissTour(page);

    const denyBtn = page.getByRole("button", { name: /^deny$/i }).first();
    await expect(denyBtn).toBeVisible({ timeout: 15_000 });
    // Deny needs no signature.
    await expect(denyBtn).toBeEnabled();
    await denyBtn.click();

    await expect
      .poll(() => calls.find((c) => c.url.endsWith("/deny")))
      .toBeTruthy();
    const deny = calls.find((c) => c.url.endsWith("/deny"));
    expect(deny?.method).toBe("POST");
    expect(deny?.url).toBe(`/api/v1/approval-requests/${APPROVAL_ID}/deny`);
    expect(deny?.body).toMatchObject({ reason: "denied by signer" });

    await expect(page.getByText(/approval denied/i)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 2) BALLOT — /ballot/:ballotId
//    GET  /api/v1/ballots/:id?public=1  -> { success, ballot }
//    POST /api/v1/ballots/:id/vote      body { scopedToken, value }
//    The scoped token can be preset via the ?token= query param.
// ---------------------------------------------------------------------------
test.describe("ballot page", () => {
  const BALLOT_ID = "ballot_test_1";
  const PRESET_TOKEN = "sb_preset_token_123";

  function openBallot() {
    return {
      id: BALLOT_ID,
      organizationId: "org_1",
      purpose: "Approve the Q3 budget",
      threshold: 2,
      status: "open",
      participants: [
        { identityId: "ident_1", label: "Alice" },
        { identityId: "ident_2", label: "Bob" },
        { identityId: "ident_3", label: "Carol" },
      ],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      createdAt: new Date().toISOString(),
    };
  }

  async function installRoutes(
    page: import("@playwright/test").Page,
    sink: Captured[],
  ) {
    await page.route("**/api/v1/ballots/*/vote", async (route) => {
      sink.push({
        method: route.request().method(),
        url: new URL(route.request().url()).pathname,
        body: readBody(route.request()),
      });
      return route.fulfill({
        json: { success: true, outcome: "recorded", ballotStatus: "open" },
      });
    });
    await page.route("**/api/v1/ballots/*", (route) => {
      return route.fulfill({ json: { success: true, ballot: openBallot() } });
    });
    await installApiCatchAll(page, (p) => p.startsWith("/api/v1/ballots"));
  }

  test("Submit vote POSTs { scopedToken, value }", async ({ page }) => {
    const calls: Captured[] = [];
    await installRoutes(page, calls);

    // Preset the scoped token via the query param the page reads.
    await page.goto(`/ballot/${BALLOT_ID}?token=${PRESET_TOKEN}`);
    await dismissTour(page);

    // The preset token is hydrated into the token input.
    const tokenInput = page.locator('input[placeholder="sb_..."]').first();
    await expect(tokenInput).toBeVisible({ timeout: 15_000 });
    await expect(tokenInput).toHaveValue(PRESET_TOKEN);

    // Fill the vote textarea (the only textarea in the form).
    await page.locator("form textarea").first().fill("yes");

    const submitBtn = page
      .getByRole("button", { name: /submit vote/i })
      .first();
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    await expect
      .poll(() => calls.find((c) => c.url.endsWith("/vote")))
      .toBeTruthy();
    const vote = calls.find((c) => c.url.endsWith("/vote"));
    expect(vote?.method).toBe("POST");
    expect(vote?.url).toBe(`/api/v1/ballots/${BALLOT_ID}/vote`);
    expect(vote?.body).toMatchObject({
      scopedToken: PRESET_TOKEN,
      value: "yes",
    });

    await expect(page.getByText(/vote recorded/i)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 3) SENSITIVE REQUEST — /sensitive-requests/:requestId
//    GET  /api/v1/sensitive-requests/:id[?token=...]        -> HostedSensitiveRequest
//    POST /api/v1/sensitive-requests/:id/submit[?token=...]  body { token, value }
//    (kind=secret submits a single value; the secret field renders as password)
// ---------------------------------------------------------------------------
test.describe("sensitive request page", () => {
  const REQUEST_ID = "sreq_test_1";
  const TOKEN = "tok_sensitive_123";

  function pendingRequest() {
    return {
      id: REQUEST_ID,
      kind: "secret",
      status: "pending",
      reason: "The agent needs your OpenAI API key to continue.",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      form: {
        submitLabel: "Submit secret",
        fields: [
          {
            name: "openai_api_key",
            label: "OpenAI API key",
            input: "secret",
            required: true,
          },
        ],
      },
    };
  }

  async function installRoutes(
    page: import("@playwright/test").Page,
    sink: Captured[],
  ) {
    await page.route(
      "**/api/v1/sensitive-requests/*/submit*",
      async (route) => {
        sink.push({
          method: route.request().method(),
          url: new URL(route.request().url()).pathname,
          body: readBody(route.request()),
        });
        return route.fulfill({ json: { success: true } });
      },
    );
    await page.route("**/api/v1/sensitive-requests/*", (route) => {
      return route.fulfill({ json: pendingRequest() });
    });
    await installApiCatchAll(page, (p) =>
      p.startsWith("/api/v1/sensitive-requests"),
    );
  }

  test("Submit POSTs { token, value } to /submit", async ({ page }) => {
    const calls: Captured[] = [];
    await installRoutes(page, calls);

    // The page forwards location.search to both GET and POST, and reads the
    // token from the query string into the submit body.
    await page.goto(`/sensitive-requests/${REQUEST_ID}?token=${TOKEN}`);
    await dismissTour(page);

    const secretInput = page.locator("#field-openai_api_key");
    await expect(secretInput).toBeVisible({ timeout: 15_000 });
    await secretInput.fill("sk-secret-value");

    const submitBtn = page
      .getByRole("button", { name: /submit secret/i })
      .first();
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    await expect
      .poll(() => calls.find((c) => c.url.endsWith("/submit")))
      .toBeTruthy();
    const submit = calls.find((c) => c.url.endsWith("/submit"));
    expect(submit?.method).toBe("POST");
    expect(submit?.url).toBe(`/api/v1/sensitive-requests/${REQUEST_ID}/submit`);
    expect(submit?.body).toMatchObject({
      token: TOKEN,
      value: "sk-secret-value",
    });

    // The success state replaces the form.
    await expect(page.getByText(/request complete/i)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 4) INVITE ACCEPT — /invite/accept (and /accept-invitation)
//    GET  /api/invites/validate?token=...  (plain fetch) -> { success, data }
//    POST /api/invites/accept              body { token }
//    Accept only POSTs when authenticated, otherwise it redirects to /login —
//    so this test sets the eliza-test-auth cookie.
// ---------------------------------------------------------------------------
test.describe("invite accept page", () => {
  const TOKEN = "invite_token_abc123";

  test.beforeEach(async ({ context }) => {
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
  });

  function inviteDetails() {
    return {
      organization_name: "Acme Corp",
      invited_email: "invitee@example.com",
      role: "admin",
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      inviter_name: "Org Owner",
    };
  }

  async function installRoutes(
    page: import("@playwright/test").Page,
    sink: Captured[],
  ) {
    await page.route("**/api/invites/validate*", (route) => {
      return route.fulfill({ json: { success: true, data: inviteDetails() } });
    });
    await page.route("**/api/invites/accept", async (route) => {
      sink.push({
        method: route.request().method(),
        url: new URL(route.request().url()).pathname,
        body: readBody(route.request()),
      });
      return route.fulfill({ json: { success: true } });
    });
    await installApiCatchAll(page, (p) => p.startsWith("/api/invites"));
  }

  test("Accept POSTs { token } to /api/invites/accept", async ({ page }) => {
    const calls: Captured[] = [];
    await installRoutes(page, calls);

    await page.goto(`/invite/accept?token=${TOKEN}`);
    await dismissTour(page);

    // With auth present the CTA reads "Accept Invitation" (not "Sign In").
    const acceptBtn = page
      .getByRole("button", { name: /accept invitation/i })
      .first();
    await expect(acceptBtn).toBeVisible({ timeout: 15_000 });
    await acceptBtn.click();

    await expect
      .poll(() => calls.find((c) => c.url === "/api/invites/accept"))
      .toBeTruthy();
    const accept = calls.find((c) => c.url === "/api/invites/accept");
    expect(accept?.method).toBe("POST");
    expect(accept?.body).toMatchObject({ token: TOKEN });
  });

  test("invalid invite shows error + Go to Home navigation", async ({
    page,
  }) => {
    const calls: Captured[] = [];
    await page.route("**/api/invites/validate*", (route) => {
      return route.fulfill({
        json: { success: false, error: "Invalid or expired invitation" },
      });
    });
    await page.route("**/api/invites/accept", async (route) => {
      sink_unused(calls, route);
      return route.fulfill({ json: { success: true } });
    });
    await installApiCatchAll(page, (p) => p.startsWith("/api/invites"));

    await page.goto(`/invite/accept?token=${TOKEN}`);
    await dismissTour(page);

    await expect(page.getByText(/invalid invitation/i).first()).toBeVisible({
      timeout: 15_000,
    });

    // The error state offers a "Go to Home" button that navigates to "/".
    const homeBtn = page.getByRole("button", { name: /go to home/i }).first();
    await expect(homeBtn).toBeVisible();
    await homeBtn.click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("/accept-invitation alias renders the same accept flow", async ({
    page,
  }) => {
    const calls: Captured[] = [];
    await installRoutes(page, calls);

    await page.goto(`/accept-invitation?token=${TOKEN}`);
    await dismissTour(page);

    const acceptBtn = page
      .getByRole("button", { name: /accept invitation/i })
      .first();
    await expect(acceptBtn).toBeVisible({ timeout: 15_000 });
    await acceptBtn.click();

    await expect
      .poll(() => calls.find((c) => c.url === "/api/invites/accept"))
      .toBeTruthy();
    expect(
      calls.find((c) => c.url === "/api/invites/accept")?.body,
    ).toMatchObject({ token: TOKEN });
  });
});

// Captures an accept request without asserting on it (used by the invalid-invite
// test where the accept POST should never fire).
function sink_unused(
  sink: Captured[],
  route: import("@playwright/test").Route,
) {
  sink.push({
    method: route.request().method(),
    url: new URL(route.request().url()).pathname,
    body: readBody(route.request()),
  });
}
