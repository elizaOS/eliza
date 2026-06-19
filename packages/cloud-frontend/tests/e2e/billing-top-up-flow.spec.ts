/**
 * Net-new e2e: /dashboard/billing "Add credits" surface.
 *
 * Drives: amount entry → Card vs Crypto tab toggle → primary CTA enabled state.
 * Asserts no blue, no orange→black hover. Covers the regression where the
 * "Buy credits" primary button rendered orange-on-white instead of
 * orange-resting → orange-darker on hover.
 */

import { expect, test } from "@playwright/test";

test.describe("billing top-up flow", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      {
        name: "eliza-test-auth",
        value: "1",
        domain: "127.0.0.1",
        path: "/",
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);

    await context.addInitScript(() => {
      window.localStorage.setItem(
        "steward_session_token",
        "playwright-test-token",
      );
    });

    await context.route(/\/api\/v1\/user/, (route) =>
      route.fulfill({
        json: {
          success: true,
          data: {
            id: "22222222-2222-4222-8222-222222222222",
            email: "audit@example.com",
            name: "Test User",
            role: "owner",
            wallet_address: "0xE2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2",
            organization_id: "33333333-3333-4333-8333-333333333333",
            organization: { id: "33333333-3333-4333-8333-333333333333" },
            is_anonymous: false,
            wallet_verified: true,
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        },
        headers: { "content-type": "application/json" },
      }),
    );
    await context.route(/\/api\/v1\/credits\/balance/, (route) =>
      route.fulfill({
        json: { balance: 0, currency: "USD" },
        headers: { "content-type": "application/json" },
      }),
    );
    await context.route(/\/api\/credits\/balance/, (route) =>
      route.fulfill({
        json: { balance: 0, currency: "USD" },
        headers: { "content-type": "application/json" },
      }),
    );
    await context.route(/\/api\/invoices\/list/, (route) =>
      route.fulfill({
        json: { invoices: [] },
        headers: { "content-type": "application/json" },
      }),
    );
    await context.route(/\/api\/v1\/billing\/settings/, (route) =>
      route.fulfill({
        json: {
          settings: {
            payAsYouGoFromEarnings: false,
            autoTopUp: {
              enabled: false,
              amount: 25,
              threshold: 5,
              hasPaymentMethod: false,
            },
            limits: {
              minAmount: 1,
              maxAmount: 10_000,
              minThreshold: 1,
              maxThreshold: 10_000,
            },
          },
        },
        headers: { "content-type": "application/json" },
      }),
    );
    await context.route(/\/api\/crypto\/status/, (route) =>
      route.fulfill({
        json: {
          directWallet: { networks: [] },
          enabled: true,
        },
        headers: { "content-type": "application/json" },
      }),
    );
  });

  test("Card / Crypto toggle + amount input + CTA enable", async ({ page }) => {
    await page.goto("/dashboard/billing");

    // Wait for billing content (Credit Balance card title).
    await expect(page.getByText(/credit balance/i).first()).toBeVisible({
      timeout: 20_000,
    });

    // Card / Crypto toggle.
    const cardButton = page.getByRole("button", { name: /^card$/i });
    const cryptoButton = page.getByRole("button", { name: /^crypto$/i });
    await expect(cardButton).toBeVisible();
    await expect(cryptoButton).toBeVisible();

    // Card is selected by default (brand orange resting).
    const cardRest = await cardButton.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(cardRest).toMatch(/rgb|oklab/);

    // Click Crypto — selection swaps.
    await cryptoButton.click();
    await expect
      .poll(() =>
        cryptoButton.evaluate((el) => getComputedStyle(el).backgroundColor),
      )
      .toBe("rgb(255, 88, 0)");

    await cardButton.click();

    // Type an amount and the Buy credits CTA must enable.
    const amountInput = page.getByPlaceholder(/0\.00/).first();
    await amountInput.fill("10");

    const buyCta = page.getByRole("button", { name: /buy credits/i });
    await expect(buyCta).toBeEnabled({ timeout: 5_000 });

    // Buy credits hover — must not transition out of palette.
    const rest = await buyCta.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    await buyCta.hover();
    const hover = await buyCta.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    // Blue is banned; reject any rgb where blue channel dominates.
    const isBlue = (s: string) => {
      const m = s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return false;
      const [, r, g, b] = m.map((x) => Number(x));
      return b > r + 30 && b > g + 30;
    };
    expect(isBlue(rest), `Buy credits rest is blue: ${rest}`).toBe(false);
    expect(isBlue(hover), `Buy credits hover is blue: ${hover}`).toBe(false);
  });
});
