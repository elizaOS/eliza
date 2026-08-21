/**
 * Real-renderer proof for the Billing/Earnings redemption contract. The app,
 * settings registry, dialog primitives, and API client run normally; only the
 * HTTP boundary is intercepted, so no payout provider or wallet is contacted.
 */

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { expect, type Page, test } from "@playwright/test";
import {
  hideChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const EVM_ADDRESS = "0x0000000000000000000000000000000000000002";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encodeJwtPart = (value: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const STEWARD_TOKEN = `${encodeJwtPart({ alg: "HS256", typ: "JWT" })}.${encodeJwtPart(
  {
    sub: "earnings-redemption-smoke-user",
    email: "earnings-redemption-smoke@agent.local",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  },
)}.ui-smoke-signature`;

type QuoteMode = "success" | "unavailable" | "expires";

interface RedemptionStubState {
  postBodies: Array<Record<string, unknown>>;
  quoteRequests: Array<{ network: string | null; pointsAmount: string | null }>;
}

const jsonResponse = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

function historyItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "history-usdc-1",
    pointsAmount: 500,
    usdValue: 5,
    elizaAmount: 5,
    elizaPriceUsd: 1,
    asset: "usdc",
    network: "base",
    payoutAddress: "0x000...0002",
    status: "completed",
    txHash: "0xhistory",
    createdAt: "2026-08-20T12:00:00.000Z",
    completedAt: "2026-08-20T12:01:00.000Z",
    failureReason: null,
    requiresReview: false,
    ...overrides,
  };
}

async function installRedemptionStubs(
  page: Page,
  mode: QuoteMode,
): Promise<RedemptionStubState> {
  const state: RedemptionStubState = { postBodies: [], quoteRequests: [] };
  let submitted = false;
  let quoteCount = 0;

  await page.route("**/api/v1/redemptions/balance", (route) =>
    route.fulfill(
      jsonResponse({
        success: true,
        balance: {
          totalEarned: 17.5,
          availableBalance: 100,
          pendingBalance: 0,
          totalRedeemed: 5,
          totalPending: 0,
          totalConvertedToCredits: 0,
        },
        bySource: [],
        recentEarnings: [],
        limits: {
          minRedemptionUsd: 1,
          maxSingleRedemptionUsd: 1_000,
          userDailyLimitUsd: 2_000,
          userHourlyLimitUsd: 1_000,
        },
        eligibility: { canRedeem: true, dailyLimitRemaining: 2_000 },
      }),
    ),
  );

  await page.route("**/api/v1/redemptions/status", (route) =>
    route.fulfill(
      jsonResponse({
        success: true,
        operational: true,
        canRedeem: true,
        message: "Redemptions are operational.",
        availableNetworks: ["base", "solana", "ethereum", "bnb"],
        unavailableNetworks: [],
        networks: ["base", "solana", "ethereum", "bnb"].map((network) => ({
          network,
          available: true,
          status: "operational",
          balance: 10_000,
          balanceAvailable: true,
        })),
        wallets: {
          evm: { configured: true, address: EVM_ADDRESS },
          solana: {
            configured: true,
            address: "11111111111111111111111111111111",
          },
        },
        warnings: [],
        lastChecked: "2026-08-20T12:00:00.000Z",
      }),
    ),
  );

  await page.route("**/api/v1/redemptions/quote?*", async (route) => {
    const url = new URL(route.request().url());
    const pointsAmount = url.searchParams.get("pointsAmount");
    const network = url.searchParams.get("network");
    state.quoteRequests.push({ network, pointsAmount });
    quoteCount += 1;

    if (mode === "unavailable") {
      await route.fulfill(
        jsonResponse(
          {
            success: false,
            error: "The selected payout network is unavailable.",
            canRedeem: false,
          },
          503,
        ),
      );
      return;
    }

    const numericPoints = Number(pointsAmount);
    const validUntil =
      mode === "expires" && quoteCount === 1
        ? new Date(Date.now() + 1_500).toISOString()
        : new Date(Date.now() + 60_000).toISOString();
    await route.fulfill(
      jsonResponse({
        success: true,
        quote: {
          asset: "eliza",
          network,
          tokenAddress: "0x0000000000000000000000000000000000000001",
          pointsAmount: numericPoints,
          usdValue: numericPoints / 100,
          twapPriceUsd: 0.25,
          spotPriceUsd: 0.26,
          priceMethod: "TWAP",
          elizaAmount: numericPoints / 25,
          safetySpreadPercent: 5,
          sampleCount: 12,
          volatilityPercent: "1.20",
          tokensAvailable: true,
          hotWalletBalance: 10_000,
          validUntil,
          validitySeconds: 60,
          requiresDelay: false,
          requiresAdminApproval: false,
          limits: {
            minRedemptionUsd: 1,
            maxRedemptionUsd: 1_000,
            userDailyLimitUsd: 2_000,
            userHourlyLimitUsd: 1_000,
            largeRedemptionThresholdUsd: 1_000,
            adminApprovalThresholdUsd: 10_000,
          },
        },
        message: "Quote ready",
        canRedeem: true,
      }),
    );
  });

  await page.route(/\/api\/v1\/redemptions(?:\?limit=10)?$/, async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.postBodies.push(body);
      submitted = true;
      await route.fulfill(
        jsonResponse({
          success: true,
          redemptionId: "redemption-created-1",
          message: "Redemption created and will be processed shortly.",
        }),
      );
      return;
    }

    const redemptions = [
      ...(submitted
        ? [
            historyItem({
              id: "redemption-created-1",
              pointsAmount: 1_234,
              usdValue: 12.34,
              elizaAmount: 49.36,
              elizaPriceUsd: 0.25,
              asset: "eliza",
              network: "bnb",
              status: "pending",
              txHash: null,
              createdAt: "2026-08-20T13:00:00.000Z",
              completedAt: undefined,
            }),
          ]
        : []),
      historyItem(),
    ];
    await route.fulfill(
      jsonResponse({ success: true, redemptions, paused: false }),
    );
  });

  return state;
}

async function openEarnings(page: Page, mode: QuoteMode) {
  await hideChatOverlay(page);
  await seedAppStorage(page, {
    [STEWARD_TOKEN_KEY]: STEWARD_TOKEN,
    "eliza:developerMode": "1",
    // The focused HTTP contract must use browser fetch so Playwright owns the
    // transport boundary; native mode would route through CapacitorHttp.
    "eliza:ui-shell-mode": "web",
  });
  await installDefaultAppRoutes(page);
  // Playwright evaluates the most recently registered matching route first, so
  // these focused contracts override the default deterministic API backend.
  const state = await installRedemptionStubs(page, mode);
  await openAppPath(page, "/settings");
  await page.evaluate(() => {
    window.location.hash = "#cloud-monetization";
  });
  await expect(page.locator("#cloud-monetization")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole("button", { name: "Redeem for elizaOS" }),
  ).toBeVisible({ timeout: 30_000 });
  return state;
}

async function fillRedemptionIntent(page: Page) {
  await page.getByRole("button", { name: "Redeem for elizaOS" }).click();
  await expect(
    page.getByRole("dialog", { name: "Redeem for elizaOS Tokens" }),
  ).toBeVisible();
  await page.getByLabel("Amount to Redeem (USD)").fill("12.34");
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: /BNB Chain/ }).click();
  await page.getByPlaceholder("Enter 0x address").fill(EVM_ADDRESS);
}

test.describe("Billing/Earnings redemption real UI flow", () => {
  test("quotes and submits the exact typed intent without a provider", async ({
    page,
  }) => {
    const state = await openEarnings(page, "success");

    await expect(page.getByText("5.00 USDC")).toBeVisible();
    await fillRedemptionIntent(page);
    await expect(page.getByText("49.3600 elizaOS")).toBeVisible();
    expect(state.quoteRequests.at(-1)).toEqual({
      pointsAmount: "1234",
      network: "bnb",
    });

    await page.getByRole("button", { name: "Redeem Tokens" }).click();
    await expect(
      page.getByRole("dialog", { name: "Redeem for elizaOS Tokens" }),
    ).toBeHidden();
    expect(state.postBodies).toHaveLength(1);
    expect(state.postBodies[0]).toMatchObject({
      pointsAmount: 1_234,
      network: "bnb",
      asset: "eliza",
      payoutAddress: EVM_ADDRESS,
    });
    expect(state.postBodies[0]?.idempotencyKey).toMatch(UUID_PATTERN);

    await expect(page.getByText("49.36 elizaOS")).toBeVisible();
    await expect(page.getByText("5.00 USDC")).toBeVisible();
    await expect(page.getByText(/Invalid Date|NaN/)).toHaveCount(0);
  });

  test("renders an unavailable quote and prevents submission", async ({
    page,
  }) => {
    const state = await openEarnings(page, "unavailable");
    await fillRedemptionIntent(page);

    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "The selected payout network is unavailable." }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Redeem Tokens" }),
    ).toBeDisabled();
    expect(state.postBodies).toHaveLength(0);
  });

  test("expires and refreshes a quote before enabling submit", async ({
    page,
  }) => {
    const state = await openEarnings(page, "expires");
    await fillRedemptionIntent(page);
    await expect(page.getByText("49.3600 elizaOS")).toBeVisible();
    await expect(
      page.getByText(
        "This quote has expired. Request a new quote to continue.",
      ),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole("button", { name: "Redeem Tokens" }),
    ).toBeDisabled();

    await page.getByRole("button", { name: "Refresh quote" }).click();
    await expect.poll(() => state.quoteRequests.length).toBeGreaterThan(1);
    await expect(
      page.getByText(
        "This quote has expired. Request a new quote to continue.",
      ),
    ).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Redeem Tokens" }),
    ).toBeEnabled();
  });
});
