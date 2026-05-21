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

const BSC_TOKEN_OPTIONS = [
  { symbol: "BNB", kind: "native", decimals: 18 },
  {
    symbol: "USDT",
    kind: "bep20",
    tokenAddress: "0x55d398326f99059fF775485246999027B3197955",
    decimals: 18,
  },
  {
    symbol: "USDC",
    kind: "bep20",
    tokenAddress: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    decimals: 18,
  },
  {
    symbol: "U",
    kind: "bep20",
    tokenAddress: "0xcE24439F2D9C6a2289F741120FE202248B666666",
    decimals: 18,
  },
];

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
      {
        network: "bsc",
        displayName: "BNB Smart Chain",
        chainId: 56,
        tokenSymbol: "USDT",
        tokenAddress: "0x55d398326f99059fF775485246999027B3197955",
        tokenDecimals: 18,
        tokens: BSC_TOKEN_OPTIONS,
        receiveAddress: "0x93cacDACDf6791be31EA44742CA94db238C887EB",
        enabled: true,
      },
      {
        network: "solana",
        displayName: "Solana",
        tokenSymbol: "USDC",
        tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        tokenDecimals: 6,
        tokens: [
          {
            symbol: "USDC",
            kind: "spl",
            tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            decimals: 6,
          },
        ],
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

async function installBscMocks(
  page: Page,
  opts?: { htmlStatus?: boolean; accountWalletAddress?: string | null },
) {
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
      const payload = userPayload();
      if (opts && "accountWalletAddress" in opts) {
        payload.data.wallet_address = opts.accountWalletAddress ?? null;
        payload.data.wallet_verified = Boolean(opts.accountWalletAddress);
      }
      return route.fulfill({ json: payload });
    }

    if (path === "/api/credits/balance") {
      return route.fulfill({ json: { balance: 100 } });
    }

    if (path === "/api/crypto/direct-payments") {
      createPaymentCalls += 1;
      const body = await route.request().postDataJSON().catch(() => ({}));
      const requestedSymbol: string =
        typeof body?.tokenSymbol === "string" ? body.tokenSymbol : "USDT";
      const token =
        BSC_TOKEN_OPTIONS.find(
          (t) => t.symbol.toUpperCase() === requestedSymbol.toUpperCase(),
        ) ?? BSC_TOKEN_OPTIONS[1];
      return route.fulfill({
        json: {
          paymentId: "crypto_payment_1",
          status: "pending",
          instructions: {
            network: "bsc",
            chainId: 56,
            tokenSymbol: token.symbol,
            tokenKind: token.kind,
            tokenAddress: token.tokenAddress,
            tokenDecimals: token.decimals,
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

test("/bsc lets OAuth users (no account wallet) reach the purchase UI directly", async ({
  page,
}) => {
  // Previously OAuth signups landed on an AttachWalletCard that forced a
  // SIWE step before they could pay. The product now lets any logged-in
  // user pay from any wallet — credits attach to the org_id from the
  // session, not to the paying wallet. Verify the purchase surface renders
  // with no "Verify your BSC wallet" gate.
  const failures = collectFailures(page);
  const mocks = await installBscMocks(page, { accountWalletAddress: null });

  await page.goto("/bsc");

  await expect(
    page.getByRole("heading", { name: "Buy cloud credit on BSC" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Verify your BSC wallet" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Pay and add credits/i }),
  ).toBeVisible();
  await expect(page.getByLabel("Token")).toBeVisible();

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

test("/bsc shows BNB/USDT/USDC/$U token selector and $5 bonus is per-purchase, token-agnostic", async ({
  page,
}) => {
  const failures = collectFailures(page);
  await installBscMocks(page);

  await page.goto("/bsc");

  const tokenSelect = page.getByLabel("Token");
  await expect(tokenSelect).toBeVisible();
  // All four BSC tokens are selectable as <option> entries.
  for (const value of ["BNB", "USDT", "USDC", "U"]) {
    await expect(tokenSelect.locator(`option[value="${value}"]`)).toHaveCount(1);
  }

  // The +$5 bonus is independent of which token the buyer picked; it is gated
  // only by network=bsc + amount>=10. Switching tokens must keep the
  // promo-applied banner and the "You receive 15.00 credits" tile.
  for (const value of ["BNB", "USDC", "U"]) {
    await tokenSelect.selectOption(value);
    await expect(page.getByText("BSC promotion applied")).toBeVisible();
    await expect(page.getByText("15.00 credits")).toBeVisible();
  }

  expectNoJsonFallbackCrash(failures);
});

test("/bsc renders a ConnectButton that surfaces injected EVM wallets (MetaMask + Phantom-as-EVM)", async ({
  page,
}) => {
  // RainbowKit's default wallets are wired in StewardWalletProviders and
  // include the "Injected"/"Browser Wallet" connector that surfaces any
  // EIP-1193 `window.ethereum` — MetaMask, Phantom-in-EVM-mode, Brave, etc.
  // We don't simulate the injected provider here (a partial Phantom stub
  // breaks wagmi's connector init), but we DO assert the ConnectButton is
  // present so the user has a path to connect any installed EVM wallet.
  // The Phantom-must-NOT-trigger-SIWE direction is covered by the dedicated
  // login test below.
  await installBscMocks(page);

  await page.goto("/bsc");

  await expect(
    page.getByRole("button", { name: /Connect Wallet/i }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Pay and add credits/i }),
  ).toBeVisible();
});

test("Login with Ethereum (SIWE) excludes Phantom from the injected-provider path", async ({
  page,
}) => {
  // When Phantom is the ONLY window.ethereum provider, the explicit Phantom
  // filter in wallet-buttons.tsx must keep SIWE from using it. The button is
  // still clickable — it just falls through to the RainbowKit modal (whose
  // default wallet list does not include Phantom either), so Phantom never
  // becomes the SIWE signer.
  await page.addInitScript(() => {
    const phantomEthereum = {
      isPhantom: true,
      request: async (req: { method: string }) => {
        if (req.method === "eth_chainId") return "0x1";
        // If our filter is broken and we ever reach eth_requestAccounts,
        // throw a marker that the test will fail on. This is the regression
        // safety net: a future refactor that drops the Phantom filter would
        // surface here as an `unexpected_phantom_account_request`.
        if (req.method === "eth_requestAccounts") {
          throw new Error("unexpected_phantom_account_request");
        }
        return null;
      },
    };
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: phantomEthereum,
    });
    Object.defineProperty(window, "phantom", {
      configurable: true,
      value: { ethereum: phantomEthereum },
    });
  });

  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  // Mock the Steward providers endpoint so SIWE is enabled.
  await page.route("**/auth/providers**", (route) =>
    route.fulfill({
      json: {
        passkey: true,
        email: true,
        siwe: true,
        siws: true,
        google: false,
        discord: false,
        github: false,
        oauth: [],
      },
    }),
  );
  await page.route("**/api/**", (route) =>
    route.fulfill({ json: { success: true, data: {} } }),
  );

  await page.goto("/login");

  // The Ethereum SIWE button is present.
  const ethereumButton = page.getByRole("button", { name: /^Ethereum$/i });
  await expect(ethereumButton).toBeVisible();

  // Clicking it must not trigger Phantom's eth_requestAccounts. We don't
  // expect a successful sign-in (no real wallet), but we DO expect the
  // marker error not to appear.
  await ethereumButton.click();
  // Brief wait for any async injected-provider call to fire.
  await page.waitForTimeout(750);
  expect(errors.some((m) => m.includes("unexpected_phantom_account_request"))).toBe(
    false,
  );
});
