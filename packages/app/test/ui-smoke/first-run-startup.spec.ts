import { expect, type Page, type Route, test } from "@playwright/test";
import {
  expectNoRenderTelemetryErrors,
  installDefaultAppRoutes,
  installRenderTelemetryGuard,
  seedAppStorage,
} from "./helpers";

// Every other ui-smoke spec seeds `eliza:first-run-complete = "1"`, so the
// onboarding surface (FirstRunScreen → FirstRunShell, "Where should Eliza
// run?") never gets render-telemetry coverage. That surface is exactly where
// the agent-start render loop froze onboarding, so this spec lands on it with
// the guard armed and drives the runtime selection that preceded the freeze.

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

test("first-run onboarding renders without a render loop and lets the runtime be chosen", async ({
  page,
}) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);
  // Land on a fresh device: no persisted first-run completion.
  await seedAppStorage(page, { "eliza:first-run-complete": "" });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  const shell = page.getByTestId("first-run-shell");
  await expect(shell).toBeVisible({ timeout: 20_000 });

  // The typed prompt reveals the runtime cards. Cloud is the recommended
  // resting choice and is always offered; the Local card only renders on
  // platforms that own their hardware (desktop / dev / ElizaOS), so the web
  // ui-smoke build legitimately omits it. Remote is always present.
  const cloud = page.getByTestId("first-run-runtime-cloud");
  await expect(cloud).toBeVisible({ timeout: 15_000 });
  const remote = page.getByTestId("first-run-runtime-remote");
  await expect(remote).toBeVisible();

  // If Local is offered, selecting it exposes the inference sub-choice — drive
  // that branch too. Otherwise churn the Cloud selection to exercise the same
  // re-render path that previously froze onboarding.
  const local = page.getByTestId("first-run-runtime-local");
  if (await local.count()) {
    await local.click();
    await expect(
      page.getByTestId("first-run-local-all-local"),
    ).toBeVisible({ timeout: 10_000 });
    await cloud.click();
  } else {
    // Stay on the runtime step (clicking Remote navigates away). Re-selecting
    // Cloud repeatedly re-renders the selector — the same churn path that
    // previously froze onboarding.
    for (let i = 0; i < 4; i++) {
      await cloud.click();
    }
  }

  // Dwell so any churn-driven loop would cross the telemetry error threshold.
  await page.waitForTimeout(4_000);

  await expectNoRenderTelemetryErrors(page, "first-run onboarding");
  await expect(shell).toBeVisible();
});
