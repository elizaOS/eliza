/**
 * Proves ordinary local development uses the staging Cloud tuple through the
 * real Vite transform: Cloud-only onboarding, local `/login`, and staging
 * Cloud/Steward boundaries. The compatibility `dev:cloud-only` lane exercises
 * the same contract.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  expectNoRenderTelemetryErrors,
  installDefaultAppRoutes,
  installRenderTelemetryGuard,
  seedAppStorage,
} from "../ui-smoke/helpers";

const stewardConfigAbsolutePath = path
  .resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../ui/src/cloud/shell/steward-config.ts",
  )
  .split(path.sep)
  .join("/");
const STEWARD_CONFIG_MODULE_URL = `/@fs/${stewardConfigAbsolutePath.replace(/^\/+/, "")}`;

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
  providerDiscoveryGets: number;
}

async function routeFreshFirstRun(page: Page): Promise<CloudAuthRouteState> {
  const state: CloudAuthRouteState = {
    agentLoginPosts: 0,
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
  await expect(page).toHaveURL(/\/login\?returnTo=/, { timeout: 20_000 });
  const loginUrl = new URL(page.url());
  expect(
    loginUrl.origin,
    "the original localhost page must own the Steward login surface",
  ).toBe(localOrigin);
  expect(loginUrl.pathname).toBe("/login");
  expect(loginUrl.searchParams.get("returnTo")).toBe("/");
  expect(
    extraPages,
    "same-tab Cloud sign-in must never open a popup or second page",
  ).toHaveLength(0);
  expect(page.context().pages()).toHaveLength(1);
  expect(page.context().pages()[0]).toBe(page);
  await expect(
    page.getByRole("heading", { level: 1, name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("first-run-runtime-chooser")).toHaveCount(0);
  for (const runtime of ["local", "remote"]) {
    await expect(
      page.getByTestId(`choice-__first_run__:runtime:${runtime}`),
    ).toHaveCount(0);
  }
}

async function capture(page: Page, outputPath: string): Promise<void> {
  await page.screenshot({ path: outputPath, fullPage: true });
}

test("ordinary Vite development defaults to staging Cloud sign-in", async ({
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
  await expect.poll(() => routeState.providerDiscoveryGets).toBeGreaterThan(0);
  expect(routeState.agentLoginPosts).toBe(0);
  const stewardConfig = await page.evaluate(async (moduleUrl) => {
    const loaded = (await import(/* @vite-ignore */ moduleUrl)) as {
      configuredStewardApiUrlOverride: () => string | undefined;
      configuredStewardTenantId: () => string | undefined;
    };
    return {
      apiUrl: loaded.configuredStewardApiUrlOverride(),
      tenantId: loaded.configuredStewardTenantId(),
    };
  }, STEWARD_CONFIG_MODULE_URL);
  expect(stewardConfig).toEqual({
    apiUrl: "https://staging.eliza.app/steward",
    tenantId: "elizacloud-staging",
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __ELIZAOS_APP_BOOT_CONFIG__?: { cloudApiBase?: string };
            }
          ).__ELIZAOS_APP_BOOT_CONFIG__?.cloudApiBase ?? "",
      ),
    )
    .toBe("https://cloud-staging.eliza.app");
  expect(
    await page.evaluate(() =>
      localStorage.getItem("eliza:enable-runtime-chooser"),
    ),
  ).toBeNull();
  await expectNoRenderTelemetryErrors(page, "cloud-only Vite development");

  await mkdir(testInfo.outputDir, { recursive: true });
  const desktopPath = testInfo.outputPath("cloud-only-dev-desktop.png");
  await capture(page, desktopPath);
  await testInfo.attach("cloud-only-dev-desktop", {
    path: desktopPath,
    contentType: "image/png",
  });

  const desktopProviderDiscoveryGets = routeState.providerDiscoveryGets;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expectCloudOnlyAuth(page, localOrigin, extraPages);
  await expect
    .poll(() => routeState.providerDiscoveryGets)
    .toBeGreaterThan(desktopProviderDiscoveryGets);
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
