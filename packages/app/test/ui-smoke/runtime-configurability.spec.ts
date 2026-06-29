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
// renders: Cloud, Local, Remote. It then drives each branch (including the
// Local → provider sub-choice) to prove every runtime is reachable and
// configurable, not just displayed. The single first-run surface is the in-chat
// FirstRunChat (StartupScreen → FirstRunChat); the full-screen onboarding gate
// was removed.

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

async function expectFirstRun(page: Page) {
  const firstRun = page.getByTestId("first-run-chat");
  await expect(firstRun).toBeVisible({ timeout: 20_000 });
  return firstRun;
}

test("first-run exposes local, cloud, and remote runtimes and each is configurable", async ({
  page,
}) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);
  await injectFullCapabilityHost(page);
  await seedAppStorage(page, { "eliza:first-run-complete": "" });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  const firstRun = await expectFirstRun(page);
  await expect(page.getByTestId("first-run-greeting")).toBeVisible({
    timeout: 15_000,
  });

  // All three runtimes are offered as in-chat ChoiceWidget options on a
  // full-capability host.
  const cloud = page.getByTestId("choice-cloud");
  const local = page.getByTestId("choice-local");
  const remote = page.getByTestId("choice-remote");
  await expect(cloud).toBeVisible({ timeout: 15_000 });
  await expect(local).toBeVisible();
  await expect(remote).toBeVisible();

  // Local is configurable: selecting it advances to the provider sub-choice,
  // where both Eliza Cloud and the on-device default are offered.
  await local.click();
  await expect(page.getByTestId("choice-elizacloud")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("choice-on-device")).toBeVisible();
  await expect(page.getByText("Where should I run my AI?")).toBeVisible();

  // Remote is configurable: selecting it advances to the endpoint + token form
  // so another device can point at this machine. Back returns to the options.
  await remote.click();
  await expect(page.getByTestId("first-run-remote-address")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("choice-connect")).toBeVisible();
  await page.getByTestId("choice-back").click();
  await expect(cloud).toBeVisible({ timeout: 10_000 });

  await expectNoRenderTelemetryErrors(page, "runtime configurability");
  await expect(firstRun).toBeVisible();
});

test("first-run survives browser back and forward while runtime choices churn", async ({
  page,
}) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);
  await injectFullCapabilityHost(page);
  await seedAppStorage(page, { "eliza:first-run-complete": "" });

  // runtimeTarget=remote opens the first-run flow directly on the remote connect
  // form (the controller seeds step="remote" for that target).
  await page.goto("/?runtime=first-run&runtimeTarget=remote", {
    waitUntil: "domcontentloaded",
  });
  await expectFirstRun(page);
  await expect(page.getByPlaceholder("https://agent.example.com")).toBeVisible({
    timeout: 15_000,
  });

  // Churn the runtime target via the URL + browser history; the first-run
  // surface must survive every transition without crashing or freezing.
  await page.goto("/?runtime=first-run&runtimeTarget=local", {
    waitUntil: "domcontentloaded",
  });
  await expectFirstRun(page);
  await page.goBack({ waitUntil: "domcontentloaded" });
  await expectFirstRun(page);
  await page.goForward({ waitUntil: "domcontentloaded" });
  await expectFirstRun(page);

  await expectNoRenderTelemetryErrors(page, "runtime browser history");
});
