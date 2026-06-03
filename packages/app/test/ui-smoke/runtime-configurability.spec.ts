import { expect, type Page, type Route, test } from "@playwright/test";
import {
  expectNoRenderTelemetryErrors,
  installDefaultAppRoutes,
  installRenderTelemetryGuard,
  seedAppStorage,
} from "./helpers";

// Startup first-run now uses compact onboarding. The production web bundle is
// cloud-only by default; this spec also injects the host signals a desktop shell
// sets before React boots so the local peer appears next to Eliza Cloud.

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

async function routeFirstRunIncomplete(page: Page): Promise<void> {
  await page.route("**/api/auth/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
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
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, { complete: false, cloudProvisioned: false });
  });
}

// Pretend to be a host that owns its hardware AND injects a loopback backend —
// the shape every desktop / device shell presents to the renderer. Both globals
// must exist before main.tsx evaluates, so this runs as an init script.
async function injectFullCapabilityHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__ELIZA_APP_API_BASE__ =
      window.location.origin;
    (window as unknown as Record<string, number>).__electrobunWindowId = 1;
  });
}

test("compact onboarding exposes available local and cloud runtime choices", async ({
  page,
}) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);
  await injectFullCapabilityHost(page);
  await seedAppStorage(page, { "eliza:first-run-complete": "" });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  const toast = page.getByTestId("onboarding-toast");
  await expect(toast).toBeVisible({ timeout: 20_000 });
  await expect(toast).toContainText("Set up your agent");

  const cloud = toast.getByRole("button", { name: "Eliza Cloud" });
  const local = toast.getByRole("button", { name: "Use Local" });
  await expect(cloud).toBeVisible({ timeout: 15_000 });
  await expect(local).toBeVisible({ timeout: 15_000 });

  await expectNoRenderTelemetryErrors(page, "runtime configurability");
  await expect(toast).toBeVisible();
});

test("compact onboarding survives first-run runtime target navigation", async ({
  page,
}) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);
  await injectFullCapabilityHost(page);
  await seedAppStorage(page, { "eliza:first-run-complete": "" });

  await page.goto("/?runtime=first-run&runtimeTarget=remote", {
    waitUntil: "domcontentloaded",
  });
  const toast = page.getByTestId("onboarding-toast");
  await expect(toast).toBeVisible({ timeout: 20_000 });

  await page.goto("/?runtime=first-run&runtimeTarget=local", {
    waitUntil: "domcontentloaded",
  });
  await expect(toast).toBeVisible({ timeout: 20_000 });
  await expect(toast.getByRole("button", { name: "Use Local" })).toBeVisible({
    timeout: 10_000,
  });

  await page.goBack({ waitUntil: "domcontentloaded" });
  await expect(toast).toBeVisible({ timeout: 20_000 });

  await page.goForward({ waitUntil: "domcontentloaded" });
  await expect(toast).toBeVisible({ timeout: 20_000 });
  await page.goBack({ waitUntil: "domcontentloaded" });
  await expect(toast).toBeVisible({ timeout: 20_000 });

  await expect(toast.getByRole("button", { name: "Eliza Cloud" })).toBeVisible({
    timeout: 10_000,
  });

  await expectNoRenderTelemetryErrors(page, "runtime browser history");
});
