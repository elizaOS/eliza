/**
 * Proves the explicit cloud-only development lane through the real Vite
 * transform and renderer, without changing the ordinary development default.
 */

import { mkdir } from "node:fs/promises";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  expectNoRenderTelemetryErrors,
  installDefaultAppRoutes,
  installRenderTelemetryGuard,
  seedAppStorage,
} from "../ui-smoke/helpers";

test.skip(
  process.env.ELIZA_DEV_SMOKE_CLOUD_ONLY !== "1",
  "runs only through test:dev-smoke:cloud-only",
);

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

async function routeFreshFirstRun(
  page: Page,
): Promise<{ loginStarts: number }> {
  const state = { loginStarts: 0 };
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
    state.loginStarts += 1;
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
  return state;
}

async function expectCloudOnlyAuth(page: Page): Promise<void> {
  await expect(page.getByText("Opening secure sign in…")).toBeVisible({
    timeout: 20_000,
  });
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

test("explicit cloud-only Vite development skips the runtime chooser", async ({
  page,
}, testInfo) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  const routeState = await routeFreshFirstRun(page);
  await seedAppStorage(page, {
    "eliza:first-run-complete": "",
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expectCloudOnlyAuth(page);
  expect(routeState.loginStarts).toBeGreaterThan(0);
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

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectCloudOnlyAuth(page);
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
