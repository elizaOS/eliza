import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';

const mockAuthenticate = mock(async () => ({ userId: 'user-1' }));
const mockBroadcastToChannel = mock(async () => undefined);
const mockCheckProgress = mock(async () => undefined);
const mockTrackServerEvent = mock(async () => undefined);
const mockWalletBalance = mock(async () => ({ balance: 1234 }));
const mockGetMarket = mock();
const mockBuy = mock();

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
    buy = mockBuy;
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
  PredictionMarketTradeSchema: {
    parse: (value: { side: 'yes' | 'no'; amount: number }) => value,
  },
}));

mock.module('@/lib/posthog/server', () => ({
  trackServerEvent: mockTrackServerEvent,
}));

const { POST } = await import('./route');

describe('POST /api/markets/predictions/[id]/buy', () => {
  beforeEach(() => {
    mockAuthenticate.mockClear();
    mockBroadcastToChannel.mockClear();
    mockCheckProgress.mockClear();
    mockTrackServerEvent.mockClear();
    mockWalletBalance.mockClear();
    mockGetMarket.mockReset();
    mockBuy.mockReset();
  });

  it('buys shares through the offchain prediction market service', async () => {
    mockBuy.mockResolvedValue({
      positionId: 'position-1',
      shares: 14.5,
      avgPrice: 0.42,
      totalCost: 25,
      feePaid: 0.5,
      market: {
        priceImpact: 0.01,
        yesPrice: 0.52,
        noPrice: 0.48,
      },
    });

    const response = await POST(
      new Request('http://localhost/api/markets/predictions/market-2/buy', {
        method: 'POST',
        body: JSON.stringify({ side: 'yes', amount: 25 }),
      }) as NextRequest,
      { params: Promise.resolve({ id: 'market-2' }) }
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      position: {
        id: 'position-1',
        marketId: 'market-2',
        side: 'yes',
        shares: 14.5,
        avgPrice: 0.42,
        totalCost: 25,
      },
      newBalance: 1234,
    });
    expect(mockBuy).toHaveBeenCalledWith({
      userId: 'user-1',
      marketId: 'market-2',
      side: 'yes',
      amount: 25,
    });
  });
});
