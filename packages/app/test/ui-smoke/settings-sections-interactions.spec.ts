// Real interaction coverage for the Settings sections + character editor.
// all-pages-clicksafe only render-smokes settings; this drives the actual
// controls (voice strategy select, appearance theme, capability switch, app-
// permission refresh, backup/export modal, character bio save) and asserts they
// DO something. Keyless against the stub.

import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

function countRequests(
  page: Page,
  predicate: (url: string, method: string) => boolean,
): () => number {
  let n = 0;
  page.on("request", (req) => {
    if (predicate(req.url(), req.method())) n += 1;
  });
  return () => n;
}

test("voice settings: the strategy select changes value", async ({ page }) => {
  await openAppPath(page, "/settings");
  await openSettingsSection(page, /^Voice$/);
  await expect(page.getByTestId("voice-section")).toBeVisible({
    timeout: 30_000,
  });

  const strategy = page.getByTestId("voice-section-strategy-select");
  await expect(strategy).toBeVisible({ timeout: 15_000 });
  const before = await strategy.inputValue();
  const options = await strategy
    .locator("option")
    .evaluateAll((els) => (els as HTMLOptionElement[]).map((o) => o.value));
  const next = options.find((v) => v && v !== before);
  expect(next, "voice strategy select must offer a second option").toBeTruthy();
  await strategy.selectOption(next as string);
  await expect.poll(() => strategy.inputValue()).toBe(next);
});

test("appearance settings: selecting the Dark theme marks it active", async ({
  page,
}) => {
  await openAppPath(page, "/settings");
  await openSettingsSection(page, /Appearance/);
  await expect(page.locator("#appearance")).toBeVisible({ timeout: 30_000 });

  const dark = page.locator('[data-agent-id="appearance-mode-dark"]').first();
  await expect(dark).toBeVisible({ timeout: 15_000 });
  await dark.click();
  await expect(dark).toHaveAttribute("aria-current", "true", {
    timeout: 10_000,
  });
});

test("app-permissions settings: Refresh re-queries the app permissions", async ({
  page,
}) => {
  const permReqs = countRequests(page, (url) =>
    /\/api\/apps\/permissions(?:\?|$)/.test(url),
  );
  await openAppPath(page, "/settings");
  await openSettingsSection(page, /App Permissions/);
  await expect(page.locator("#app-permissions")).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(permReqs).toBeGreaterThan(0);

  const before = permReqs();
  await page
    .locator("#app-permissions")
    .getByRole("button", { name: /refresh/i })
    .first()
    .click();
  await expect.poll(permReqs).toBeGreaterThan(before);
});

test("capabilities settings: a capability switch toggles its checked state", async ({
  page,
}) => {
  await openAppPath(page, "/settings");
  await openSettingsSection(page, /Capabilities/);
  await expect(page.locator("#capabilities")).toBeVisible({ timeout: 30_000 });

  const walletSwitch = page.getByRole("switch", { name: /Enable Wallet/i });
  await expect(walletSwitch).toBeVisible({ timeout: 15_000 });
  const before = await walletSwitch.getAttribute("aria-checked");
  await walletSwitch.click();
  await expect
    .poll(() => walletSwitch.getAttribute("aria-checked"))
    .not.toBe(before);
});

test("backup & reset settings: Export opens its modal", async ({ page }) => {
  await openAppPath(page, "/settings");
  await openSettingsSection(page, /Backup & Reset|Advanced/);
  await expect(page.locator("#advanced")).toBeVisible({ timeout: 30_000 });

  await page.locator('[data-agent-id="advanced-export-open"]').first().click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10_000 });
});

test("character editor: editing the bio enables Save and persists", async ({
  page,
}) => {
  // The character PUT is not served by the stub; capture it so Save resolves.
  let characterSaves = 0;
  await page.route("**/api/character", async (route) => {
    if (route.request().method() === "PUT") {
      characterSaves += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
      return;
    }
    await route.fallback();
  });

  await openAppPath(page, "/character");
  await expect(page.getByTestId("character-editor-view")).toBeVisible({
    timeout: 60_000,
  });
  await page
    .getByRole("button", { name: /Open Personality/i })
    .first()
    .click();

  const bio = page
    .getByRole("textbox", { name: /About Me/i })
    .or(page.getByPlaceholder(/Describe who your agent is/i))
    .first();
  await expect(bio).toBeVisible({ timeout: 15_000 });
  await bio.fill("A concise smoke-test agent persona.");

  const save = page.getByRole("button", { name: /^Save$/ }).first();
  await expect(save).toBeEnabled({ timeout: 10_000 });
  await save.click();
  await expect.poll(() => characterSaves).toBeGreaterThan(0);
});
