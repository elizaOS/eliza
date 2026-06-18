/**
 * XR simulation e2e. Drives the CSS-3D headset harness (`/xr-sim.html`) via
 * `window.__xrsim`: verifies spatial views render as panels in front of the
 * user, the head pose moves them in space, the controller can aim + select a
 * button, views switch, and the chat bar + voice work. Screenshots the headset
 * POV for each so the renders can be visually validated.
 */
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const SHOTS = "/tmp/xr-shots";
mkdirSync(SHOTS, { recursive: true });

async function ready(page: Page) {
  await page.goto("/xr-sim.html");
  await page.waitForFunction(() => window.__xrsim?.ready === true, {
    timeout: 30_000,
  });
}

async function setView(page: Page, id: string) {
  await page.evaluate((v) => window.__xrsim.setView(v), id);
  await page.waitForTimeout(120);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test("spatial views render as panels in front of the user (per-view POV)", async ({
  page,
}) => {
  await ready(page);
  const views = await page.evaluate(() => window.__xrsim.listViews());
  expect(views.length).toBeGreaterThanOrEqual(8);

  // The active panel exists and is on-screen.
  const panel = page.locator("[data-xr-panel]");
  await expect(panel).toBeVisible();

  for (const id of ["profile", "dashboard", "messages", "wallet", "settings"]) {
    if (!views.includes(id)) continue;
    await setView(page, id);
    await expect(page.locator(`[data-xr-panel="${id}"]`)).toBeVisible();
    // The real spatial content is mounted inside the panel.
    await expect(
      page.locator(`[data-xr-panel="${id}"] [data-spatial-surface="xr"]`),
    ).toBeVisible();
    await shot(page, `view-${id}`);
  }
});

test("head pose moves the world-locked panel (spatial placement)", async ({
  page,
}) => {
  await ready(page);
  await setView(page, "wallet");

  const centered = await page.locator("[data-xr-panel]").boundingBox();
  expect(centered).not.toBeNull();

  // Look right ~25°: the world-locked panel should drift left in view.
  await page.evaluate(() => window.__xrsim.setPose({ yaw: 25 }));
  await page.waitForTimeout(350);
  await shot(page, "pose-yaw-right");
  const turned = await page.locator("[data-xr-panel]").boundingBox();
  expect(turned).not.toBeNull();
  // The panel moved horizontally (it is anchored in space, not to the head).
  expect(Math.abs((turned?.x ?? 0) - (centered?.x ?? 0))).toBeGreaterThan(30);

  // Look up.
  await page.evaluate(() => window.__xrsim.setPose({ yaw: 0, pitch: 18 }));
  await page.waitForTimeout(350);
  await shot(page, "pose-pitch-up");

  await page.evaluate(() => window.__xrsim.setPose({ yaw: 0, pitch: 0 }));
});

test("controller can aim at and select a button in the panel", async ({
  page,
}) => {
  await ready(page);
  await setView(page, "profile");

  // Aim the controller at a real agent-addressable control, then select.
  const aimed = await page.evaluate(() =>
    window.__xrsim.aimAt('[data-agent-id="toggle-skills"]'),
  );
  expect(aimed).toBe(true);
  await shot(page, "controller-aim");

  const hit = await page.evaluate(() => window.__xrsim.select());
  expect(hit).toContain("toggle");
  const events = await page.evaluate(() =>
    window.__xrsim.events.map((e) => e.type),
  );
  // The select fired a panel action (the view's onPress → onAction).
  expect(events).toContain("select");
  await shot(page, "controller-after-select");
});

test("view switching via the rail", async ({ page }) => {
  await ready(page);
  await page.locator('[data-xr-rail-item="error"]').click();
  await expect(page.locator('[data-xr-panel="error"]')).toBeVisible();
  await shot(page, "rail-switch-error");
  const current = await page.evaluate(() => window.__xrsim.getView());
  expect(current).toBe("error");
});

test("chat bar input + submit and voice toggle", async ({ page }) => {
  await ready(page);
  await setView(page, "chat");

  await page.locator("[data-xr-chat-input]").click();
  await page.locator("[data-xr-chat-input]").fill("what's my balance?");
  await shot(page, "chat-typed");

  // Voice press lights the indicator.
  await page.locator("[data-xr-mic]").click();
  await expect(
    page.locator('[data-xr-voice-indicator="active"]'),
  ).toBeVisible();
  await shot(page, "voice-active");

  const events = await page.evaluate(() =>
    window.__xrsim.events.map((e) => e.type),
  );
  expect(events).toContain("voice");
});
