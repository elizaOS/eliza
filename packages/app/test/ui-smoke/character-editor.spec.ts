/**
 * Playwright UI-smoke coverage for Character Editor config boundaries and
 * persistence flows using the real renderer fixture.
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

async function navigateToCoreView(
  page: Page,
  detail: { viewId: string; viewPath: string; viewLabel: string },
): Promise<void> {
  await page.evaluate((view) => {
    window.dispatchEvent(
      new CustomEvent("eliza:navigate:view", {
        detail: {
          ...view,
          viewType: "gui",
          alwaysOnTop: false,
        },
      }),
    );
  }, detail);
}

test.describe("character editor voice config boundary", () => {
  test.beforeEach(async ({ page }) => {
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
  });

  test("a failed config read blocks early writes and stays explicit across remounts", async ({
    page,
  }) => {
    await openAppPath(page, "/chat");

    let configReads = 0;
    let configWrites = 0;
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.route("**/api/config", async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        configReads += 1;
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "Unauthorized" }),
        });
        return;
      }
      if (method === "PUT") {
        configWrites += 1;
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "Unauthorized" }),
        });
        return;
      }
      await route.fallback();
    });

    const character = {
      viewId: "character",
      viewPath: "/character",
      viewLabel: "Character",
    };
    await navigateToCoreView(page, character);
    await expect(page.getByTestId("character-editor-view")).toBeVisible();
    await expect(
      page.getByTestId("character-voice-config-unavailable"),
    ).toContainText("Voice settings are unavailable");

    await navigateToCoreView(page, {
      viewId: "settings",
      viewPath: "/settings",
      viewLabel: "Settings",
    });
    await expect(page.getByTestId("settings-shell")).toBeVisible();
    await navigateToCoreView(page, character);
    await expect(page.getByTestId("character-editor-view")).toBeVisible();
    await expect(
      page.getByTestId("character-voice-config-unavailable"),
    ).toContainText("Voice settings are unavailable");

    await expect.poll(() => configReads).toBeGreaterThanOrEqual(2);
    await expect.poll(() => configWrites).toBe(0);
    expect(
      consoleErrors.some((message) =>
        message.includes("voice config early persist failed"),
      ),
    ).toBe(false);
  });

  test("a late failed read from an unmounted editor cannot poison the next mount", async ({
    page,
  }) => {
    await openAppPath(page, "/chat");

    let configReads = 0;
    let releaseFirstRead = () => {};
    let markFirstReadStarted = () => {};
    const firstReadStarted = new Promise<void>((resolve) => {
      markFirstReadStarted = resolve;
    });
    const firstReadRelease = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    await page.route("**/api/config", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      configReads += 1;
      if (configReads === 1) {
        markFirstReadStarted();
        await firstReadRelease;
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "late Unauthorized" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ messages: { tts: { provider: "edge" } } }),
      });
    });

    const character = {
      viewId: "character",
      viewPath: "/character",
      viewLabel: "Character",
    };
    await navigateToCoreView(page, character);
    await expect(page.getByTestId("character-editor-view")).toBeVisible();
    await firstReadStarted;
    await navigateToCoreView(page, {
      viewId: "settings",
      viewPath: "/settings",
      viewLabel: "Settings",
    });
    await expect(page.getByTestId("settings-shell")).toBeVisible();
    await navigateToCoreView(page, character);
    await expect(page.getByTestId("character-editor-view")).toBeVisible();
    await expect.poll(() => configReads).toBeGreaterThanOrEqual(2);

    releaseFirstRead();
    await page.waitForTimeout(100);
    await expect(
      page.getByTestId("character-voice-config-unavailable"),
    ).toHaveCount(0);
  });
});

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
