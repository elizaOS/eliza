/**
 * Proves ordinary local development uses the staging Cloud tuple through the
 * real Vite transform: Cloud-only onboarding and the hosted staging CLI-session
 * boundary that safely returns to localhost. The compatibility
 * `dev:cloud-only` lane exercises the same contract.
 */

import { mkdir } from "node:fs/promises";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  expectNoRenderTelemetryErrors,
  installDefaultAppRoutes,
  installRenderTelemetryGuard,
  seedAppStorage,
} from "../ui-smoke/helpers";

const STAGING_SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

async function fulfillJson(
  route: Route,
  body: Record<string, unknown>,
): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

interface CloudAuthRouteState {
  agentLoginPosts: number;
  directSessionOrigins: string[];
  directSessionPosts: number;
  hostedLoginGets: number;
  providerDiscoveryGets: number;
}

async function routeFreshFirstRun(page: Page): Promise<CloudAuthRouteState> {
  const state: CloudAuthRouteState = {
    agentLoginPosts: 0,
    directSessionOrigins: [],
    directSessionPosts: 0,
    hostedLoginGets: 0,
    providerDiscoveryGets: 0,
  };

  await page.route("**/api/auth/status", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await fulfillJson(route, {
      required: false,
      authenticated: true,
      loginRequired: false,
      localAccess: true,
      passwordConfigured: false,
      pairingEnabled: false,
      expiresAt: null,
    });
  });
  await page.route("**/api/first-run/status", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await fulfillJson(route, { complete: false, cloudProvisioned: false });
  });
  await page.route("**/api/first-run/options", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await fulfillJson(route, {
      names: [],
      styles: [],
      providers: [],
      cloudProviders: [],
      models: [],
      inventoryProviders: [],
      sharedStyleRules: "",
      githubOAuthAvailable: false,
    });
  });
  await page.route("**/api/cloud/login", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    state.agentLoginPosts += 1;
    await fulfillJson(route, {
      ok: true,
      sessionId: "cloud-only-dev-smoke",
      browserUrl: "https://www.elizacloud.ai/device/cloud-only-dev-smoke",
    });
  });
  await page.route("**/api/cloud/login/status**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await fulfillJson(route, { status: "pending" });
  });

  await page.route(
    /^https:\/\/api-staging\.eliza\.app\/api\/auth\/cli-session$/,
    async (route) => {
      const origin = route.request().headers().origin ?? "";
      const corsHeaders = {
        "access-control-allow-credentials": "true",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-origin": origin,
      };
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: corsHeaders, body: "" });
        return;
      }
      if (route.request().method() !== "POST") return route.fallback();
      state.directSessionPosts += 1;
      state.directSessionOrigins.push(origin);
      await route.fulfill({
        status: 201,
        headers: {
          ...corsHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionId: STAGING_SESSION_ID }),
      });
    },
  );
  await page.route(
    new RegExp(
      `^https:\\/\\/api-staging\\.eliza\\.app\\/api\\/auth\\/cli-session\\/${STAGING_SESSION_ID}$`,
    ),
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await fulfillJson(route, { status: "pending" });
    },
  );
  await page
    .context()
    .route(
      /^https:\/\/staging\.eliza\.app\/auth\/cli-login\?.*$/,
      async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        state.hostedLoginGets += 1;
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><body><h1>Hosted staging sign-in</h1></body></html>",
        });
      },
    );

  await page.route(
    /^https:\/\/staging\.eliza\.app\/steward\/auth\/providers\/?(?:\?.*)?$/,
    async (route) => {
      const method = route.request().method();
      const origin = route.request().headers().origin ?? "*";
      const corsHeaders = {
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-origin": origin,
        "cache-control": "no-store",
      };

      if (method === "OPTIONS") {
        await route.fulfill({ status: 204, headers: corsHeaders, body: "" });
        return;
      }
      if (method !== "GET") {
        await route.abort("blockedbyclient");
        return;
      }

      state.providerDiscoveryGets += 1;
      await route.fulfill({
        status: 200,
        headers: {
          ...corsHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ok: true,
          passkey: false,
          email: true,
          sms: false,
          siwe: false,
          siws: false,
          google: false,
          discord: false,
          github: false,
          twitter: false,
          telegram: false,
          oauth: [],
        }),
      });
    },
  );

  return state;
}

async function expectCloudOnlyAuth(
  page: Page,
  localOrigin: string,
  extraPages: Page[],
): Promise<void> {
  await expect(page.getByTestId("chat-overlay")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("Hi, I'm Eliza.", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Let's get you signed in.", { exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).origin).toBe(localOrigin);
  const previousPopupCount = extraPages.length;
  await page.getByRole("button", { name: "Sign in to Eliza Cloud" }).click();
  await expect
    .poll(() => extraPages.length, { timeout: 20_000 })
    .toBe(previousPopupCount + 1);
  const loginPage = extraPages.at(-1);
  if (!loginPage) throw new Error("Cloud sign-in did not open its browser tab");
  await expect(loginPage).toHaveURL(
    /^https:\/\/staging\.eliza\.app\/auth\/cli-login\?/,
    { timeout: 20_000 },
  );
  const loginUrl = new URL(loginPage.url());
  expect(loginUrl.origin).toBe("https://staging.eliza.app");
  expect(loginUrl.pathname).toBe("/auth/cli-login");
  expect(loginUrl.searchParams.get("session")).toBe(STAGING_SESSION_ID);
  const returnTo = new URL(loginUrl.searchParams.get("returnTo") ?? "");
  expect(returnTo.origin).toBe(localOrigin);
  expect(returnTo.pathname).toBe("/");
  expect(returnTo.searchParams.get("elizaCloudLogin")).toBe("complete");
  expect(returnTo.searchParams.get("elizaCloudLoginSession")).toBe(
    STAGING_SESSION_ID,
  );
  expect(new URL(page.url()).origin).toBe(localOrigin);
  await expect(
    loginPage.getByRole("heading", {
      level: 1,
      name: "Hosted staging sign-in",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByTestId("first-run-runtime-chooser")).toHaveCount(0);
  for (const runtime of ["local", "remote"]) {
    await expect(
      page.getByTestId(`choice-__first_run__:runtime:${runtime}`),
    ).toHaveCount(0);
  }
  await loginPage.close();
  expect(page.context().pages()).toEqual([page]);
}

async function capture(page: Page, outputPath: string): Promise<void> {
  await page.screenshot({ path: outputPath, fullPage: true });
}

test("ordinary Vite development offers staging Cloud sign-in", async ({
  page,
}, testInfo) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  const routeState = await routeFreshFirstRun(page);
  const configuredBaseUrl = testInfo.project.use.baseURL;
  if (typeof configuredBaseUrl !== "string") {
    throw new Error("dev-smoke requires a string Playwright baseURL");
  }
  const localOrigin = new URL(configuredBaseUrl).origin;
  const extraPages: Page[] = [];
  page.context().on("page", (openedPage) => {
    if (openedPage !== page) extraPages.push(openedPage);
  });
  await seedAppStorage(page, {
    "eliza:first-run-complete": "",
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expectCloudOnlyAuth(page, localOrigin, extraPages);
  expect(routeState.directSessionPosts).toBe(1);
  expect(routeState.directSessionOrigins).toEqual([localOrigin]);
  expect(routeState.hostedLoginGets).toBe(1);
  expect(routeState.providerDiscoveryGets).toBe(0);
  expect(routeState.agentLoginPosts).toBe(0);
  await expectNoRenderTelemetryErrors(page, "cloud-only Vite development");

  await mkdir(testInfo.outputDir, { recursive: true });
  const desktopPath = testInfo.outputPath("cloud-only-dev-desktop.png");
  await capture(page, desktopPath);
  await testInfo.attach("cloud-only-dev-desktop", {
    path: desktopPath,
    contentType: "image/png",
  });

  const desktopDirectSessionPosts = routeState.directSessionPosts;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expectCloudOnlyAuth(page, localOrigin, extraPages);
  expect(routeState.directSessionPosts).toBe(desktopDirectSessionPosts + 1);
  expect(routeState.directSessionOrigins.at(-1)).toBe(localOrigin);
  expect(routeState.hostedLoginGets).toBe(2);
  expect(routeState.providerDiscoveryGets).toBe(0);
  expect(routeState.agentLoginPosts).toBe(0);
  await expectNoRenderTelemetryErrors(
    page,
    "cloud-only Vite development mobile reload",
  );
  const mobilePath = testInfo.outputPath("cloud-only-dev-mobile.png");
  await capture(page, mobilePath);
  await testInfo.attach("cloud-only-dev-mobile", {
    path: mobilePath,
    contentType: "image/png",
  });
});
