/**
 * Opt-in, credential-free proof that the ordinary repo-root dev launcher
 * crosses the real staging sign-in boundary. This deliberately leaves every
 * Eliza staging route live and intercepts only the final Google page, before
 * account selection or the OAuth callback can occur.
 */

import { expect, type Request, type Response, test } from "@playwright/test";

const STAGING_API_ORIGIN = "https://api-staging.eliza.app";
const STAGING_APP_ORIGIN = "https://staging.eliza.app";
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test.skip(
  process.env.ELIZA_DEV_SMOKE_STAGING_LIVE_AUTH !== "1",
  "set ELIZA_DEV_SMOKE_STAGING_LIVE_AUTH=1 via test:dev-smoke:staging-live-auth",
);

async function expectLiveTlsResponse(
  response: Response,
  label: string,
  status: number,
): Promise<void> {
  expect(response.status(), `${label} status`).toBe(status);
  expect(
    response.fromServiceWorker(),
    `${label} must not use a service worker`,
  ).toBe(false);
  expect(
    await response.securityDetails(),
    `${label} must be backed by a real TLS connection`,
  ).not.toBeNull();
  const headers = response.request().headers();
  expect(headers.authorization, `${label} must be anonymous`).toBeUndefined();
  expect(
    headers["x-api-key"],
    `${label} must not send an API key`,
  ).toBeUndefined();
}

test("keyless local dev reaches staging provider authorization without following its callback", async ({
  page,
}, testInfo) => {
  expect(process.env.ELIZA_DEV_CLOUD_TARGET).toBe("staging");
  expect(process.env.ELIZA_DEV_CLOUD_API_KEY ?? "").toBe("");

  const configuredBaseUrl = testInfo.project.use.baseURL;
  if (typeof configuredBaseUrl !== "string") {
    throw new Error("dev-smoke requires a string Playwright baseURL");
  }
  const localOrigin = new URL(configuredBaseUrl).origin;
  const context = page.context();
  await context.clearCookies();

  const callbackRequests: string[] = [];
  let googleAuthorizationRequest: Request | null = null;
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.origin === STAGING_API_ORIGIN &&
      url.pathname === "/steward/auth/oauth/google/callback"
    ) {
      callbackRequests.push(request.url());
    }
  });

  // Stop at the third-party authorization boundary. No Google account page is
  // contacted, no credentials are entered, and no callback can be followed.
  await context.route(/^https:\/\/accounts\.google\.com\//, async (route) => {
    googleAuthorizationRequest = route.request();
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>OAuth boundary reached</title><h1>OAuth boundary reached</h1>",
    });
  });

  const firstRunResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.origin === localOrigin &&
      url.pathname === "/api/first-run/status" &&
      response.request().method() === "GET" &&
      response.status() === 200
    );
  });
  const cliSessionResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.origin === STAGING_API_ORIGIN &&
      url.pathname === "/api/auth/cli-session" &&
      response.request().method() === "POST"
    );
  });
  const hostedLoginResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.origin === STAGING_APP_ORIGIN &&
      url.pathname === "/auth/cli-login" &&
      response.request().method() === "GET"
    );
  });
  const providersResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.origin === STAGING_APP_ORIGIN &&
      url.pathname === "/steward/auth/providers" &&
      response.request().method() === "GET"
    );
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  await firstRunResponsePromise;

  const cliSessionResponse = await cliSessionResponsePromise;
  await expectLiveTlsResponse(cliSessionResponse, "staging CLI session", 201);
  const cliHeaders = await cliSessionResponse.allHeaders();
  expect(cliHeaders["access-control-allow-origin"]).toBe(localOrigin);
  expect(cliHeaders["access-control-allow-credentials"]).toBe("true");

  const hostedLoginResponse = await hostedLoginResponsePromise;
  await expectLiveTlsResponse(hostedLoginResponse, "hosted staging login", 200);
  const hostedLoginUrl = new URL(hostedLoginResponse.url());
  const sessionId = hostedLoginUrl.searchParams.get("session");
  expect(sessionId).toEqual(expect.stringMatching(SESSION_ID_PATTERN));
  const returnTo = new URL(hostedLoginUrl.searchParams.get("returnTo") ?? "");
  expect(returnTo.origin).toBe(localOrigin);
  expect(returnTo.pathname).toBe("/");
  expect(returnTo.searchParams.get("elizaCloudLogin")).toBe("complete");
  expect(returnTo.searchParams.get("elizaCloudLoginSession")).toBe(sessionId);

  const providersResponse = await providersResponsePromise;
  await expectLiveTlsResponse(
    providersResponse,
    "staging provider discovery",
    200,
  );
  const providers = (await providersResponse.json()) as {
    google?: unknown;
  };
  expect(providers.google).toBe(true);

  await expect(page).toHaveURL(/^https:\/\/staging\.eliza\.app\/login(?:\?|$)/);
  const googleButton = page.getByRole("button", {
    name: "Google",
    exact: true,
  });
  await expect(googleButton).toBeVisible();

  await googleButton.click();
  await expect(page).toHaveURL(/^https:\/\/accounts\.google\.com\//);
  await expect(
    page.getByRole("heading", { name: "OAuth boundary reached", exact: true }),
  ).toBeVisible();

  const capturedAuthorizeRequest: Request | null = googleAuthorizationRequest;
  expect(
    capturedAuthorizeRequest,
    "the hosted staging login must reach Google's authorization boundary",
  ).not.toBeNull();
  if (!capturedAuthorizeRequest) {
    throw new Error("Google authorization request was not captured");
  }
  const authorizeHeaders = capturedAuthorizeRequest.headers();
  expect(authorizeHeaders.authorization).toBeUndefined();
  expect(authorizeHeaders["x-api-key"]).toBeUndefined();
  const googleAuthorizationUrl = new URL(capturedAuthorizeRequest.url());
  expect(googleAuthorizationUrl.origin).toBe("https://accounts.google.com");
  expect(googleAuthorizationUrl.pathname).toBe("/o/oauth2/v2/auth");
  expect(googleAuthorizationUrl.searchParams.get("client_id")).toMatch(
    /^[a-z0-9-]+\.apps\.googleusercontent\.com$/i,
  );
  expect(googleAuthorizationUrl.searchParams.get("response_type")).toBe("code");
  expect(googleAuthorizationUrl.searchParams.get("state")).toMatch(
    /^[0-9a-f]{32}$/i,
  );
  expect(googleAuthorizationUrl.searchParams.get("redirect_uri")).toBe(
    `${STAGING_API_ORIGIN}/steward/auth/oauth/google/callback`,
  );

  expect(context.pages()).toEqual([page]);
  expect(callbackRequests).toEqual([]);
});
