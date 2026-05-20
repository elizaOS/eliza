import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';

const mockAuthenticate = mock(async () => ({ userId: 'user-1' }));
const mockBroadcastToChannel = mock(async () => undefined);
const mockCheckProgress = mock(async () => undefined);
const mockTrackServerEvent = mock(async () => undefined);
const mockWalletBalance = mock(async () => ({ balance: 987 }));
const mockGetMarket = mock();
const mockSell = mock();

class BusinessLogicError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
  }
}

mock.module('@babylon/api', () => ({
  authenticate: mockAuthenticate,
  BusinessLogicError,
  broadcastToChannel: mockBroadcastToChannel,
  checkProgress: mockCheckProgress,
  invalidateMarketsApiPredictionsAfterUserTrade: mock(async () => undefined),
  successResponse: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  withErrorHandling:
    (
      handler: (
        request: NextRequest,
        context: { params: Promise<{ id: string }> }
      ) => Promise<Response>
    ) =>
    async (
      request: NextRequest,
      context: { params: Promise<{ id: string }> }
    ) => {
      try {
        return await handler(request, context);
      } catch (error) {
        if (error instanceof BusinessLogicError) {
          return new Response(
            JSON.stringify({
              error: { message: error.message, code: error.code },
            }),
            {
              status: 400,
              headers: { 'content-type': 'application/json' },
            }
          );
        }

        throw error;
      }
    },
}));

mock.module('@babylon/core/markets/prediction', () => ({
  PredictionDbAdapter: class PredictionDbAdapter {},
  PredictionMarketService: class PredictionMarketService {
    getMarket = mockGetMarket;
    sell = mockSell;
  },
}));

mock.module('@babylon/engine', () => ({
  FEE_CONFIG: {
    TRADING_FEE_RATE: 0.02,
    PLATFORM_SHARE: 0.5,
    REFERRER_SHARE: 0.5,
    MIN_FEE_AMOUNT: 0,
    FEE_TYPES: { TRADE: 'trade' },
  },
  FeeService: {
    processTradingFee: mock(async () => undefined),
  },
  invalidateAfterPredictionTrade: mock(async () => undefined),
  WalletService: {
    debit: mock(async () => undefined),
    credit: mock(async () => undefined),
    recordPnL: mock(async () => undefined),
    getBalance: mockWalletBalance,
  },
}));

mock.module('@babylon/shared', () => ({
  logger: {
    warn: mock(() => undefined),
    debug: mock(() => undefined),
  },
  PredictionMarketIdSchema: {
    parse: (value: { id: string }) => value,
  },
  PredictionMarketSellSchema: {
    parse: (value: { shares: number; positionId: string }) => value,
  },
}));

mock.module('@/lib/posthog/server', () => ({
  trackServerEvent: mockTrackServerEvent,
}));

const { POST } = await import('./route');

describe('POST /api/markets/predictions/[id]/sell', () => {
  beforeEach(() => {
    mockAuthenticate.mockClear();
    mockBroadcastToChannel.mockClear();
    mockCheckProgress.mockClear();
    mockTrackServerEvent.mockClear();
    mockWalletBalance.mockClear();
    mockGetMarket.mockReset();
    mockSell.mockReset();
  });

  it('sells shares through the offchain prediction market service', async () => {
    mockSell.mockResolvedValue({
      totalProceeds: 19,
      netProceeds: 18.5,
      pnl: 4.25,
      feePaid: 0.5,
      remainingShares: 0,
      positionClosed: true,
      positionId: 'position-2',
      market: { priceImpact: 0.02 },
    });

    const response = await POST(
      new Request('http://localhost/api/markets/predictions/market-2/sell', {
        method: 'POST',
        body: JSON.stringify({ shares: 10, positionId: 'position-2' }),
      }) as NextRequest,
      { params: Promise.resolve({ id: 'market-2' }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sharesSold: 10,
      grossProceeds: 19,
      netProceeds: 18.5,
      pnl: 4.25,
      remainingShares: 0,
      positionClosed: true,
      newBalance: 987,
      positionId: 'position-2',
    });
    expect(mockSell).toHaveBeenCalledWith({
      userId: 'user-1',
      marketId: 'market-2',
      shares: 10,
      positionId: 'position-2',
    });
  });
});
