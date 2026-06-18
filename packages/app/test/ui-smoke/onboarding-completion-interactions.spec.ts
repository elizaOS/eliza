// Onboarding completion coverage that the first-run specs can't reach: the
// detailed FirstRunShell renders reliably at the `/onboarding` route (the
// onboarding tab) once first-run is complete, bypassing the compact StartupScreen
// gate. Injecting the desktop host globals (as runtime-configurability does)
// reveals all three runtime cards, so we can drive the Remote branch to a real
// `POST /api/first-run` — the local/remote completion the keyless first-run flow
// never exercises.

import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

async function injectFullCapabilityHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__ELIZA_APP_API_BASE__ =
      window.location.origin;
    (window as unknown as Record<string, number>).__electrobunWindowId = 1;
  });
}

test("onboarding (detailed shell): completes the remote runtime branch", async ({
  page,
}) => {
  await injectFullCapabilityHost(page);
  await installDefaultAppRoutes(page);
  await seedAppStorage(page);

  // finishRemote points the client at the typed remote base, so the onboarding
  // POST lands on that origin. Mock the remote's auth/first-run probes + capture
  // the submit.
  await page.route("**/api/auth/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        required: false,
        authenticated: true,
        loginRequired: false,
        localAccess: true,
      }),
    });
  });
  await page.route("**/api/first-run", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await openAppPath(page, "/onboarding");
  await expect(page.getByTestId("first-run-shell")).toBeVisible({
    timeout: 60_000,
  });

  const remoteCard = page.getByTestId("first-run-runtime-remote");
  await expect(remoteCard).toBeVisible({ timeout: 15_000 });
  await remoteCard.click();

  await page
    .getByPlaceholder("https://agent.example.com")
    .fill("https://agent.example.com");
  await page.getByPlaceholder(/Access token/i).fill("remote-smoke-token");

  const [request] = await Promise.all([
    page.waitForRequest(
      (req) =>
        req.method() === "POST" && /\/api\/first-run(?:$|\?)/.test(req.url()),
      { timeout: 20_000 },
    ),
    page
      .getByRole("button", { name: /^Start$/ })
      .first()
      .click(),
  ]);

  const payload = request.postDataJSON() as {
    deploymentTarget?: { runtime?: string };
  };
  expect(payload.deploymentTarget?.runtime).toBe("remote");
  expect(request.url()).toContain("agent.example.com");
});

test("onboarding (detailed shell): local-inference choice toggles", async ({
  page,
}) => {
  await injectFullCapabilityHost(page);
  await installDefaultAppRoutes(page);
  await seedAppStorage(page);

  await openAppPath(page, "/onboarding");
  await expect(page.getByTestId("first-run-shell")).toBeVisible({
    timeout: 60_000,
  });

  // Selecting Local reveals the inference sub-choice; both options are selectable.
  await page.getByTestId("first-run-runtime-local").click();
  const allLocal = page.getByTestId("first-run-local-all-local");
  const cloudInference = page.getByTestId("first-run-local-cloud-inference");
  await expect(allLocal).toBeVisible({ timeout: 10_000 });
  await cloudInference.check({ force: true });
  await expect(cloudInference).toBeChecked();
  await allLocal.check({ force: true });
  await expect(allLocal).toBeChecked();
});

test("web onboarding is cloud-only: no local runtime is offered", async ({
  page,
}) => {
  // No host-capability injection → the production web bundle is cloud-only
  // (canRunLocal() is false on web), so onboarding must NOT offer a local agent.
  await installDefaultAppRoutes(page);
  await seedAppStorage(page);

  await openAppPath(page, "/onboarding");
  await expect(page.getByTestId("first-run-shell")).toBeVisible({
    timeout: 60_000,
  });
  // Cloud is always offered; local must be absent on web (web can't run a local
  // agent — local provisioning is not a web capability).
  await expect(page.getByTestId("first-run-runtime-cloud")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("first-run-runtime-local")).toHaveCount(0);
});
