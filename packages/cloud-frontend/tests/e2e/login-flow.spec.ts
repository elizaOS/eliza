// Login success-path e2e — the four sign-in flows in
// src/pages/login/steward-login-section.tsx + wallet-buttons.tsx that had no
// behavioral coverage:
//
//   1. Passkey  → auth.signInWithPasskey → handleSuccess (persist token + redirect)
//   2. Magic link → auth.signInWithEmail → "email-sent" step (+ back button)
//   3. OTP signup → sendEmailOtp → verifyEmailOtp → addPasskey → handleSuccess
//   4. OAuth (Google/Discord/GitHub) → handleOAuth → PKCE /authorize redirect
//
// These are UNAUTHENTICATED flows: the user is signing IN, so we do NOT set the
// `eliza-test-auth` cookie (that would short-circuit the login page and bounce
// straight to the dashboard). Instead we mock the seam each button actually
// hits.
//
// The seam: every `auth.*` method on the bundled `@stwd/sdk` `StewardAuth`
// instance is a `fetch(`${baseUrl}/auth/...`, ...)` (see
// node_modules/@stwd/sdk/dist/auth.js `authRequest`). In dev `baseUrl` resolves
// to `${origin}/steward`, so we intercept by path SUFFIX (`**/auth/...`) exactly
// like siwe-flow.spec.ts does — we don't assume the exact origin/prefix. The
// component's success detector is `handleSuccess(token, refreshToken)`, which
// only runs once the SDK decodes a JWT out of the verify response, so the mocks
// return a synthesized, decodable JWT (matching siwe-flow.spec.ts's shape).
//
// Passkey flows need a real WebAuthn ceremony. We attach a Chromium CDP virtual
// authenticator (`WebAuthn.addVirtualAuthenticator`) so `@simplewebauthn/browser`
// `startRegistration` / `startAuthentication` resolve without OS UI.
//
// Skipped in live-prod mode (mocks only).

import { type CDPSession, expect, type Page, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "login flow uses local mocks; skipped in live-prod mode",
);

const EMAIL = "login-e2e@example.com";

// ─── helpers ────────────────────────────────────────────────────────────────

function base64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// A JWT the bundled SDK's `storeAndReturn` -> `sessionFromToken` can decode
// (it only base64url-decodes the payload; the signature is never verified
// client-side). Mirrors siwe-flow.spec.ts.
function fakeStewardJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      sub: "user_login_e2e",
      userId: "user_login_e2e",
      address: "",
      email: EMAIL,
      tenantId: "elizacloud",
      iat: now,
      exp: now + 3600,
    }),
  );
  return `${header}.${payload}.${base64url("test-signature")}`;
}

// The verify routes return the auth envelope the SDK reads `token`/`refreshToken`
// off of (`storeExchangeResponse(data)` -> `storeAndReturn(data.token, ...)`).
function authVerifyEnvelope() {
  return {
    token: fakeStewardJwt(),
    refreshToken: "refresh_login_e2e",
    expiresIn: 3600,
    user: { id: "user_login_e2e", email: EMAIL },
  };
}

// Catch-all so the login page's own render-time /api/** calls (and the
// /api/auth/steward-session sync handleSuccess performs) resolve. We capture
// the session-sync POST so we can assert handleSuccess ran end to end.
async function installBaseApiMocks(
  page: Page,
  seen: { sessionSync: boolean },
): Promise<void> {
  await page.route("**/api/auth/steward-session", (route) => {
    if (route.request().method() === "POST") seen.sessionSync = true;
    return route.fulfill({
      json: { ok: true, userId: "user_login_e2e", stewardUserId: "stwd_1" },
    });
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      if (
        new URL(route.request().url()).pathname === "/api/auth/steward-session"
      ) {
        return route.fallback();
      }
      return route.fulfill({
        json: { success: true, data: [], items: [], balance: 0 },
      });
    },
  );
}

// Valid base64url-encoded 32-byte challenge for the WebAuthn ceremony.
const WEBAUTHN_CHALLENGE = base64url("login-e2e-webauthn-challenge-32b");

// WebAuthn rejects IP-literal origins ("This is an invalid domain") — on the
// default `127.0.0.1:4173` baseURL `navigator.credentials.create()` fails for
// EVERY rp.id (including an omitted one), so the registration ceremony can
// never complete. The passkey tests therefore navigate via the `localhost`
// alias of the same Vite server (Chromium special-cases `localhost` as a valid
// WebAuthn RP domain); the host still resolves to 127.0.0.1 so the dev server
// answers. Non-passkey login tests stay on the configured baseURL.
function loginUrlOnWebAuthnHost(baseURL: string | undefined): string {
  const url = new URL("/login", baseURL ?? "http://127.0.0.1:4173");
  url.hostname = "localhost";
  return url.toString();
}

// Registration options shaped for @simplewebauthn/browser v13's
// startRegistration back-compat path (reads `challenge`, `rp`, `user`,
// `pubKeyCredParams`). rp.id MUST match the page host (`localhost`) or the
// virtual authenticator rejects the create().
function passkeyRegisterOptions(rpId: string) {
  return {
    challenge: WEBAUTHN_CHALLENGE,
    rp: { id: rpId, name: "Eliza Cloud" },
    user: {
      id: base64url("user_login_e2e"),
      name: EMAIL,
      displayName: EMAIL,
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    timeout: 60_000,
    attestation: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    excludeCredentials: [],
  };
}

// Attach a CDP virtual authenticator so navigator.credentials.create/get
// resolve headlessly. Chromium-only — the passkey tests skip on other engines.
async function attachVirtualAuthenticator(page: Page): Promise<CDPSession> {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return client;
}

// ─── 1. Passkey ───────────────────────────────────────────────────────────────

test("passkey: signInWithPasskey first-time branch registers a passkey and redirects", async ({
  page,
  browserName,
  baseURL,
}) => {
  test.skip(
    browserName !== "chromium",
    "WebAuthn virtual authenticator is Chromium-only",
  );

  const seen = { sessionSync: false };
  await installBaseApiMocks(page, seen);

  // No existing passkey for this email -> login/options returns 404, so
  // signInWithPasskey falls through to the registration ceremony. The
  // register/options rp.id is derived per-request from the page host so the
  // virtual authenticator's create() is not rejected for an rpId mismatch.
  await page.route(
    (url) => url.pathname.endsWith("/auth/passkey/login/options"),
    (route) =>
      route.fulfill({ status: 404, json: { ok: false, error: "no passkey" } }),
  );

  let registerVerified = false;
  await page.route(
    (url) => url.pathname.endsWith("/auth/passkey/register/options"),
    (route) =>
      route.fulfill({
        json: passkeyRegisterOptions(new URL(route.request().url()).hostname),
      }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/auth/passkey/register/verify"),
    (route) => {
      registerVerified = true;
      return route.fulfill({ json: authVerifyEnvelope() });
    },
  );

  await attachVirtualAuthenticator(page);
  await page.goto(loginUrlOnWebAuthnHost(baseURL));

  await page.getByPlaceholder(/you@example\.com/i).fill(EMAIL);
  await page
    .getByRole("button", { name: /^passkey$/i })
    .first()
    .click();

  // handleSuccess: register/verify fired, token persisted, session synced, and
  // the component <Navigate>'s off /login.
  await expect.poll(() => registerVerified, { timeout: 20_000 }).toBe(true);
  await expect.poll(() => seen.sessionSync, { timeout: 20_000 }).toBe(true);
  await expect
    .poll(
      () => page.evaluate(() => localStorage.getItem("steward_session_token")),
      { timeout: 20_000 },
    )
    .toBeTruthy();
  await expect.poll(() => new URL(page.url()).pathname).not.toMatch(/\/login$/);
});

// ─── 2. Email / Magic Link ────────────────────────────────────────────────────

test("magic link: signInWithEmail renders the email-sent step with a back button", async ({
  page,
}) => {
  const seen = { sessionSync: false };
  await installBaseApiMocks(page, seen);

  let emailSendCalled = false;
  await page.route(
    (url) => url.pathname.endsWith("/auth/email/send"),
    (route) => {
      emailSendCalled = true;
      return route.fulfill({
        json: {
          ok: true,
          data: { expiresAt: new Date(Date.now() + 600_000).toISOString() },
        },
      });
    },
  );

  await page.goto("/login");

  await page.getByPlaceholder(/you@example\.com/i).fill(EMAIL);
  await page
    .getByRole("button", { name: /magic link/i })
    .first()
    .click();

  await expect.poll(() => emailSendCalled, { timeout: 10_000 }).toBe(true);

  // The "email-sent" step renders the confirmation + the email + a back button.
  await expect(page.getByText(/magic link sent to/i)).toBeVisible();
  await expect(page.getByText(EMAIL)).toBeVisible();
  const backButton = page.getByRole("button", { name: /back to login/i });
  await expect(backButton).toBeVisible();

  // Back returns to the idle login form.
  await backButton.click();
  await expect(page.getByPlaceholder(/you@example\.com/i)).toBeVisible();
});

// ─── 3. OTP signup (passkey fallback) ─────────────────────────────────────────

test("otp signup: passkey error → OTP code → addPasskey → redirect", async ({
  page,
  browserName,
  baseURL,
}) => {
  test.skip(
    browserName !== "chromium",
    "WebAuthn virtual authenticator is Chromium-only",
  );

  const seen = { sessionSync: false };
  await installBaseApiMocks(page, seen);

  // login/options returns 500 -> signInWithPasskey throws -> the component
  // catch falls through to startPasskeySignup() which calls sendEmailOtp.
  await page.route(
    (url) => url.pathname.endsWith("/auth/passkey/login/options"),
    (route) =>
      route.fulfill({ status: 500, json: { ok: false, error: "boom" } }),
  );

  let otpSendCalled = false;
  await page.route(
    (url) => url.pathname.endsWith("/auth/email/otp/send"),
    (route) => {
      otpSendCalled = true;
      return route.fulfill({ json: { ok: true, data: { expiresAt: "soon" } } });
    },
  );

  let otpVerifyCalled = false;
  await page.route(
    (url) => url.pathname.endsWith("/auth/email/otp/verify"),
    (route) => {
      otpVerifyCalled = true;
      // verifyEmailOtp unwraps `data.emailGrant`.
      return route.fulfill({
        json: {
          ok: true,
          data: { emailGrant: "grant_login_e2e", expiresInSeconds: 600 },
        },
      });
    },
  );

  // addPasskey -> register/options (+emailGrant) -> WebAuthn create ->
  // register/verify -> JWT.
  let registerVerified = false;
  await page.route(
    (url) => url.pathname.endsWith("/auth/passkey/register/options"),
    (route) =>
      route.fulfill({
        json: passkeyRegisterOptions(new URL(route.request().url()).hostname),
      }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/auth/passkey/register/verify"),
    (route) => {
      registerVerified = true;
      return route.fulfill({ json: authVerifyEnvelope() });
    },
  );

  await attachVirtualAuthenticator(page);
  await page.goto(loginUrlOnWebAuthnHost(baseURL));

  await page.getByPlaceholder(/you@example\.com/i).fill(EMAIL);
  await page
    .getByRole("button", { name: /^passkey$/i })
    .first()
    .click();

  // Fell through to the OTP entry step.
  await expect.poll(() => otpSendCalled, { timeout: 15_000 }).toBe(true);
  const codeInput = page.getByPlaceholder("123456");
  await expect(codeInput).toBeVisible({ timeout: 10_000 });
  await codeInput.fill("123456");

  // "Create passkey" -> verifyEmailOtp + addPasskey.
  await page.getByRole("button", { name: /create passkey/i }).click();

  await expect.poll(() => otpVerifyCalled, { timeout: 15_000 }).toBe(true);
  await expect.poll(() => registerVerified, { timeout: 20_000 }).toBe(true);
  await expect.poll(() => seen.sessionSync, { timeout: 20_000 }).toBe(true);
  await expect
    .poll(
      () => page.evaluate(() => localStorage.getItem("steward_session_token")),
      { timeout: 20_000 },
    )
    .toBeTruthy();
  await expect.poll(() => new URL(page.url()).pathname).not.toMatch(/\/login$/);
});

// ─── 4. OAuth (Google / Discord / GitHub) ─────────────────────────────────────
//
// handleOAuth mints a PKCE pair, stashes the verifier, then sets
// window.location.href to `${stewardApiUrl}/auth/oauth/${provider}/authorize?...`
// (steward-oauth-url.ts / buildStewardOAuthAuthorizeUrl). We intercept that
// navigation and assert the redirect-URL contract (provider, response_type=code,
// code_challenge + S256, tenant_id, redirect_uri ending in /login).
//
// NOTE on rendering: the OAuth buttons only render when
// providers.google/discord/github are truthy. Under the e2e dev server
// (VITE_PLAYWRIGHT_TEST_AUTH=true) the component short-circuits provider
// discovery and uses TEST_PROVIDERS (passkey+email+siwe, OAuth OFF), so the
// buttons are absent and this test SKIPS cleanly rather than failing. When the
// providers DO render (test-auth off / real discovery), it runs and asserts the
// real authorize redirect for each provider.
for (const provider of ["google", "discord", "github"] as const) {
  test(`oauth: ${provider} button builds the PKCE /authorize redirect`, async ({
    page,
  }) => {
    const seen = { sessionSync: false };
    await installBaseApiMocks(page, seen);

    // Provider discovery (only consulted when test-auth is off).
    await page.route(
      (url) => url.pathname.endsWith("/auth/providers"),
      (route) =>
        route.fulfill({
          json: {
            passkey: true,
            email: true,
            siwe: false,
            siws: false,
            google: true,
            discord: true,
            github: true,
            oauth: [],
          },
        }),
    );

    // Intercept the authorize navigation so the test browser does not actually
    // leave for the (mocked-away) Steward host. Capture the URL.
    let authorizeUrl: string | null = null;
    await page.route(
      (url) => url.pathname.endsWith(`/auth/oauth/${provider}/authorize`),
      (route) => {
        authorizeUrl = route.request().url();
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<html><body>steward authorize stub</body></html>",
        });
      },
    );

    await page.goto("/login");

    const oauthButton = page.getByRole("button", {
      name: new RegExp(`^${provider}$`, "i"),
    });
    // Skip cleanly when the e2e server's test-auth flag suppresses OAuth
    // providers (see NOTE above); the seam itself is still asserted by the
    // network capture below whenever the button is reachable.
    const visible = await oauthButton
      .first()
      .isVisible()
      .catch(() => false);
    test.skip(
      !visible,
      `OAuth ${provider} button not rendered (VITE_PLAYWRIGHT_TEST_AUTH suppresses OAuth providers)`,
    );

    await oauthButton.first().click();

    await expect.poll(() => authorizeUrl, { timeout: 10_000 }).toBeTruthy();
    const parsed = new URL(authorizeUrl as unknown as string);
    expect(parsed.pathname.endsWith(`/auth/oauth/${provider}/authorize`)).toBe(
      true,
    );
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("tenant_id")).toBe("elizacloud");
    expect(parsed.searchParams.get("code_challenge")).toBeTruthy();
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("redirect_uri") ?? "").toMatch(/\/login$/);
  });
}
