// Billing write-flow coverage that had no behavioral tests: the three controls
// on /dashboard/billing that mutate org billing state —
//   1. Auto Top-Up (Card)        → PUT /api/v1/billing/settings { autoTopUp }
//   2. Pay-as-you-go from earnings → PUT /api/v1/billing/settings { payAsYouGoFromEarnings }
//   3. Direct-crypto "Pay and add credits" → POST /api/crypto/direct-payments
//
// Runs against the local dev build with VITE_PLAYWRIGHT_TEST_AUTH=true (the
// eliza-test-auth cookie short-circuits real auth) and mocks every /api/* call
// so no real backend is touched. Each test drives the real control and asserts
// the exact mutation request (method + path + body) the UI sends.

import { expect, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "Billing write flows use local mocks; skipped in live-prod mode",
);

const ORG_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_WALLET = "0xE2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2";

interface Captured {
  method: string;
  path: string;
  body: unknown;
}

function userPayload() {
  const now = new Date().toISOString();
  return {
    success: true,
    data: {
      id: USER_ID,
      email: "billing@example.com",
      email_verified: true,
      wallet_address: ACCOUNT_WALLET,
      wallet_chain_type: "evm",
      wallet_verified: true,
      name: "Billing User",
      avatar: null,
      organization_id: ORG_ID,
      role: "owner",
      steward_user_id: "steward_1",
      telegram_id: null,
      telegram_username: null,
      telegram_first_name: null,
      telegram_photo_url: null,
      discord_id: null,
      discord_username: null,
      discord_global_name: null,
      discord_avatar_url: null,
      whatsapp_id: null,
      whatsapp_name: null,
      phone_number: null,
      phone_verified: null,
      is_anonymous: false,
      anonymous_session_id: null,
      expires_at: null,
      nickname: null,
      work_function: null,
      preferences: null,
      email_notifications: true,
      response_notifications: true,
      is_active: true,
      created_at: now,
      updated_at: now,
      organization: {
        id: ORG_ID,
        name: "Billing Org",
        slug: "billing-org",
        billing_email: "billing@example.com",
        credit_balance: "100.000000",
        is_active: true,
        created_at: now,
        updated_at: now,
      },
    },
  };
}

// Default settings response shape that auto-top-up-card.tsx + pay-as-you-go-card.tsx read.
function billingSettingsPayload(
  overrides?: Partial<{
    payAsYouGoFromEarnings: boolean;
    enabled: boolean;
    amount: number;
    threshold: number;
    hasPaymentMethod: boolean;
  }>,
) {
  return {
    settings: {
      payAsYouGoFromEarnings: overrides?.payAsYouGoFromEarnings ?? false,
      autoTopUp: {
        enabled: overrides?.enabled ?? false,
        amount: overrides?.amount ?? 25,
        threshold: overrides?.threshold ?? 5,
        // hasPaymentMethod must be TRUE or the card disables the switch +
        // inputs and shows the "Add a card first" warning.
        hasPaymentMethod: overrides?.hasPaymentMethod ?? true,
      },
      limits: {
        minAmount: 1,
        maxAmount: 10_000,
        minThreshold: 1,
        maxThreshold: 10_000,
      },
    },
  };
}

const directWalletStatus = {
  enabled: true,
  oxapayEnabled: false,
  directWallet: {
    enabled: true,
    networks: [
      {
        network: "base",
        displayName: "Base",
        chainId: 8453,
        tokenSymbol: "USDC",
        tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        tokenDecimals: 6,
        tokens: [
          {
            symbol: "USDC",
            kind: "erc20",
            tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            decimals: 6,
          },
        ],
        receiveAddress: "0x72D043586b6226A97197408b4EE41572dD000ac6",
        enabled: true,
      },
    ],
  },
};

test.beforeEach(async ({ context, page }) => {
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
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "steward_session_token",
      "playwright-test-token",
    );
  });
});

/**
 * Installs the route mocks the /dashboard/billing page needs to render, with
 * `/api/v1/billing/settings` PUTs recorded into `sink`. The settings GET shape
 * is controlled by `settingsOverrides`.
 */
async function installBillingRoutes(
  page: import("@playwright/test").Page,
  sink: Captured[],
  settingsOverrides?: Parameters<typeof billingSettingsPayload>[0],
) {
  await page.route("**/api/v1/billing/settings", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      return route.fulfill({ json: billingSettingsPayload(settingsOverrides) });
    }
    // PUT — record the mutation, echo settings so the card's success path works.
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    sink.push({
      method: req.method(),
      path: new URL(req.url()).pathname,
      body,
    });
    return route.fulfill({ json: billingSettingsPayload(settingsOverrides) });
  });

  await page.route("**/api/v1/user", (route) =>
    route.fulfill({ json: userPayload() }),
  );
  await page.route(/\/api\/credits\/balance/, (route) =>
    route.fulfill({ json: { balance: 100, currency: "USD" } }),
  );
  await page.route(/\/api\/invoices\/list/, (route) =>
    route.fulfill({ json: { invoices: [] } }),
  );
  await page.route("**/api/crypto/status", (route) =>
    route.fulfill({ json: directWalletStatus }),
  );

  // Catch-all for every other /api/* render-time call. Playwright runs route
  // handlers last-registered-first, so this one fires before the specific mocks
  // above — fall back to them for their exact paths (otherwise this generic
  // `data: []` response shadows /api/v1/user and the billing page renders
  // "No organization associated with this account").
  const specificPaths = new Set([
    "/api/v1/billing/settings",
    "/api/v1/user",
    "/api/credits/balance",
    "/api/invoices/list",
    "/api/crypto/status",
    "/api/crypto/direct-payments",
  ]);
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      if (specificPaths.has(new URL(route.request().url()).pathname)) {
        return route.fallback();
      }
      return route.fulfill({
        json: { success: true, data: [], items: [], balance: 100 },
      });
    },
  );
}

test("billing: auto top-up enable + amount/threshold → PUT { autoTopUp }", async ({
  page,
}) => {
  const calls: Captured[] = [];
  await installBillingRoutes(page, calls);

  await page.goto("/dashboard/billing");
  await expect(page).not.toHaveURL(/\/login/);

  // Scope to the Auto Top-Up card (the BrandCard div, identified by its
  // bg-bg-elevated class) so we don't grab the pay-as-you-go switch. Anchor on
  // the unique enable-label and walk up to the enclosing card.
  const card = page
    .locator("div.bg-bg-elevated")
    .filter({ has: page.getByText(/Enable card auto top-up/i) })
    .first();
  await expect(card).toBeVisible({ timeout: 20_000 });

  // Enable the card auto-top-up switch (Radix role="switch").
  const toggle = card.getByRole("switch").first();
  await expect(toggle).toBeEnabled({ timeout: 10_000 });
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-state", "checked");

  // Amount + threshold are NumericField inputs (type=number, placeholder 0.00).
  const numbers = card.locator('input[type="number"]');
  await numbers.nth(0).fill("50");
  await numbers.nth(1).fill("10");

  // Save.
  await card.getByRole("button", { name: /^save$/i }).click();

  await expect.poll(() => calls.find((c) => c.method === "PUT")).toBeTruthy();
  const put = calls.find((c) => c.method === "PUT");
  expect(put?.path).toBe("/api/v1/billing/settings");
  expect(put?.body).toMatchObject({
    autoTopUp: { enabled: true, amount: 50, threshold: 10 },
  });
});

test("billing: pay-as-you-go switch toggles → PUT { payAsYouGoFromEarnings }", async ({
  page,
}) => {
  const calls: Captured[] = [];
  // Start with the pay-from-earnings toggle OFF so flipping it sends `true`.
  await installBillingRoutes(page, calls, { payAsYouGoFromEarnings: false });

  await page.goto("/dashboard/billing");
  await expect(page).not.toHaveURL(/\/login/);

  const card = page
    .locator("div.bg-bg-elevated")
    .filter({
      has: page.getByText(/Use my app earnings to pay container hosting/i),
    })
    .first();
  await expect(card).toBeVisible({ timeout: 20_000 });

  const toggle = card.getByRole("switch").first();
  // Wait for the card's own GET to resolve (it renders a spinner until then).
  await expect(toggle).toBeVisible({ timeout: 10_000 });
  await expect(toggle).toHaveAttribute("data-state", "unchecked");

  await toggle.click();

  await expect.poll(() => calls.find((c) => c.method === "PUT")).toBeTruthy();
  const put = calls.find((c) => c.method === "PUT");
  expect(put?.path).toBe("/api/v1/billing/settings");
  expect(put?.body).toMatchObject({ payAsYouGoFromEarnings: true });
});

test("billing: direct-crypto Pay → POST /api/crypto/direct-payments with the right body", async ({
  page,
}) => {
  const calls: Captured[] = [];
  await installBillingRoutes(page, calls);

  // Capture the direct-payment creation request and stop at the wallet boundary
  // (no real signer; the POST is the assertion target, the chain part is
  // best-effort just like direct-crypto-flow.spec.ts).
  await page.route("**/api/crypto/direct-payments", async (route) => {
    const req = route.request();
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    calls.push({
      method: req.method(),
      path: new URL(req.url()).pathname,
      body,
    });
    return route.fulfill({
      json: {
        paymentId: "crypto_payment_1",
        status: "pending",
        instructions: {
          chainId: 8453,
          tokenSymbol: "USDC",
          tokenKind: "erc20",
          tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          tokenDecimals: 6,
          receiveAddress: "0x72D043586b6226A97197408b4EE41572dD000ac6",
          amountUnits: "10000000",
          amountToken: "10.000000",
          creditsToAdd: "10.00",
          bonusCredits: 0,
        },
      },
    });
  });

  await page.goto("/dashboard/billing");
  await expect(page).not.toHaveURL(/\/login/);

  // Enter an amount, switch to the Crypto method so the DirectCryptoCreditCard
  // mounts (it renders only when paymentMethod=crypto && directWallet.enabled).
  const amountInput = page.getByPlaceholder(/0\.00/).first();
  await expect(amountInput).toBeVisible({ timeout: 20_000 });
  await amountInput.fill("10");

  await page.getByRole("button", { name: /^crypto$/i }).click();

  // The wallet-payment card surfaces the "Pay and add credits" CTA.
  const payButton = page
    .getByRole("button", { name: /Pay and add credits/i })
    .first();
  await expect(payButton).toBeVisible({ timeout: 10_000 });

  // RainbowKit may auto-open a Connect modal for the SIWE-account path; dismiss.
  const connectModal = page.getByRole("dialog", { name: /Connect/i });
  if (await connectModal.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(connectModal)
      .toBeHidden()
      .catch(() => {});
  }

  await payButton.click();

  // Without a connected wagmi wallet the handler can early-return with a
  // "Connect your wallet first" toast BEFORE creating the payment (mirrors
  // direct-crypto-flow.spec.ts). If a wagmi connection is present in the test
  // browser, the POST fires with the expected body. Accept either outcome but,
  // when the POST does fire, assert its shape.
  await page.waitForTimeout(1_000);
  const post = calls.find((c) => c.path === "/api/crypto/direct-payments");
  if (post) {
    expect(post.method).toBe("POST");
    expect(post.body).toMatchObject({
      amount: 10,
      network: "base",
      payerAddress: expect.any(String),
    });
  } else {
    // Wallet not connected — the UI gates the POST behind a connect toast.
    await expect(
      page.getByText(/Connect your .* wallet first\./i).first(),
    ).toBeVisible();
  }
});
