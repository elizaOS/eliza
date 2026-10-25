/**
 * Playwright UI-smoke spec for the Character Editor app flow using the real
 * renderer fixture.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const LIVE_STACK = process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";

async function openPersonality(page: Page): Promise<void> {
  await expect(page.getByTestId("character-editor-view")).toBeVisible({
    timeout: 60_000,
  });
  const styleSection = page.getByTestId("style-section-all");
  if (await styleSection.isVisible().catch(() => false)) {
    return;
  }
  await page
    .getByRole("button", { name: /Open Personality/i })
    .first()
    .click();
  await expect(styleSection).toBeVisible({ timeout: 30_000 });
}

async function styleRules(page: Page, section: "all"): Promise<string[]> {
  return page
    .locator(`[data-agent-id^="style-rule-${section}-"]`)
    .evaluateAll((nodes) =>
      nodes.map((node) =>
        node instanceof HTMLInputElement ? node.value.trim() : "",
      ),
    );
}

test.describe("character editor deep round-trip", () => {
  test.skip(
    !LIVE_STACK,
    "needs the real character pipeline (ELIZA_UI_SMOKE_LIVE_STACK=1); the keyless " +
      "stub serves static character data and cannot prove persistence.",
  );

  test.beforeEach(async ({ page }) => {
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
  });

  test("style rule save returns 2xx and persists across reload", async ({
    page,
  }) => {
    const saveStatuses: number[] = [];
    page.on("response", (response) => {
      if (
        response.request().method() === "PUT" &&
        /\/api\/character(?:\?|$)/.test(response.url())
      ) {
        saveStatuses.push(response.status());
      }
    });

    const uniqueRule = `Prefer crisp assertion-grade e2e evidence ${Date.now()}.`;

    await openAppPath(page, "/character");
    await openPersonality(page);

    const addInput = page.locator('[data-agent-id="style-add-input-all"]');
    await expect(addInput).toBeVisible({ timeout: 15_000 });
    await addInput.fill(uniqueRule);
    await page.locator('[data-agent-id="style-add-all"]').click();

    await expect
      .poll(() => styleRules(page, "all"), {
        message: "new global style rule should render in the editor",
      })
      .toContain(uniqueRule);

    const save = page.getByRole("button", { name: /^Save$/ }).first();
    await expect(save).toBeEnabled({ timeout: 10_000 });
    await save.click();

    await expect
      .poll(
        () => saveStatuses.some((status) => status >= 200 && status < 300),
        {
          message: "character save should receive a 2xx PUT /api/character",
        },
      )
      .toBe(true);

    await page.reload({ waitUntil: "domcontentloaded" });
    await openPersonality(page);
    await expect
      .poll(() => styleRules(page, "all"), {
        message: "saved style rule should survive a full page reload",
        timeout: 30_000,
      })
      .toContain(uniqueRule);
  });
});
