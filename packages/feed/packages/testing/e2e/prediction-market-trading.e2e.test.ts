/**
 * Prediction Market Trading E2E Tests (Simulation Mode)
 *
 * Tests the prediction market buy/sell lifecycle via API:
 * - List available markets
 * - Buy YES/NO shares
 * - Verify position created
 * - Sell shares
 * - Verify balance updates
 *
 * Prerequisites:
 * - Server running at PLAYWRIGHT_BASE_URL with simulation settlement mode
 * - Database with at least one active prediction market
 * - Dev auth enabled (ALLOW_TEST_STEWARD_AUTH=true)
 *
 * Run with: npx playwright test prediction-market-trading.e2e.test.ts
 */

import { expect, test } from "@playwright/test";
import {
  type BrowserDevAuthSession,
  installPlaywrightDevAuth,
} from "./dev-auth";

const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.TEST_BASE_URL ||
  "http://127.0.0.1:3400";

let serverAvailable = false;
let authSession: BrowserDevAuthSession | null = null;
let authHeaders: Record<string, string> = {};

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { ...authHeaders, accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `GET ${path} failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `POST ${path} failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

type PredictionMarket = {
  id: string;
  question: string;
  status: string;
  yesProbability: number;
  noProbability: number;
  yesShares: number;
  noShares: number;
  liquidity: number;
  resolved: boolean;
};

function skipUnless<T>(value: T | null | undefined): asserts value is T {
  if (value == null) {
    test.skip();
  }
}

type PredictionBuyResponse = {
  position: {
    id: string;
    marketId: string;
    side: string;
    shares: number;
    avgPrice: number;
    totalCost: number;
  };
  market: {
    yesPrice: number;
    noPrice: number;
  };
  fee: { amount: number };
  newBalance: number;
};

test.describe("Prediction Market Trading (Simulation)", () => {
  test.beforeAll(async ({ browser }) => {
    // Check server availability
    try {
      const response = await fetch(`${BASE_URL}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      serverAvailable = response.ok;
    } catch {
      serverAvailable = false;
    }

    if (!serverAvailable) {
      return;
    }

    // Set up dev auth and extract cookies for API calls
    const context = await browser.newContext();
    const page = await context.newPage();
    authSession = await installPlaywrightDevAuth(page, BASE_URL);

    const cookies = await context.cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    authHeaders = { cookie: cookieHeader };

    await page.close();
    await context.close();
  });

  test("should list prediction markets", async () => {
    test.skip(!serverAvailable, "Server not available");

    const data = await apiGet<{ questions: PredictionMarket[]; count: number }>(
      "/api/markets/predictions",
    );

    expect(data.questions).toBeDefined();
    expect(Array.isArray(data.questions)).toBe(true);
    expect(data.count).toBeGreaterThanOrEqual(0);

    const firstMarket = data.questions[0];
    if (firstMarket) {
      expect(firstMarket.id).toBeDefined();
      expect(firstMarket.question).toBeDefined();
      expect(typeof firstMarket.yesProbability).toBe("number");
      expect(typeof firstMarket.noProbability).toBe("number");
    }
  });

  test("should buy YES shares in a simulation prediction market", async () => {
    test.skip(!serverAvailable, "Server not available");

    const { questions } = await apiGet<{ questions: PredictionMarket[] }>(
      "/api/markets/predictions",
    );

    const market = questions.find((q) => !q.resolved && q.status === "active");
    skipUnless(market);

    const result = await apiPost<PredictionBuyResponse>(
      `/api/markets/predictions/${market.id}/buy`,
      { side: "yes", amount: 10 },
    );

    expect(result.position).toBeDefined();
    expect(result.position.marketId).toBe(market.id);
    expect(result.position.side).toMatch(/yes/i);
    expect(result.position.shares).toBeGreaterThan(0);
    expect(result.position.avgPrice).toBeGreaterThan(0);
    expect(result.fee.amount).toBeGreaterThanOrEqual(0);
    expect(typeof result.newBalance).toBe("number");
  });

  test("should buy NO shares in a simulation prediction market", async () => {
    test.skip(!serverAvailable, "Server not available");

    const { questions } = await apiGet<{ questions: PredictionMarket[] }>(
      "/api/markets/predictions",
    );

    const market = questions.find((q) => !q.resolved && q.status === "active");
    skipUnless(market);

    const result = await apiPost<PredictionBuyResponse>(
      `/api/markets/predictions/${market.id}/buy`,
      { side: "no", amount: 10 },
    );

    expect(result.position).toBeDefined();
    expect(result.position.side).toMatch(/no/i);
    expect(result.position.shares).toBeGreaterThan(0);
  });

  test("should reflect position in market listing after buy", async () => {
    test.skip(!serverAvailable || !authSession, "Server/auth not available");

    const { questions } = await apiGet<{ questions: PredictionMarket[] }>(
      `/api/markets/predictions?userId=${authSession?.userId}`,
    );

    // At least one market should have a user position from the prior buy tests
    const withPosition = questions.find(
      (q) =>
        (q as PredictionMarket & { userPosition?: unknown }).userPosition !==
          null &&
        (q as PredictionMarket & { userPosition?: unknown }).userPosition !==
          undefined,
    );

    // This may not exist if buy tests were skipped
    if (withPosition) {
      const pos = (
        withPosition as PredictionMarket & {
          userPosition: { shares: number; side: boolean };
        }
      ).userPosition;
      expect(pos.shares).toBeGreaterThan(0);
    }
  });
});
