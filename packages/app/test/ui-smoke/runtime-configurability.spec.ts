import { expect, type Page, type Route, test } from "@playwright/test";
import {
  expectNoRenderTelemetryErrors,
  installDefaultAppRoutes,
  installRenderTelemetryGuard,
  seedAppStorage,
} from "./helpers";

// "Local, Cloud, etc. all work out of the box and are successfully
// configurable." The production web bundle is cloud-only, so the onboarding
// runtime selector normally shows Cloud alone (see first-run-startup.spec.ts).
// This spec injects the host signals a desktop/device shell sets before React
// boots — an API base (flips `cloudOnly` → false) and the Electrobun window
// marker (flips `canSelectLocalRuntime` → true) — so the full runtime matrix
// renders: Cloud, Local, Remote. It then drives each branch to prove every
// runtime is reachable and configurable, not just displayed.

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

async function expectFirstRunSurface(page: Page) {
  const surface = page.getByTestId("onboarding-toast");
  await expect(surface).toBeVisible({ timeout: 20_000 });
  return surface;
}

test("onboarding exposes local, cloud, and remote runtimes and each is configurable", async ({
  page,
}) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);
  await injectFullCapabilityHost(page);
  await seedAppStorage(page, { "eliza:first-run-complete": "" });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  const toast = await expectFirstRunSurface(page);
  await expect(page.getByText("Choose how to run your agent")).toBeVisible();
  // All three runtimes are offered as option cards on the compact surface.
  await expect(page.getByTestId("onboarding-option-cloud")).toBeVisible();
  await expect(page.getByTestId("onboarding-option-remote")).toBeVisible();
  await expect(page.getByTestId("onboarding-option-local")).toBeVisible();
  await expect(toast).toBeVisible();
  await expectNoRenderTelemetryErrors(page, "compact runtime configurability");
});

test("onboarding survives browser back and forward while runtime choices churn", async ({
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
  const shell = await expectFirstRunSurface(page);
  if (!(await hasDetailedFirstRunShell(page))) {
    // runtimeTarget=remote opens the compact surface directly on the remote
    // connect form (the controller seeds step="remote" for that target).
    await expect(
      page.getByPlaceholder("https://agent.example.com"),
    ).toBeVisible();
    await page.goto("/?runtime=first-run&runtimeTarget=local", {
      waitUntil: "domcontentloaded",
    });
    await expectFirstRunSurface(page);
    await page.goBack({ waitUntil: "domcontentloaded" });
    await expectFirstRunSurface(page);
    await page.goForward({ waitUntil: "domcontentloaded" });
    await expectFirstRunSurface(page);
    await expectNoRenderTelemetryErrors(
      page,
      "compact runtime browser history",
    );
    return;
  }
  await expect(page.getByRole("button", { name: /runtime/i })).toBeVisible({
    timeout: 10_000,
  });

  await page.goto("/?runtime=first-run&runtimeTarget=local", {
    waitUntil: "domcontentloaded",
  });
  await expect(shell).toBeVisible({ timeout: 20_000 });
  const allLocal = page.getByTestId("first-run-local-all-local");
  await expect(allLocal).toBeVisible({ timeout: 10_000 });

  await page.goBack({ waitUntil: "domcontentloaded" });
  await expect(shell).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /runtime/i })).toBeVisible({
    timeout: 10_000,
  });

  await page.goForward({ waitUntil: "domcontentloaded" });
  await expect(shell).toBeVisible({ timeout: 20_000 });
  await expect(allLocal).toBeVisible({ timeout: 10_000 });
  await page.goBack({ waitUntil: "domcontentloaded" });
  await expect(shell).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: /runtime/i }).click();
  const cloud = page.getByTestId("first-run-runtime-cloud");
  await expect(cloud).toBeVisible({ timeout: 10_000 });
  await cloud.click();
  await expect(allLocal).toHaveCount(0);

  await expectNoRenderTelemetryErrors(page, "runtime browser history");
});
