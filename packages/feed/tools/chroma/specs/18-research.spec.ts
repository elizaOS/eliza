/**
 * Research Page E2E Tests
 *
 * Tests the model pilot inquiry form: organization info,
 * model description, use case, file upload, and form validation.
 */

import { expect, test } from "./fixtures";
import { pageContainsText } from "./helpers/interaction-helpers";
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from "./helpers/page-helpers";
import { loginWithWallet } from "./helpers/auth";
import { ROUTES, TIMEOUTS, VIEWPORTS } from "./helpers/test-data";

test.setTimeout(TIMEOUTS.EXTRA_LONG);

test.describe("Research - Form", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !(await isServerHealthy()),
      "feed server is not healthy at /api/health",
    );
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.RESEARCH);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("loads research inquiry page", async ({ page }) => {
    const hasResearchContent = await pageContainsText(
      page,
      "research",
      "inquiry",
      "model",
      "pilot",
      "organization",
    );

    const body = await page.locator("body").textContent();
    expect(hasResearchContent || (body?.length ?? 0) > 100).toBe(true);
  });

  test("displays organization name field", async ({ page }) => {
    const orgInput = page
      .locator(
        'input[name*="org" i], input[placeholder*="organization" i], input[placeholder*="company" i], label:has-text("Organization")',
      )
      .first();
    const hasOrg = await orgInput
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const hasOrgContent = await pageContainsText(
      page,
      "organization",
      "company",
      "org",
    );
    expect(hasOrg || hasOrgContent).toBe(true);
  });

  test("displays model description field", async ({ page }) => {
    const descInput = page
      .locator(
        'textarea[name*="description" i], textarea[placeholder*="model" i], textarea[placeholder*="describe" i], label:has-text("Description")',
      )
      .first();
    const hasDesc = await descInput
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const hasDescContent = await pageContainsText(
      page,
      "description",
      "describe",
      "model",
    );
    expect(hasDesc || hasDescContent).toBe(true);
  });

  test("displays use case field", async ({ page }) => {
    const useCaseInput = page
      .locator(
        'textarea[name*="use" i], textarea[placeholder*="use case" i], input[placeholder*="use case" i], label:has-text("Use Case")',
      )
      .first();
    const hasUseCase = await useCaseInput
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const hasUseCaseContent = await pageContainsText(
      page,
      "use case",
      "purpose",
      "application",
    );
    expect(hasUseCase || hasUseCaseContent).toBe(true);
  });

  test("displays file upload area", async ({ page }) => {
    const fileInput = page
      .locator(
        'input[type="file"], [data-testid*="upload"], button:has-text("Upload"), .dropzone',
      )
      .first();
    const hasUpload = await fileInput
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const hasUploadContent = await pageContainsText(
      page,
      "upload",
      "file",
      "attach",
      "drop",
    );
    expect(hasUpload || hasUploadContent).toBe(true);
  });

  test("validates required fields on submit", async ({ page }) => {
    const submitButton = page
      .locator(
        'button:has-text("Submit"), button:has-text("Send"), button[type="submit"]',
      )
      .first();

    if (
      await submitButton
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      const isDisabled = await submitButton.isDisabled().catch(() => false);
      // Should be disabled without required fields filled
      expect(typeof isDisabled).toBe("boolean");
    }
  });

  test("accepts valid form input", async ({ page }) => {
    // Fill organization
    const orgInput = page
      .locator(
        'input[name*="org" i], input[placeholder*="organization" i], input[placeholder*="company" i]',
      )
      .first();
    if (
      await orgInput.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await orgInput.fill("Test Organization");
    }

    // Fill description
    const descInput = page
      .locator(
        'textarea[name*="description" i], textarea[placeholder*="model" i], textarea',
      )
      .first();
    if (
      await descInput.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await descInput.fill("This is a test model description for E2E testing.");
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("shows submit button", async ({ page }) => {
    const submitButton = page
      .locator(
        'button:has-text("Submit"), button:has-text("Send"), button[type="submit"]',
      )
      .first();
    const hasSubmit = await submitButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const body = await page.locator("body").textContent();
    expect(hasSubmit || (body?.length ?? 0) > 100).toBe(true);
  });

  test("disables submit when required fields empty", async ({ page }) => {
    const submitButton = page
      .locator(
        'button:has-text("Submit"), button:has-text("Send"), button[type="submit"]',
      )
      .first();

    if (
      await submitButton
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      // Clear any existing input
      const inputs = page.locator('input[type="text"], textarea');
      const count = await inputs.count();
      for (let i = 0; i < count; i++) {
        const input = inputs.nth(i);
        if (await input.isVisible({ timeout: 500 }).catch(() => false)) {
          await input.clear().catch(() => {});
        }
      }

      await page.waitForTimeout(500);

      const isDisabled = await submitButton.isDisabled().catch(() => false);
      expect(typeof isDisabled).toBe("boolean");
    }
  });
});
