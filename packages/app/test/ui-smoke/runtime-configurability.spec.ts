import { expect, type Page, type Route, test } from "@playwright/test";
import {
  expectNoRenderTelemetryErrors,
  installDefaultAppRoutes,
  installRenderTelemetryGuard,
  seedAppStorage,
} from "./helpers";

// "Local, Cloud, etc. all work out of the box and are successfully
// configurable." Runtime/provider setup now lives in the floating first-run
// chooser: Cloud (Eliza Cloud managed), Local (this device), and Bring your own
// keys behind Advanced setup. This spec drives Local → provider to prove every
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
// the shape every desktop / device shell presents to the renderer.
async function injectFullCapabilityHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__ELIZA_APP_API_BASE__ =
      window.location.origin;
    (window as unknown as Record<string, unknown>).__ELIZA_API_BASE__ =
      window.location.origin;
    (window as unknown as Record<string, number>).__electrobunWindowId = 1;
  });
}

async function expectInChatFirstRun(page: Page): Promise<void> {
  const chatOverlay = page.getByTestId("continuous-chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 20_000 });
  const chooser = page.getByTestId("first-run-runtime-chooser");
  await expect(chooser).toBeVisible({ timeout: 20_000 });
  await expect(
    chooser.getByText("Choose how Eliza should run", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
}

test("first-run chooser exposes cloud, local, and bring-your-own-keys runtimes and Local is configurable", async ({
  page,
}) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);
  await injectFullCapabilityHost(page);
  await seedAppStorage(page, { "eliza:first-run-complete": "" });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expectInChatFirstRun(page);

  const chooser = page.getByTestId("first-run-runtime-chooser");
  const cloud = chooser.getByTestId("first-run-chooser-cloud");
  const local = chooser.getByTestId("first-run-chooser-local");
  const other = chooser.getByTestId("first-run-chooser-other");
  await expect(cloud).toBeVisible({ timeout: 15_000 });
  await expect(local).toBeVisible();
  await chooser.getByRole("button", { name: /Advanced setup/i }).click();
  await expect(other).toBeVisible();

  // Local is configurable: selecting it advances to the provider step,
  // where the on-device default, Eliza Cloud inference, and other are offered.
  await local.click();
  await expect(chooser.getByTestId("first-run-provider-on-device")).toBeVisible(
    { timeout: 15_000 },
  );
  await expect(
    chooser.getByTestId("first-run-provider-elizacloud"),
  ).toBeVisible();
  await expect(chooser.getByTestId("first-run-provider-other")).toBeVisible();
  await expect(
    chooser.getByText("Choose how Eliza should think", { exact: true }),
  ).toBeVisible();

  await expectNoRenderTelemetryErrors(page, "runtime configurability");
  await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible();
});

test("in-chat first-run survives browser back and forward while it churns", async ({
  page,
}) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);
  await injectFullCapabilityHost(page);
  await seedAppStorage(page, { "eliza:first-run-complete": "" });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expectInChatFirstRun(page);

  // Churn navigation via the browser history; the in-chat first-run surface must
  // survive every transition without crashing or freezing (the conductor re-seeds
  // the greeting into the live transcript on each shell remount).
  await page.goto("/?runtime=first-run", { waitUntil: "domcontentloaded" });
  await expectInChatFirstRun(page);
  await page.goBack({ waitUntil: "domcontentloaded" });
  await expectInChatFirstRun(page);
  await page.goForward({ waitUntil: "domcontentloaded" });
  await expectInChatFirstRun(page);

  await expectNoRenderTelemetryErrors(page, "runtime browser history");
});
