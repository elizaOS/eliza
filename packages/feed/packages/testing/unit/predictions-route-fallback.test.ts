import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as apiActual from '../../api/src';
import * as predictionCoreActual from '../../core/markets/prediction';
import * as dbActual from '../../db/src';

const mockPublicRateLimit = mock();
const mockListMarkets = mock();
const mockListUserPositions = mock();

mock.module('@feed/api', () => ({
  ...apiActual,
  addPublicReadHeaders: () => {},
  publicRateLimit: mockPublicRateLimit,
  successResponse: (data: unknown) => data,
  withErrorHandling: (handler: (request: Request) => Promise<unknown>) =>
    handler,
}));

mock.module('@feed/db', () => ({
  ...dbActual,
  db: {
    user: {
      findUnique: mock(async () => null),
    },
  },
}));

mock.module('@feed/core/markets/prediction', () => ({
  ...predictionCoreActual,
  PredictionDbAdapter: class PredictionDbAdapter {},
  PredictionMarketService: class PredictionMarketService extends predictionCoreActual.PredictionMarketService {
    listMarkets = mockListMarkets;
    listUserPositions = mockListUserPositions;
  },
  // Keep the real pricing API to avoid cross-test contamination when this
  // module mock is reused in combined runs.
  PredictionPricing: predictionCoreActual.PredictionPricing,
}));

const { GET } = await import(
  '../../../apps/web/src/app/api/markets/predictions/route'
);

describe('GET /api/markets/predictions', () => {
  beforeEach(() => {
    mockPublicRateLimit.mockReset();
    mockListMarkets.mockReset();
    mockListUserPositions.mockReset();

    mockPublicRateLimit.mockResolvedValue({
      error: null,
      user: {
        userId: 'user-1',
        dbUserId: 'db-user-1',
        privyId: 'did:privy:user-1',
      },
      rateLimitInfo: null,
    });

    mockListMarkets.mockResolvedValue([
      {
        id: 'market-1',
        question: 'Will BTC go up?',
        yesShares: 100,
        noShares: 100,
        status: 'active',
        resolved: false,
        resolution: null,
        endDate: new Date('2026-03-10T00:00:00.000Z'),
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
      },
    ]);
  });

  it('returns markets even when user position enrichment fails', async () => {
    mockListUserPositions.mockRejectedValue(new Error('permission denied'));

    const result = (await GET(
      new Request(
        'https://example.com/api/markets/predictions?userId=user-1'
      ) as unknown as import('next/server').NextRequest
    )) as unknown as {
      success: boolean;
      count: number;
      questions: { userPositions: unknown[] }[];
    };

    expect(result).toMatchObject({
      success: true,
      count: 1,
    });
    expect(result.questions[0]?.userPositions).toEqual([]);
  });

  it('returns public markets without optional user enrichment', async () => {
    const result = (await GET(
      new Request(
        'https://example.com/api/markets/predictions'
      ) as unknown as import('next/server').NextRequest
    )) as unknown as {
      success: boolean;
      count: number;
      questions: Array<{
        id: string;
        yesShares: number;
        noShares: number;
      }>;
    };

    expect(result).toMatchObject({
      success: true,
      count: 1,
    });
    expect(result.questions[0]).toMatchObject({
      id: 'market-1',
      yesShares: 100,
      noShares: 100,
    });
  });
});
