/**
 * Real-browser regression for the managed Cloud login's navigation ownership.
 * The fixture proxies the local renderer behind the canonical app hostname so
 * production hostname gates run unchanged while all application bytes remain
 * exact-head and local; network-bound auth provider discovery is deterministic.
 * Authenticated Shared/agentless shells also prove unsupported standalone-agent
 * notification routes stay capability-disabled instead of painting an error.
 */

import { writeFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { installDefaultAppRoutes } from "./helpers";
import { seedStewardSession } from "./helpers/test-auth";

const PROVIDERS = {
  passkey: false,
  email: true,
  sms: false,
  siwe: true,
  siws: true,
  google: true,
  discord: true,
  github: true,
  twitter: false,
  oauth: [],
};

const STABILITY_WINDOW_MS = 5_500;
const TEST_AUTH_ENABLED =
  process.env.VITE_PLAYWRIGHT_TEST_AUTH === "true" ||
  process.env.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH === "true";
const PERSONAL_ID = "personal:11111111-1111-5111-8111-111111111111";
const ONBOARDING_TOKEN = "aaaaaaaa-test-test-test-tokentoken01";
const SURFACES = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "mobile", viewport: { width: 390, height: 844 } },
] as const;

async function installManagedOriginProxy(
  page: Page,
  localBaseUrl: string,
): Promise<string> {
  const local = new URL(localBaseUrl);
  const managed = new URL(localBaseUrl);
  managed.hostname = "cloud.eliza.app";

  await page.route(`${managed.origin}/**`, async (route) => {
    const target = new URL(route.request().url());
    target.protocol = local.protocol;
    target.hostname = local.hostname;
    target.port = local.port;
    const response = await route.fetch({ url: target.toString() });
    await route.fulfill({ response });
  });
  await page.route("**/auth/providers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(PROVIDERS),
    });
  });

  return managed.origin;
}

async function installAuthenticatedPersonalRoutes(
  page: Page,
  managedOrigin: string,
  personalGate?: Promise<void>,
): Promise<() => number> {
  await installDefaultAppRoutes(page);
  await page.context().addCookies([
    {
      name: "eliza-test-auth",
      value: "1",
      domain: "cloud.eliza.app",
      path: "/",
      sameSite: "Lax",
    },
  ]);
  await seedStewardSession(page, {
    jwt: true,
    userId: "22222222-2222-4222-8222-222222222222",
    email: "managed-handoff@test.local",
  });

  let personalRequests = 0;
  await page.route("**/api/v1/eliza/agents", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: [] }),
    });
  });
  await page.route("**/api/v1/eliza/personal", async (route) => {
    personalRequests += 1;
    if (personalGate) await personalGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          identity: {
            id: PERSONAL_ID,
            displayName: "Eliza",
            runtime: "shared",
            activeAgentId: "22222222-2222-4222-8222-222222222222",
            apiBase: managedOrigin,
          },
        },
      }),
    });
  });
  return () => personalRequests;
}

for (const surface of SURFACES) {
  test(`authenticated login handoff mounts chat in the same document (${surface.name})`, async ({
    page,
    baseURL,
  }, testInfo) => {
    test.skip(
      !TEST_AUTH_ENABLED,
      "requires VITE_PLAYWRIGHT_TEST_AUTH=true in the renderer build",
    );
    if (!baseURL) throw new Error("Playwright baseURL is required");
    await page.setViewportSize(surface.viewport);
    const managedOrigin = await installManagedOriginProxy(page, baseURL);
    const documentRequests: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    const consoleMessages: Array<{ type: string; text: string }> = [];
    let notificationRequests = 0;
    let releasePersonal: (() => void) | undefined;
    const personalGate = new Promise<void>((resolve) => {
      releasePersonal = resolve;
    });
    const personalRequests = await installAuthenticatedPersonalRoutes(
      page,
      managedOrigin,
      personalGate,
    );

    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/notifications")) {
        notificationRequests += 1;
      }
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        documentRequests.push(request.url());
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => {
      requestFailures.push(
        `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
      );
    });
    page.on("console", (message) => {
      consoleMessages.push({ type: message.type(), text: message.text() });
    });
    await page.goto(`${managedOrigin}/join`);
    await expect(page.getByText(/Opening your personal Eliza/)).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.dataset.loginDocument = "survived";
    });
    releasePersonal?.();

    await expect.poll(personalRequests).toBe(1);
    await expect(page.locator("html")).toHaveAttribute(
      "data-login-document",
      "survived",
    );
    await expect(page).toHaveURL(`${managedOrigin}/`);
    await expect(page.getByTestId("home-screen")).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(1_000);

    expect(documentRequests).toHaveLength(1);
    expect(personalRequests()).toBe(1);
    expect(new URL(documentRequests[0]).pathname).toBe("/join");
    expect(notificationRequests).toBe(0);
    await expect(page.getByText("Notifications unavailable")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
    expect(requestFailures).toEqual([]);

    if (process.env.E2E_RECORD === "1") {
      await page.screenshot({
        path: testInfo.outputPath(
          `${surface.name}-authenticated-same-document.png`,
        ),
        fullPage: true,
      });
      await writeFile(
        testInfo.outputPath(`${surface.name}-authenticated-observations.json`),
        `${JSON.stringify(
          {
            head: process.env.GITHUB_SHA ?? "local-exact-head",
            entryPath: "/join",
            finalUrl: page.url(),
            documentRequests,
            personalRequests: personalRequests(),
            notificationRequests,
            pageErrors,
            requestFailures,
            consoleMessages,
            documentMarker: await page
              .locator("html")
              .getAttribute("data-login-document"),
          },
          null,
          2,
        )}\n`,
      );
    }
  });
}

for (const surface of SURFACES) {
  for (const entryPath of ["/", "/login?intent=launch"] as const) {
    test(`signed-out managed entry ${entryPath} settles on one login document (${surface.name})`, async ({
      page,
      baseURL,
    }, testInfo) => {
      if (!baseURL) throw new Error("Playwright baseURL is required");
      await page.setViewportSize(surface.viewport);
      const managedOrigin = await installManagedOriginProxy(page, baseURL);
      const documentRequests: string[] = [];
      const failures: string[] = [];
      const consoleMessages: Array<{ type: string; text: string }> = [];

      page.on("request", (request) => {
        if (
          request.isNavigationRequest() &&
          request.frame() === page.mainFrame()
        ) {
          documentRequests.push(request.url());
        }
      });
      page.on("pageerror", (error) => failures.push(error.message));
      page.on("console", (message) => {
        consoleMessages.push({ type: message.type(), text: message.text() });
      });
      page.on("requestfailed", (request) => {
        failures.push(
          `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
        );
      });

      await page.goto(`${managedOrigin}${entryPath}`);
      const heading = page.getByRole("heading", { name: "Sign in" });
      await expect(heading).toBeVisible();
      await expect(page.getByText("Taking you to Eliza sign in")).toHaveCount(
        0,
      );
      const stableHeading = await heading.elementHandle();
      if (!stableHeading) throw new Error("Login heading did not mount");
      await stableHeading.evaluate((element) => {
        element.setAttribute("data-login-stability-probe", "mounted");
      });

      // This spans the managed handoff fallback deadline. The former path
      // remounted after five seconds even when no bridgeable session existed.
      await page.waitForTimeout(STABILITY_WINDOW_MS);

      await expect(heading).toHaveAttribute(
        "data-login-stability-probe",
        "mounted",
      );
      expect(
        await stableHeading.evaluate((element) => element.isConnected),
      ).toBe(true);
      expect(new URL(page.url()).hostname).toBe("cloud.eliza.app");
      expect(new URL(page.url()).pathname).toBe("/login");
      expect(
        documentRequests.map((url) => new URL(url).hostname),
        "the signed-out path must never load an auth-bridge document",
      ).toEqual(["cloud.eliza.app"]);
      expect(failures).toEqual([]);

      if (process.env.E2E_RECORD === "1") {
        await page.screenshot({
          path: testInfo.outputPath(`${surface.name}-stable-login.png`),
          fullPage: true,
        });
        await writeFile(
          testInfo.outputPath(`${surface.name}-frontend-observations.json`),
          `${JSON.stringify(
            {
              head: process.env.GITHUB_SHA ?? "local-exact-head",
              entryPath,
              finalUrl: page.url(),
              documentRequests,
              failures,
              consoleMessages,
              stabilityWindowMs: STABILITY_WINDOW_MS,
              stableHeadingConnected: await stableHeading.evaluate(
                (element) => element.isConnected,
              ),
            },
            null,
            2,
          )}\n`,
        );
      }
    });
  }
}

for (const surface of SURFACES) {
  test(`hosted OAuth leaves through the current login document without a popup (${surface.name})`, async ({
    page,
    baseURL,
  }, testInfo) => {
    test.skip(
      TEST_AUTH_ENABLED,
      "requires the real signed-out login surface, not the test-auth shell",
    );
    if (!baseURL) throw new Error("Playwright baseURL is required");
    await page.setViewportSize(surface.viewport);
    const documentRequests: string[] = [];
    const failures: string[] = [];
    const consoleMessages: Array<{ type: string; text: string }> = [];
    let popupCount = 0;
    let authorizeRequests = 0;

    page.on("popup", () => {
      popupCount += 1;
    });
    page.on("request", (request) => {
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        documentRequests.push(request.url());
      }
    });
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("console", (message) => {
      consoleMessages.push({ type: message.type(), text: message.text() });
    });
    page.on("requestfailed", (request) => {
      failures.push(
        `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
      );
    });
    await page.route("**/auth/providers", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(PROVIDERS),
      });
    });
    await page.route("**/auth/oauth/google/authorize**", async (route) => {
      authorizeRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>OAuth handoff</title><h1>OAuth handoff</h1>",
      });
    });

    await page.addInitScript(() => {
      window.addEventListener("pageshow", (event) => {
        Object.defineProperty(window, "__elizaLoginHistoryRestore", {
          configurable: true,
          value: event.persisted,
        });
      });
    });

    // Loopback is a browser trustworthy origin, so this reaches the real
    // WebCrypto-backed PKCE boundary. The canonical-host HTTP proxy used by
    // the handoff tests is intentionally not secure and cannot expose subtle.
    await page.goto(new URL("/login?returnTo=%2F", baseURL).toString());
    const google = page.getByRole("button", { name: "Google", exact: true });
    await expect(google).toBeVisible();

    await google.click();

    await expect(
      page.getByRole("heading", { name: "OAuth handoff" }),
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toContain(
      "/auth/oauth/google/authorize",
    );
    expect(popupCount).toBe(0);
    expect(authorizeRequests).toBe(1);
    expect(documentRequests.map((url) => new URL(url).pathname)).toEqual([
      "/login",
      expect.stringContaining("/auth/oauth/google/authorize"),
    ]);
    expect(failures).toEqual([]);
    expect(
      consoleMessages.filter((message) => message.type === "error"),
    ).toEqual([]);

    await page.goBack();
    await expect(google).toBeVisible();
    await expect(google).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Discord", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "GitHub", exact: true }),
    ).toBeEnabled();
    const restoredFromHistory = await page.evaluate(
      () =>
        (
          window as typeof window & {
            __elizaLoginHistoryRestore?: boolean;
          }
        ).__elizaLoginHistoryRestore,
    );
    expect(restoredFromHistory).toEqual(expect.any(Boolean));
    await page.waitForTimeout(STABILITY_WINDOW_MS);
    await expect(google).toBeEnabled();
    const expectedDocumentPaths: Array<
      string | ReturnType<typeof expect.stringContaining>
    > = ["/login", expect.stringContaining("/auth/oauth/google/authorize")];
    if (!restoredFromHistory) expectedDocumentPaths.push("/login");
    expect(documentRequests.map((url) => new URL(url).pathname)).toEqual(
      expectedDocumentPaths,
    );
    expect(popupCount).toBe(0);
    expect(authorizeRequests).toBe(1);
    expect(failures).toEqual([]);
    expect(
      consoleMessages.filter((message) => message.type === "error"),
    ).toEqual([]);

    if (process.env.E2E_RECORD === "1") {
      await page.screenshot({
        path: testInfo.outputPath(`${surface.name}-oauth-current-document.png`),
        fullPage: true,
      });
      await writeFile(
        testInfo.outputPath(`${surface.name}-oauth-navigation.json`),
        `${JSON.stringify(
          {
            head: process.env.GITHUB_SHA ?? "local-exact-head",
            finalUrl: page.url(),
            documentRequests,
            popupCount,
            authorizeRequests,
            restoredFromHistory,
            failures,
            consoleMessages,
          },
          null,
          2,
        )}\n`,
      );
    }
  });
}

for (const surface of SURFACES) {
  test(`email callback reaches chat without replacing the document (${surface.name})`, async ({
    page,
    baseURL,
  }, testInfo) => {
    test.skip(
      !TEST_AUTH_ENABLED,
      "requires VITE_PLAYWRIGHT_TEST_AUTH=true in the renderer build",
    );
    if (!baseURL) throw new Error("Playwright baseURL is required");
    await page.setViewportSize(surface.viewport);
    const managedOrigin = await installManagedOriginProxy(page, baseURL);
    const personalRequests = await installAuthenticatedPersonalRoutes(
      page,
      managedOrigin,
    );
    let sessionSyncRequests = 0;
    await page.route("**/api/auth/steward-session", async (route) => {
      sessionSyncRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    });
    const documentRequests: string[] = [];
    const failures: string[] = [];
    page.on("request", (request) => {
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        documentRequests.push(request.url());
      }
    });
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("requestfailed", (request) => {
      failures.push(
        `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
      );
    });

    await page.goto(
      `${managedOrigin}/auth/callback/email?token=playwright-email-token&email=managed-handoff%40test.local`,
    );
    await page.evaluate(() => {
      document.documentElement.dataset.emailCallbackDocument = "survived";
    });
    await expect(
      page.getByRole("heading", { name: "Signed in" }),
    ).toBeVisible();
    await expect(page).toHaveURL(`${managedOrigin}/`, { timeout: 15_000 });
    await expect(page.getByTestId("home-screen")).toBeVisible({
      timeout: 15_000,
    });

    expect(documentRequests).toHaveLength(1);
    expect(new URL(documentRequests[0]).pathname).toBe("/auth/callback/email");
    expect(sessionSyncRequests).toBe(1);
    expect(personalRequests()).toBe(1);
    await expect(page.locator("html")).toHaveAttribute(
      "data-email-callback-document",
      "survived",
    );
    expect(failures).toEqual([]);

    if (process.env.E2E_RECORD === "1") {
      await page.screenshot({
        path: testInfo.outputPath(
          `${surface.name}-email-callback-same-document.png`,
        ),
        fullPage: true,
      });
      await writeFile(
        testInfo.outputPath(`${surface.name}-email-callback-observations.json`),
        `${JSON.stringify(
          {
            head: process.env.GITHUB_SHA ?? "local-exact-head",
            entryPath: "/auth/callback/email",
            finalUrl: page.url(),
            documentRequests,
            sessionSyncRequests,
            personalRequests: personalRequests(),
            failures,
            documentMarker: await page
              .locator("html")
              .getAttribute("data-email-callback-document"),
          },
          null,
          2,
        )}\n`,
      );
    }
  });
}

for (const surface of SURFACES) {
  test(`messaging continuation opens chat without replacing the document (${surface.name})`, async ({
    page,
    baseURL,
  }, testInfo) => {
    test.skip(
      !TEST_AUTH_ENABLED,
      "requires VITE_PLAYWRIGHT_TEST_AUTH=true in the renderer build",
    );
    if (!baseURL) throw new Error("Playwright baseURL is required");
    await page.setViewportSize(surface.viewport);
    const managedOrigin = await installManagedOriginProxy(page, baseURL);
    const personalRequests = await installAuthenticatedPersonalRoutes(
      page,
      managedOrigin,
    );
    await page.route("**/api/eliza-app/onboarding/chat**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              platform: "discord",
              platformUserId: "1234567890",
              platformDisplayName: "managed-login-test",
              returnUrl: null,
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: { linked: true } }),
      });
    });
    const documentRequests: string[] = [];
    const failures: string[] = [];
    page.on("request", (request) => {
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        documentRequests.push(request.url());
      }
    });
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("requestfailed", (request) => {
      failures.push(
        `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
      );
    });

    await page.goto(
      `${managedOrigin}/get-started?onboardingSession=${ONBOARDING_TOKEN}`,
    );
    await page.evaluate(() => {
      document.documentElement.dataset.messagingContinuationDocument =
        "survived";
    });
    await expect(page.getByText("managed-login-test")).toBeVisible();
    await page
      .getByRole("button", { name: "Connect this Discord account" })
      .click();
    await expect(
      page.getByRole("heading", { name: "You're connected" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Or chat here instead" }).click();
    await expect(page).toHaveURL(`${managedOrigin}/`, { timeout: 15_000 });
    await expect(page.getByTestId("home-screen")).toBeVisible({
      timeout: 15_000,
    });

    expect(documentRequests).toHaveLength(1);
    expect(new URL(documentRequests[0]).pathname).toBe("/get-started");
    expect(personalRequests()).toBe(1);
    await expect(page.locator("html")).toHaveAttribute(
      "data-messaging-continuation-document",
      "survived",
    );
    expect(failures).toEqual([]);

    if (process.env.E2E_RECORD === "1") {
      await page.screenshot({
        path: testInfo.outputPath(
          `${surface.name}-messaging-continuation-same-document.png`,
        ),
        fullPage: true,
      });
      await writeFile(
        testInfo.outputPath(
          `${surface.name}-messaging-continuation-observations.json`,
        ),
        `${JSON.stringify(
          {
            head: process.env.GITHUB_SHA ?? "local-exact-head",
            entryPath: "/get-started",
            finalUrl: page.url(),
            documentRequests,
            personalRequests: personalRequests(),
            failures,
            documentMarker: await page
              .locator("html")
              .getAttribute("data-messaging-continuation-document"),
          },
          null,
          2,
        )}\n`,
      );
    }
  });
}
