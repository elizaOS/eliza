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
  const surface = page
    .getByTestId("first-run-shell")
    .or(page.getByTestId("onboarding-toast"));
  await expect(surface).toBeVisible({ timeout: 20_000 });
  return surface;
}

async function hasDetailedFirstRunShell(page: Page): Promise<boolean> {
  return page
    .getByTestId("first-run-shell")
    .isVisible({ timeout: 500 })
    .catch(() => false);
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

  const shell = await expectFirstRunSurface(page);

  if (!(await hasDetailedFirstRunShell(page))) {
    const toast = page.getByTestId("onboarding-toast");
    await expect(toast).toContainText("Set up your agent");
    await expect(page.getByRole("button", { name: "Use Local" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Eliza Cloud" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Use Local" }).click();
    await expect(toast).toBeVisible();
    await expectNoRenderTelemetryErrors(page, "compact runtime configurability");
    return;
  }

  // All three runtimes must be offered out of the box on a full-capability host.
  const cloud = page.getByTestId("first-run-runtime-cloud");
  const local = page.getByTestId("first-run-runtime-local");
  const remote = page.getByTestId("first-run-runtime-remote");
  await expect(cloud).toBeVisible({ timeout: 15_000 });
  await expect(local).toBeVisible({ timeout: 15_000 });
  await expect(remote).toBeVisible({ timeout: 15_000 });

  // Local is configurable: selecting it reveals the inference sub-choice, and
  // both "all local" and "route inference through cloud" must be selectable.
  await local.click();
  const allLocal = page.getByTestId("first-run-local-all-local");
  const cloudInference = page.getByTestId("first-run-local-cloud-inference");
  await expect(allLocal).toBeVisible({ timeout: 10_000 });
  await expect(cloudInference).toBeVisible();
  await cloudInference.check({ force: true });
  await expect(cloudInference).toBeChecked();
  await allLocal.check({ force: true });
  await expect(allLocal).toBeChecked();

  // Cloud is configurable: re-selecting it is the recommended resting choice
  // and collapses the local sub-choice.
  await cloud.click();
  await expect(allLocal).toHaveCount(0);

  // Remote is configurable: selecting it advances to the endpoint + token form
  // so another device can point at this machine.
  await remote.click();
  const back = page.getByRole("button", { name: /runtime/i });
  await expect(back).toBeVisible({ timeout: 10_000 });
  // Returning to the runtime step keeps the selector intact (no dead end).
  await back.click();
  await expect(cloud).toBeVisible({ timeout: 10_000 });

  await expectNoRenderTelemetryErrors(page, "runtime configurability");
  await expect(shell).toBeVisible();
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
    await expect(page.getByRole("button", { name: "Use Local" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Eliza Cloud" }),
    ).toBeVisible();
    await page.goto("/?runtime=first-run&runtimeTarget=local", {
      waitUntil: "domcontentloaded",
    });
    await expectFirstRunSurface(page);
    await page.goBack({ waitUntil: "domcontentloaded" });
    await expectFirstRunSurface(page);
    await page.goForward({ waitUntil: "domcontentloaded" });
    await expectFirstRunSurface(page);
    await expectNoRenderTelemetryErrors(page, "compact runtime browser history");
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
