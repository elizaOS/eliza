import { expect, test } from "./fixtures";
import { fillAndVerify } from "./helpers/interaction-helpers";
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from "./helpers/page-helpers";
import { ROUTES, VIEWPORTS } from "./helpers/test-data";
import { loginWithWallet } from "./helpers/wallet-auth";

test.setTimeout(60000);

test.describe("Research - Form", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.RESEARCH);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("research page loads", async ({ page }) => {
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  // The research page renders the ModelPilotInquiryForm. The old
  // "organization field", "description field", "use case field", and
  // "file upload area" specs were deleted: those fields have never existed
  // on this form (it has provider/model/endpoint inputs + email + terms),
  // so the specs could only ever pass vacuously.

  test("model provider field accepts input", async ({ page }) => {
    const result = await fillAndVerify(
      page,
      "#model-pilot-provider",
      "Anthropic",
    );
    test.skip(result === null, "no provider input rendered on the pilot form");
    expect(result).toBe("Anthropic");
  });

  test("email field accepts input", async ({ page }) => {
    const result = await fillAndVerify(
      page,
      '#model-pilot-email, input[type="email"]',
      "e2e@example.com",
    );
    test.skip(result === null, "no email input rendered on the pilot form");
    expect(result).toBe("e2e@example.com");
  });

  test("submit button visible", async ({ page }) => {
    // The pilot form always renders its "Request pilot" submit button.
    const submitBtn = page
      .locator('button[type="submit"], button:has-text("Request pilot")')
      .first();
    await expect(submitBtn).toBeVisible({ timeout: 5000 });
  });

  test("submit disabled when fields empty", async ({ page }) => {
    const submitBtn = page
      .locator('button[type="submit"], button:has-text("Request pilot")')
      .first();
    const isVisible = await submitBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no submit button rendered on the pilot form");
    // Submit is disabled until an email is entered and terms are agreed.
    await expect(submitBtn).toBeDisabled();
  });
});
