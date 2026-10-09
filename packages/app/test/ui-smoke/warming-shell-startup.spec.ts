/**
 * Playwright UI-smoke spec for the Warming Shell Startup app flow using the
 * real renderer fixture.
 */
import { mkdir } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import { installDefaultAppRoutes, openAppPath } from "./helpers";

/**
 * Verifies the "fade in first-turn capability" gate-split: while the local agent
 * is still WARMING (agentState "starting", canRespond false), the live shell +
 * chat composer must already be on screen — NOT the full-screen StartupScreen
 * loader — and the composer must be editable with a "connecting" affordance. When
 * first-turn capability comes online (canRespond true), the composer goes live.
 */

function chatComposer(page: Page) {
  // The label fallback must be exact: substring matching would also hit chat
  // message bubbles labeled "Show message actions" once the greeting renders,
  // making the union locator ambiguous under strict mode.
  return page
    .locator('[data-testid="chat-composer-textarea"]')
    .or(page.getByLabel("message", { exact: true }));
}

/**
 * Override /api/health + /api/status so the agent reports WARMING until
 * `isReady()` returns true, then RUNNING with first-turn capability online.
 */
async function routeWarmingAgent(
  page: Page,
  isReady: () => boolean,
): Promise<void> {
  await page.route("**/api/health", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const ready = isReady();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ready,
        canRespond: ready,
        runtime: ready ? "ok" : "not_initialized",
        database: ready ? "ok" : "unknown",
        plugins: { loaded: ready ? 8 : 0, failed: 0 },
        agentState: ready ? "running" : "starting",
      }),
    });
  });

  await page.route("**/api/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const ready = isReady();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: ready ? "running" : "starting",
        agentName: "Eliza",
        model: ready ? "ui-smoke" : undefined,
        canRespond: ready,
        startedAt: ready ? Date.now() : undefined,
        uptime: ready ? 1 : 0,
      }),
    });
  });
}

test("the shell + composer paint while the agent warms up, then go live", async ({
  page,
}) => {
  let ready = false;
  // installDefaultAppRoutes wires a local:embedded authenticated, first-run-complete
  // server; routeWarmingAgent overrides health/status so it boots warming.
  await installDefaultAppRoutes(page);
  await routeWarmingAgent(page, () => ready);

  await openAppPath(page, "/chat");

  // GATE-SPLIT: during warmup the live composer is on screen (the shell painted),
  // not the full-screen StartupScreen loader. This is the core of the feature.
  await expect(chatComposer(page)).toBeVisible({ timeout: 30_000 });

  // The warming composer is editable (you can type now) and advertises warmup.
  const composer = chatComposer(page);
  await expect(composer).not.toHaveAttribute("readonly", /.*/);
  await expect(composer).toHaveAttribute("placeholder", /connecting/i);

  // Capability comes online → the composer goes live (placeholder drops "connecting").
  ready = true;
  await expect
    .poll(async () => composer.getAttribute("placeholder"), { timeout: 30_000 })
    .not.toMatch(/connecting/i);
  await expect(composer).toBeVisible();
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`missing local model remains editable and recovers on ${viewport.name}`, async ({
    page,
  }) => {
    const output = testOutputPath(
      "app",
      "local-model-readiness",
      viewport.name,
    );
    await mkdir(output, { recursive: true });
    await page.setViewportSize(viewport);
    await installDefaultAppRoutes(page);
    let ready = false;
    await page.route("**/api/status", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        json: {
          state: "running",
          agentName: "Eliza",
          model: "local-model",
          canRespond: ready,
          ...(!ready
            ? {
                localModelReadiness: {
                  provider: "eliza-local-inference",
                  status: "model_not_loaded",
                },
              }
            : {}),
        },
      });
    });
    await openAppPath(page, "/chat");
    const composer = chatComposer(page);
    await expect(composer).toHaveAttribute(
      "placeholder",
      /text model not loaded/i,
      { timeout: 30_000 },
    );
    await composer.fill("Keep this draft while I prepare the model.");
    await expect(composer).toHaveValue(
      "Keep this draft while I prepare the model.",
    );
    await expect(composer).toHaveAttribute(
      "aria-describedby",
      "cc-local-model-hint",
    );
    await page.screenshot({
      path: `${output}/model-missing.png`,
    });
    ready = true;
    await expect(composer).not.toHaveAttribute(
      "placeholder",
      /text model not loaded/i,
      { timeout: 30_000 },
    );
    await expect(composer).toHaveValue(
      "Keep this draft while I prepare the model.",
    );
    await page.screenshot({
      path: `${output}/model-ready.png`,
    });
  });
}
