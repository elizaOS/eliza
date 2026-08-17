/**
 * Playwright UI-smoke spec for the Auth Startup app flow using the real
 * renderer fixture.
 */
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const REMOTE_AUTH_REQUIRED_STATUS = {
  required: true,
  authenticated: false,
  loginRequired: true,
  localAccess: false,
  passwordConfigured: true,
  pairingEnabled: true,
  expiresAt: Date.now() + 10 * 60 * 1000,
};

function apiBaseFromTest(baseURL: string | undefined): string {
  expect(baseURL, "Playwright baseURL must be configured").toBeTruthy();
  return (baseURL ?? "").replace(/\/$/, "");
}

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

function chatComposer(page: Page) {
  return page.getByTestId("chat-composer-textarea");
}

async function routeAuthStatus(
  page: Page,
  body: Record<string, unknown>,
): Promise<void> {
  await page.route("**/api/auth/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, body);
  });
}

test("remote auth requirement renders pairing instead of password sign-in", async ({
  page,
  baseURL,
}) => {
  let authMeRequests = 0;
  const apiBase = apiBaseFromTest(baseURL);

  await seedAppStorage(page, {
    "elizaos:active-server": JSON.stringify({
      id: "remote:ui-smoke",
      kind: "remote",
      label: "Remote UI Smoke",
      apiBase,
    }),
  });
  await routeAuthStatus(page, REMOTE_AUTH_REQUIRED_STATUS);
  await page.route("**/api/auth/me", async (route) => {
    authMeRequests += 1;
    await fulfillJson(route, 500, { error: "auth me should not be reached" });
  });

  await openAppPath(page, "/chat");

  await expect(page.getByText("Pairing Required")).toBeVisible();
  await expect(page.getByPlaceholder("Enter pairing code")).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Sign in$/i })).toHaveCount(
    0,
  );
  await expect(page.getByText("Sign in with your password.")).toHaveCount(0);
  expect(authMeRequests).toBe(0);
});

test("unavailable auth probe shows startup failure instead of password sign-in", async ({
  page,
  baseURL,
}) => {
  const apiBase = apiBaseFromTest(baseURL);

  await seedAppStorage(page, {
    "elizaos:active-server": JSON.stringify({
      id: "remote:ui-smoke",
      kind: "remote",
      label: "Remote UI Smoke",
      apiBase,
    }),
  });
  await routeAuthStatus(page, {
    required: false,
    authenticated: true,
    pairingEnabled: false,
    expiresAt: null,
  });
  await page.route("**/api/auth/me", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 503, { error: "backend unavailable" });
  });

  await openAppPath(page, "/chat");

  // The auth probe deliberately retries a 503 ten times at 1s intervals before
  // publishing `server_unavailable` (useAuthStatus SERVER_UNAVAILABLE_RETRIES),
  // so the failure surface legitimately takes >10s to appear on a slow runner.
  await expect(
    page.getByRole("heading", {
      name: /Can(?:'|’)t connect/i,
    }),
  ).toBeVisible({ timeout: 45_000 });
  await page.getByText("Technical details").click();
  await expect(
    page.getByText(/auth probe could not reach \/api\/auth\/me/i),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry Startup" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Sign in$/i })).toHaveCount(
    0,
  );
  await expect(page.getByText("Sign in with your password.")).toHaveCount(0);
});

test("cloud bootstrap auth renders bootstrap token gate instead of pairing", async ({
  page,
  baseURL,
}) => {
  const apiBase = apiBaseFromTest(baseURL);

  await seedAppStorage(page, {
    "elizaos:active-server": JSON.stringify({
      id: "cloud:ui-smoke",
      kind: "cloud",
      label: "Cloud UI Smoke",
      apiBase,
    }),
  });
  await routeAuthStatus(page, {
    required: true,
    authenticated: false,
    loginRequired: false,
    bootstrapRequired: true,
    localAccess: false,
    passwordConfigured: false,
    pairingEnabled: true,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  await openAppPath(page, "/chat");

  await expect(
    page.getByRole("heading", { name: "Finish setting up your container" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Bootstrap token" }),
  ).toBeVisible();
  await expect(page.getByText("Pairing Required")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^Sign in$/i })).toHaveCount(
    0,
  );
});

test("cloud bootstrap exchange stores the session bearer and resumes startup", async ({
  page,
  baseURL,
}) => {
  const apiBase = apiBaseFromTest(baseURL);
  let exchangeRequests = 0;
  let authedAuthMeRequests = 0;

  await seedAppStorage(page, {
    "elizaos:active-server": JSON.stringify({
      id: "cloud:ui-smoke",
      kind: "cloud",
      label: "Cloud UI Smoke",
      apiBase,
    }),
  });
  await installDefaultAppRoutes(page);
  await page.route("**/api/auth/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    if (route.request().headers().authorization === "Bearer cloud-session") {
      await fulfillJson(route, 200, {
        required: false,
        authenticated: true,
        loginRequired: false,
        bootstrapRequired: false,
        localAccess: false,
        passwordConfigured: false,
        pairingEnabled: false,
        expiresAt: null,
      });
      return;
    }
    await fulfillJson(route, 200, {
      required: true,
      authenticated: false,
      loginRequired: false,
      bootstrapRequired: true,
      localAccess: false,
      passwordConfigured: false,
      pairingEnabled: false,
      expiresAt: null,
    });
  });
  await page.route("**/api/auth/bootstrap/exchange", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    exchangeRequests += 1;
    expect(route.request().postDataJSON()).toEqual({
      token: "cloud-bootstrap-token",
    });
    await fulfillJson(route, 200, {
      sessionId: "cloud-session",
      identityId: "cloud-owner",
      expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    });
  });
  await page.route("**/api/auth/me", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    if (route.request().headers().authorization !== "Bearer cloud-session") {
      await fulfillJson(route, 401, { error: "Unauthorized" });
      return;
    }
    authedAuthMeRequests += 1;
    await fulfillJson(route, 200, {
      identity: {
        id: "cloud-owner",
        displayName: "Cloud Owner",
        kind: "owner",
      },
      session: {
        id: "cloud-session",
        kind: "browser",
        expiresAt: Date.now() + 12 * 60 * 60 * 1000,
      },
      access: {
        mode: "bearer",
        passwordConfigured: false,
        ownerConfigured: true,
      },
    });
  });
  await page.route("**/api/first-run/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    if (route.request().headers().authorization !== "Bearer cloud-session") {
      await fulfillJson(route, 401, { error: "Unauthorized" });
      return;
    }
    await fulfillJson(route, 200, { complete: true, cloudProvisioned: true });
  });

  await openAppPath(page, "/chat");
  await page
    .getByRole("textbox", { name: "Bootstrap token" })
    .fill("cloud-bootstrap-token");
  await page.getByRole("button", { name: "Activate" }).click();

  await expect.poll(() => exchangeRequests).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stored = localStorage.getItem("elizaos:active-server");
        if (!stored) return null;
        const parsed = JSON.parse(stored) as { accessToken?: string };
        return parsed.accessToken ?? null;
      }),
    )
    .toBe("cloud-session");
  await expect.poll(() => authedAuthMeRequests).toBeGreaterThan(0);
  await expect(
    page.getByRole("heading", { name: "Finish setting up your container" }),
  ).toHaveCount(0);
  await expect(chatComposer(page)).toBeVisible();
});

test("remote pairing redeem persists token, resumes startup, and arms LifeOps capture", async ({
  page,
  baseURL,
}) => {
  const apiBase = apiBaseFromTest(baseURL);
  let pairRequests = 0;
  let runtimeStatusRequests = 0;
  let activitySignalCaptures = 0;
  let signedOutPollingWindowActive = false;
  let sessionAuthenticated = false;
  const signedOutConsoleErrors: string[] = [];

  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET" && pathname === "/api/status") {
      runtimeStatusRequests += 1;
    }
    if (
      request.method() === "POST" &&
      pathname === "/api/lifeops/activity-signals"
    ) {
      activitySignalCaptures += 1;
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      signedOutConsoleErrors.push(message.text());
    }
  });

  await seedAppStorage(page, {
    "elizaos:active-server": JSON.stringify({
      id: "remote:ui-smoke",
      kind: "remote",
      label: "Remote UI Smoke",
      apiBase,
    }),
  });
  await installDefaultAppRoutes(page);
  await page.route("**/api/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    if (signedOutPollingWindowActive && !sessionAuthenticated) {
      await fulfillJson(route, 401, { error: "Unauthorized" });
      return;
    }
    await fulfillJson(route, 200, {
      state: "running",
      agentName: "Playwright Smoke",
      model: "ui-smoke",
      startedAt: Date.now() - 60_000,
      uptime: 60_000,
    });
  });
  await page.route("**/api/auth/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const authorization = route.request().headers().authorization;
    if (authorization === "Bearer paired-token") {
      await fulfillJson(route, 200, {
        required: true,
        authenticated: true,
        loginRequired: false,
        localAccess: false,
        passwordConfigured: false,
        pairingEnabled: false,
        expiresAt: null,
      });
      return;
    }
    await fulfillJson(route, 200, REMOTE_AUTH_REQUIRED_STATUS);
  });
  await page.route("**/api/auth/pair", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    pairRequests += 1;
    sessionAuthenticated = true;
    expect(route.request().postDataJSON()).toEqual({
      code: "ABCD EFGH IJKL",
    });
    await fulfillJson(route, 200, { token: "paired-token" });
  });
  await page.route("**/api/auth/me", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    if (route.request().headers().authorization !== "Bearer paired-token") {
      await fulfillJson(route, 401, { error: "Unauthorized" });
      return;
    }
    await fulfillJson(route, 200, {
      identity: {
        id: "playwright-paired-owner",
        displayName: "Paired Owner",
        kind: "owner",
      },
      session: {
        id: "playwright-paired-session",
        kind: "machine",
        expiresAt: null,
      },
      access: {
        mode: "bearer",
        passwordConfigured: false,
        ownerConfigured: true,
      },
    });
  });
  await page.route("**/api/first-run/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    expect(route.request().headers().authorization).toBe("Bearer paired-token");
    await fulfillJson(route, 200, { complete: true, cloudProvisioned: false });
  });

  await openAppPath(page, "/chat");
  await expect(page.getByText("Pairing Required")).toBeVisible();

  // Real browser/network regression for #16504: the registration module is
  // loaded on this fresh signed-out renderer, but canonical auth must hold its
  // self-starting readiness loop for more than two former 5s poll windows.
  // Startup owns a bounded pair of one-shot status probes before the gate
  // settles, so freeze that baseline here; any later status request receives a
  // real 401 and would create the Chromium console noise this test guards.
  const settledStartupStatusRequests = runtimeStatusRequests;
  signedOutConsoleErrors.length = 0;
  signedOutPollingWindowActive = true;
  await page.waitForTimeout(10_500);
  expect(runtimeStatusRequests).toBe(settledStartupStatusRequests);
  expect(activitySignalCaptures).toBe(0);
  expect(signedOutConsoleErrors).toEqual([]);

  await page.getByPlaceholder("Enter pairing code").fill("ABCD EFGH IJKL");
  await page.getByRole("button", { name: "Submit" }).click();

  await expect.poll(() => pairRequests).toBe(1);
  await expect(page.getByText("Pairing Required")).toHaveCount(0);
  await expect(chatComposer(page)).toBeVisible();
  await expect
    .poll(() => runtimeStatusRequests)
    .toBeGreaterThan(settledStartupStatusRequests);
  await expect.poll(() => activitySignalCaptures).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem("elizaos:active-server");
        return raw ? (JSON.parse(raw).accessToken ?? null) : null;
      }),
    )
    .toBe("paired-token");
});
