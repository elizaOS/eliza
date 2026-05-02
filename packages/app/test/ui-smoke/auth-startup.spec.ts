import { expect, type Page, type Route, test } from "@playwright/test";
import { openAppPath, seedAppStorage } from "./helpers";

const REMOTE_AUTH_REQUIRED_STATUS = {
  required: true,
  authenticated: false,
  loginRequired: true,
  localAccess: false,
  passwordConfigured: true,
  pairingEnabled: true,
  expiresAt: Date.now() + 10 * 60 * 1000,
};

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
}) => {
  let authMeRequests = 0;

  await seedAppStorage(page, {
    "elizaos:active-server": JSON.stringify({
      id: "remote:ui-smoke",
      kind: "remote",
      label: "Remote UI Smoke",
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
}) => {
  await seedAppStorage(page);
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

  await expect(
    page.getByRole("heading", {
      name: /Startup failed:\s*Backend Unreachable/i,
    }),
  ).toBeVisible();
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
}) => {
  await seedAppStorage(page, {
    "elizaos:active-server": JSON.stringify({
      id: "cloud:ui-smoke",
      kind: "cloud",
      label: "Cloud UI Smoke",
    }),
  });
  await routeAuthStatus(page, {
    required: true,
    authenticated: false,
    loginRequired: false,
    bootstrapRequired: true,
    localAccess: false,
    passwordConfigured: false,
    pairingEnabled: false,
    expiresAt: null,
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
