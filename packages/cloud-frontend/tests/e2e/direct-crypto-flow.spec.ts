import { expect, type Page, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "direct-crypto-flow.spec uses local API mocks; live-prod runs cloud-routes-live.spec instead",
);

const ACCOUNT_WALLET = "0x19E7E376E7C213B7E7E7E46CC70A5DD086DAFF2A";

interface CapturedFailures {
  pageErrors: string[];
  consoleErrors: string[];
}

function collectFailures(page: Page): CapturedFailures {
  const failures: CapturedFailures = { pageErrors: [], consoleErrors: [] };
  page.on("pageerror", (err) =>
    failures.pageErrors.push(err.message ?? String(err)),
  );
  page.on("console", (msg) => {
    if (msg.type() === "error") failures.consoleErrors.push(msg.text());
  });
  return failures;
}

function expectNoJsonFallbackCrash(failures: CapturedFailures) {
  const text = [...failures.pageErrors, ...failures.consoleErrors].join("\n");
  expect(text).not.toMatch(/Unexpected token '<'|not valid JSON/i);
}

function userPayload() {
  const now = new Date().toISOString();
  return {
    success: true,
    data: {
      id: "user_1",
      email: "buyer@example.com",
      email_verified: true,
      wallet_address: ACCOUNT_WALLET,
      wallet_chain_type: "evm",
      wallet_verified: true,
      name: "Buyer",
      avatar: null,
      organization_id: "org_1",
      role: "admin",
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
        id: "org_1",
        name: "Buyer Org",
        slug: "buyer-org",
        billing_email: "buyer@example.com",
        credit_balance: "100.000000",
        is_active: true,
        created_at: now,
        updated_at: now,
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
        receiveAddress: "0x72D043586b6226A97197408b4EE41572dD000ac6",
        enabled: true,
      },
      {
        network: "bsc",
        displayName: "BNB Smart Chain",
        chainId: 56,
        tokenSymbol: "USDT",
        tokenAddress: "0x55d398326f99059fF775485246999027B3197955",
        tokenDecimals: 18,
        receiveAddress: "0x93cacDACDf6791be31EA44742CA94db238C887EB",
        enabled: true,
      },
      {
        network: "solana",
        displayName: "Solana",
        tokenSymbol: "USDC",
        tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        tokenDecimals: 6,
        receiveAddress: "D9KjXwECD1nqDQA1ektXjen1PAMcDnYKPmEGU9oZctzX",
        enabled: true,
      },
    ],
    promotion: {
      code: "bsc",
      network: "bsc",
      minimumUsd: 10,
      bonusCredits: 5,
    },
  },
};

async function installBscMocks(page: Page, opts?: { htmlStatus?: boolean }) {
  let createPaymentCalls = 0;

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/api/crypto/status") {
      if (opts?.htmlStatus) {
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><body>SPA fallback</body></html>",
        });
      }
      return route.fulfill({ json: directWalletStatus });
    }

    if (path === "/api/v1/user") {
      return route.fulfill({ json: userPayload() });
    }

    if (path === "/api/credits/balance") {
      return route.fulfill({ json: { balance: 100 } });
    }

    if (path === "/api/crypto/direct-payments") {
      createPaymentCalls += 1;
      return route.fulfill({
        json: {
          paymentId: "crypto_payment_1",
          status: "pending",
          instructions: {
            network: "bsc",
            chainId: 56,
            tokenSymbol: "USDT",
            tokenAddress: "0x55d398326f99059fF775485246999027B3197955",
            tokenDecimals: 18,
            receiveAddress: "0x93cacDACDf6791be31EA44742CA94db238C887EB",
            amountUnits: "10000000000000000000",
            amountToken: "10.000000000000000000",
            creditsToAdd: "15.00",
            bonusCredits: 5,
          },
        },
      });
    }

    return route.fulfill({ json: { success: true, data: [] } });
  });

  return {
    createPaymentCalls: () => createPaymentCalls,
  };
}

function fakeJwt(payload: Record<string, unknown>) {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.test`;
}

test.beforeEach(async ({ context, page }) => {
  const token = fakeJwt({
    userId: "user_1",
    email: "buyer@example.com",
    address: ACCOUNT_WALLET,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  await page.addInitScript((sessionToken) => {
    window.localStorage.setItem("steward_session_token", sessionToken);
  }, token);
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
    {
      name: "steward-authed",
      value: "1",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
});

test("/bsc renders the promo purchase state from direct wallet config", async ({
  page,
}) => {
  const failures = collectFailures(page);
  const mocks = await installBscMocks(page);

  await page.goto("/bsc");

  await expect(
    page.getByRole("heading", { name: "Buy cloud credit on BSC" }),
  ).toBeVisible();
  await expect(page.getByText("BSC promotion applied")).toBeVisible();
  await expect(page.getByText("$15.00")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Pay and add credits/i }),
  ).toBeEnabled();

  await page.getByRole("button", { name: /Pay and add credits/i }).click();
  await expect(page.getByText("Connect your BSC wallet first.")).toBeVisible();
  expect(mocks.createPaymentCalls()).toBe(0);
  expectNoJsonFallbackCrash(failures);
});

test("/bsc ignores an HTML API fallback instead of JSON-parsing it", async ({
  page,
}) => {
  const failures = collectFailures(page);
  await installBscMocks(page, { htmlStatus: true });

  await page.goto("/bsc");

  await expect(
    page.getByText("Direct wallet payments are not configured yet."),
  ).toBeVisible();
  expectNoJsonFallbackCrash(failures);
});
