import { expect, type Page, test } from "@playwright/test";
import { installDefaultAppRoutes, openAppPath } from "./helpers";

/**
 * Verifies the "fade in first-turn capability" gate-split: while the local agent
 * is still WARMING (agentState "starting", canRespond false), the live shell +
 * chat composer must already be on screen — NOT the full-screen StartupScreen
 * loader — and the composer must be editable with a "waking up" affordance. When
 * first-turn capability comes online (canRespond true), the composer goes live.
 */

function chatComposer(page: Page) {
  return page
    .locator('[data-testid="chat-composer-textarea"]')
    .or(page.getByLabel("message"));
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
  await expect(composer).toHaveAttribute("placeholder", /waking up/i);

  // Capability comes online → the composer goes live (placeholder drops "waking up").
  ready = true;
  await expect
    .poll(async () => composer.getAttribute("placeholder"), { timeout: 30_000 })
    .not.toMatch(/waking up/i);
  await expect(composer).toBeVisible();
});
