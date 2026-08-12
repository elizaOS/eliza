/**
 * Proves the runtime chooser's default through the real `bun run dev` Vite
 * transform and renderer, with deterministic first-run HTTP boundaries.
 */

import { mkdir } from "node:fs/promises";
import {
  expect,
  type Locator,
  type Page,
  type Request,
  type Route,
  test,
} from "@playwright/test";
import {
  expectNoRenderTelemetryErrors,
  installDefaultAppRoutes,
  installRenderTelemetryGuard,
  seedAppStorage,
} from "../ui-smoke/helpers";

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

async function routeFreshFirstRun(page: Page): Promise<void> {
  await page.route("**/api/auth/status", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
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
    if (route.request().method() !== "GET") return route.fallback();
    await fulfillJson(route, 200, { complete: false, cloudProvisioned: false });
  });
}

async function reloadWithTransientNetworkRecovery(
  page: Page,
  ready: Locator,
): Promise<void> {
  let sawNetworkChange = false;
  const recordRequestFailure = (request: Request): void => {
    if (request.failure()?.errorText === "net::ERR_NETWORK_CHANGED") {
      sawNetworkChange = true;
    }
  };

  page.on("requestfailed", recordRequestFailure);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    try {
      await expect(ready).toBeVisible();
    } catch (error) {
      // error-policy:J1 The Playwright boundary retries only the browser's
      // explicit transient network-change failure, then asserts normally.
      if (!sawNetworkChange) throw error;

      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(ready).toBeVisible();
    }
  } finally {
    page.off("requestfailed", recordRequestFailure);
  }
}

test("Vite development offers cloud, local, and remote without an override", async ({
  page,
}, testInfo) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFreshFirstRun(page);
  await page.addInitScript(() => {
    const win = window as unknown as Record<string, unknown>;
    win.__ELIZA_APP_API_BASE__ = window.location.origin;
    win.__ELIZAOS_APP_BOOT_CONFIG__ = { apiBase: window.location.origin };
    win.__electrobunWindowId = 1;
  });
  await seedAppStorage(page, {
    "eliza:first-run-complete": "",
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(
    page.getByText("First, where should your agent run?", { exact: false }),
  ).toBeVisible({ timeout: 20_000 });
  for (const runtime of ["cloud", "local", "remote"]) {
    await expect(
      page.getByTestId(`choice-__first_run__:runtime:${runtime}`),
    ).toBeVisible();
  }
  expect(
    await page.evaluate(() =>
      localStorage.getItem("eliza:enable-runtime-chooser"),
    ),
  ).toBeNull();
  await expectNoRenderTelemetryErrors(page, "Vite development runtime chooser");

  await mkdir(testInfo.outputDir, { recursive: true });
  async function capture(name: string): Promise<void> {
    const screenshotPath = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach(name, {
      path: screenshotPath,
      contentType: "image/png",
    });
  }

  await capture("runtime-chooser-vite-development-desktop-rest");
  await page.getByTestId("choice-__first_run__:runtime:local").hover();
  await capture("runtime-chooser-vite-development-desktop-hover");

  await page.setViewportSize({ width: 390, height: 844 });
  await reloadWithTransientNetworkRecovery(
    page,
    page.getByTestId("choice-__first_run__:runtime:cloud"),
  );
  for (const runtime of ["cloud", "local", "remote"]) {
    await expect(
      page.getByTestId(`choice-__first_run__:runtime:${runtime}`),
    ).toBeVisible();
  }
  await capture("runtime-chooser-vite-development-mobile-rest");

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() =>
    localStorage.setItem("eliza:enable-runtime-chooser", "0"),
  );
  await reloadWithTransientNetworkRecovery(
    page,
    page.getByText("Sign in to Eliza Cloud", { exact: true }),
  );
  await expect(
    page.getByText("Sign in to Eliza Cloud", { exact: true }),
  ).toBeVisible();
  for (const runtime of ["local", "remote"]) {
    await expect(
      page.getByTestId(`choice-__first_run__:runtime:${runtime}`),
    ).toHaveCount(0);
  }
  await capture("runtime-chooser-before-cloud-only-desktop");
});
