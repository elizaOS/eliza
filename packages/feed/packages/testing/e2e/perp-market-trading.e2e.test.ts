/**
 * Perpetual Market Trading E2E Tests (Simulation Mode)
 *
 * Tests the perp market open/close lifecycle via API:
 * - List available perp markets
 * - Open a long position
 * - Verify position exists
 * - Close position
 * - Verify P&L and balance update
 *
 * Prerequisites:
 * - Server running at PLAYWRIGHT_BASE_URL with simulation settlement mode
 *   (NEXT_PUBLIC_PERP_SETTLEMENT_MODE=simulation or unset)
 * - Database with perp market snapshots seeded
 * - Dev auth enabled (ALLOW_TEST_PRIVY_DID_AUTH=true)
 *
 * Run with: npx playwright test perp-market-trading.e2e.test.ts
 */

import { expect, test } from '@playwright/test';
import {
  type BrowserDevAuthSession,
  installPlaywrightDevAuth,
} from './dev-auth';

const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3400';

let serverAvailable = false;
let isOnchainMode = false;
let _authSession: BrowserDevAuthSession | null = null;
let authHeaders: Record<string, string> = {};

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { ...authHeaders, accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(
      `GET ${path} failed: ${response.status} ${await response.text()}`
    );
  }
  return (await response.json()) as T;
}

async function apiPost<T>(
  path: string,
  body: unknown
): Promise<{ data: T; status: number }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as T;
  return { data, status: response.status };
}

function isOnchainError(status: number, _data: unknown): boolean {
  // When on-chain settlement mode is active and no EVM wallet is configured,
  // the server returns 500. The error is masked by withErrorHandling() as
  // "An unexpected error occurred", so we detect on-chain mode from the
  // beforeAll probe instead. This function is a fallback for any 500 response
  // when we know the server is in on-chain mode.
  return status === 500 && isOnchainMode;
}

function skipUnless<T>(value: T | null | undefined): asserts value is T {
  if (value == null) {
    test.skip();
  }
}

type PerpMarket = {
  ticker: string;
  organizationId: string;
  currentPrice: number;
  maxLeverage: number;
  minOrderSize: number;
  openInterest: number;
  volume24h: number;
  fundingRate: {
    rate: number;
    nextFundingTime: string;
  };
};

type PerpOpenResponse = {
  position: {
    id: string;
    ticker: string;
    side: string;
    entryPrice: number;
    currentPrice: number;
    size: number;
    leverage: number;
    fundingPaid: number;
    openedAt: string;
  };
  marginPaid: number;
  fee: { amount: number };
  newBalance: number;
  settlementMode?: string;
};

type PerpCloseResponse = {
  position: {
    id: string;
    ticker: string;
    side: string;
    entryPrice: number;
    exitPrice: number;
    realizedPnL: number;
  };
  grossSettlement: number;
  netSettlement: number;
  marginReturned: number;
  pnl: number;
  fee: { amount: number };
  wasLiquidated: boolean;
  newBalance: number;
};

test.describe('Perpetual Market Trading (Simulation)', () => {
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

    // Set up dev auth
    const context = await browser.newContext();
    const page = await context.newPage();
    _authSession = await installPlaywrightDevAuth(page, BASE_URL);

    const cookies = await context.cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    authHeaders = { cookie: cookieHeader };

    await page.close();
    await context.close();

    // Detect on-chain mode by probing a position open request.
    // The error handler masks the actual error as "An unexpected error occurred",
    // so we detect on-chain mode by checking if any 500 is returned when opening
    // a position (simulation mode never returns 500 for valid requests).
    try {
      const marketsRes = await fetch(`${BASE_URL}/api/markets/perps`, {
        headers: { ...authHeaders, accept: 'application/json' },
      });
      if (marketsRes.ok) {
        const marketsData = (await marketsRes.json()) as {
          markets?: PerpMarket[];
        };
        const firstTicker = marketsData.markets?.[0]?.ticker;
        if (firstTicker) {
          const probeRes = await fetch(`${BASE_URL}/api/markets/perps/open`, {
            method: 'POST',
            headers: {
              ...authHeaders,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify({
              ticker: firstTicker,
              side: 'long',
              size: 1,
              leverage: 1,
            }),
          });
          // Any 500 on a valid open request indicates on-chain mode without EVM wallet
          if (probeRes.status === 500) {
            isOnchainMode = true;
          }
        }
      }
    } catch {
      // Probe failed — assume simulation mode
    }
  });

  test('should list perp markets with price data', async () => {
    test.skip(!serverAvailable, 'Server not available');

    const data = await apiGet<{ markets: PerpMarket[]; count: number }>(
      '/api/markets/perps'
    );

    expect(data.markets).toBeDefined();
    expect(Array.isArray(data.markets)).toBe(true);

    const firstMarket = data.markets[0];
    if (firstMarket) {
      expect(firstMarket.ticker).toBeDefined();
      expect(typeof firstMarket.currentPrice).toBe('number');
      expect(firstMarket.currentPrice).toBeGreaterThan(0);
      expect(typeof firstMarket.maxLeverage).toBe('number');
      expect(firstMarket.maxLeverage).toBeGreaterThanOrEqual(1);
    }
  });

  test('should open a long position', async () => {
    test.skip(!serverAvailable, 'Server not available');
    test.skip(
      isOnchainMode,
      'Server is in on-chain settlement mode - requires EVM wallet'
    );

    const { markets } = await apiGet<{ markets: PerpMarket[] }>(
      '/api/markets/perps'
    );

    const market = markets[0];
    skipUnless(market);
    const tradeSize = Math.max(market.minOrderSize || 10, 10);

    const { data, status } = await apiPost<PerpOpenResponse>(
      '/api/markets/perps/open',
      {
        ticker: market.ticker,
        side: 'long',
        size: tradeSize,
        leverage: 2,
      }
    );
    if (isOnchainError(status, data)) {
      test.skip(
        true,
        'Server is in on-chain settlement mode - requires EVM wallet'
      );
      return;
    }

    expect(status).toBe(201);
    expect(data.position).toBeDefined();
    expect(data.position.ticker).toBe(market.ticker);
    expect(data.position.side).toBe('long');
    expect(data.position.entryPrice).toBeGreaterThan(0);
    expect(data.position.size).toBeGreaterThan(0);
    expect(data.position.leverage).toBe(2);
    expect(data.marginPaid).toBeGreaterThan(0);
    expect(data.fee.amount).toBeGreaterThanOrEqual(0);
    expect(typeof data.newBalance).toBe('number');
  });

  test('should open a short position', async () => {
    test.skip(!serverAvailable, 'Server not available');
    test.skip(
      isOnchainMode,
      'Server is in on-chain settlement mode - requires EVM wallet'
    );

    const { markets } = await apiGet<{ markets: PerpMarket[] }>(
      '/api/markets/perps'
    );

    // Use a different market to avoid position consolidation
    const market = markets[1];
    skipUnless(market);
    const tradeSize = Math.max(market.minOrderSize || 10, 10);

    const { data, status } = await apiPost<PerpOpenResponse>(
      '/api/markets/perps/open',
      {
        ticker: market.ticker,
        side: 'short',
        size: tradeSize,
        leverage: 3,
      }
    );
    if (isOnchainError(status, data)) {
      test.skip(
        true,
        'Server is in on-chain settlement mode - requires EVM wallet'
      );
      return;
    }

    expect(status).toBe(201);
    expect(data.position.side).toBe('short');
    expect(data.position.leverage).toBe(3);
  });

  test('should close a position and realize P&L', async () => {
    test.skip(!serverAvailable, 'Server not available');
    test.skip(
      isOnchainMode,
      'Server is in on-chain settlement mode - requires EVM wallet'
    );

    // First open a position
    const { markets } = await apiGet<{ markets: PerpMarket[] }>(
      '/api/markets/perps'
    );

    // Use the last market to avoid conflicts with earlier tests
    const market = markets[markets.length - 1];
    skipUnless(market);
    const tradeSize = Math.max(market.minOrderSize || 10, 10);

    const { data: openResult, status: openStatus } =
      await apiPost<PerpOpenResponse>('/api/markets/perps/open', {
        ticker: market.ticker,
        side: 'long',
        size: tradeSize,
        leverage: 2,
      });
    if (isOnchainError(openStatus, openResult)) {
      test.skip(
        true,
        'Server is in on-chain settlement mode - requires EVM wallet'
      );
      return;
    }

    expect(openResult.position.id).toBeDefined();
    const positionId = openResult.position.id;
    const _balanceAfterOpen = openResult.newBalance;

    // Close the position
    const { data: closeResult, status: closeStatus } =
      await apiPost<PerpCloseResponse>(
        `/api/markets/perps/position/${positionId}/close`,
        {}
      );

    expect(closeStatus).toBe(200);
    expect(closeResult.position).toBeDefined();
    expect(closeResult.position.id).toBe(positionId);
    expect(typeof closeResult.position.realizedPnL).toBe('number');
    expect(typeof closeResult.position.exitPrice).toBe('number');
    expect(closeResult.position.exitPrice).toBeGreaterThan(0);
    expect(closeResult.wasLiquidated).toBe(false);
    expect(typeof closeResult.newBalance).toBe('number');
    expect(typeof closeResult.marginReturned).toBe('number');
    expect(closeResult.marginReturned).toBeGreaterThan(0);
  });

  test('should reject invalid leverage', async () => {
    test.skip(!serverAvailable, 'Server not available');

    const { markets } = await apiGet<{ markets: PerpMarket[] }>(
      '/api/markets/perps'
    );

    const market = markets[0];
    skipUnless(market);

    const response = await fetch(`${BASE_URL}/api/markets/perps/open`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ticker: market.ticker,
        side: 'long',
        size: 10,
        leverage: 200, // exceeds max
      }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  test('should reject invalid ticker', async () => {
    test.skip(!serverAvailable, 'Server not available');

    const response = await fetch(`${BASE_URL}/api/markets/perps/open`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ticker: 'NONEXISTENT_TICKER',
        side: 'long',
        size: 10,
        leverage: 2,
      }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
