import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';

const mockPublicRateLimit = mock(async () => ({
  error: null,
  rateLimitInfo: null,
}));
const mockAuthenticate = mock(async () => ({ userId: 'user-1' }));
const mockPreviewOpenPosition = mock();
const mockPreviewOrder = mock();

mock.module('@babylon/api', () => ({
  addPublicReadHeaders: mock(() => undefined),
  authenticate: mockAuthenticate,
  publicRateLimit: mockPublicRateLimit,
  successResponse: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  withErrorHandling:
    (handler: (request: NextRequest) => Promise<Response>) =>
    async (request: NextRequest) =>
      await handler(request),
}));

mock.module('@babylon/shared', () => ({
  PerpOpenPositionSchema: {
    parse: (value: Record<string, unknown>) => value,
  },
}));

mock.module('../_adapters', () => ({
  createPerpMarketService: () => ({
    previewOpenPosition: mockPreviewOpenPosition,
    previewOrder: mockPreviewOrder,
  }),
}));

const { POST } = await import('./route');

describe('POST /api/markets/perps/preview', () => {
  beforeEach(() => {
    mockPublicRateLimit.mockClear();
    mockAuthenticate.mockClear();
    mockAuthenticate.mockResolvedValue({ userId: 'user-1' });
    mockPreviewOpenPosition.mockReset();
    mockPreviewOrder.mockReset();
  });

  it('returns the canonical offchain preview payload from the perp service', async () => {
    mockPreviewOpenPosition.mockResolvedValue({
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 5,
      currentPrice: 100,
      quotedPrice: 101,
      executionPrice: 101.4,
      quoteImpactPrice: 0.4,
      quoteImpactBps: 40,
      totalSlippageBps: 140,
      bidPrice: 99,
      askPrice: 101,
      spreadBps: 200,
      bidDepth: 1000,
      askDepth: 1000,
      liquidityRegime: 'balanced',
      marginRequired: 20,
      estimatedFee: 0.1,
      totalRequired: 20.1,
      liquidationPrice: 81.12,
      liquidationDistancePercent: 18.88,
    });

    const response = await POST(
      new Request('http://localhost/api/markets/perps/preview', {
        method: 'POST',
        body: JSON.stringify({
          ticker: 'abc',
          side: 'long',
          size: 100,
          leverage: 5,
        }),
      }) as NextRequest
    );

    expect(response.status).toBe(200);
    expect(mockPreviewOpenPosition).toHaveBeenCalledWith({
      ticker: 'abc',
      side: 'long',
      size: 100,
      leverage: 5,
    });
    expect(await response.json()).toEqual({
      preview: expect.objectContaining({
        settlementMode: 'offchain',
        executionPrice: 101.4,
        totalRequired: 20.1,
      }),
    });
  });

  it('uses authenticated offchain preview for rebalance-aware flows', async () => {
    mockPreviewOrder.mockResolvedValue({
      previewType: 'flip',
      isRebalance: true,
      rebalanceType: 'flip',
      ticker: 'ABC',
      side: 'long',
      size: 25,
      leverage: 5,
      currentPrice: 100,
      quotedPrice: 101,
      executionPrice: 101.4,
      quoteImpactPrice: 0.4,
      quoteImpactBps: 40,
      totalSlippageBps: 140,
      bidPrice: 99,
      askPrice: 101,
      spreadBps: 200,
      bidDepth: 1000,
      askDepth: 1000,
      liquidityRegime: 'balanced',
      marginRequired: 5,
      estimatedFee: 0.2,
      totalRequired: 1.25,
      resultingSize: 25,
      resultingSide: 'long',
      estimatedClosePrice: 98.7,
      estimatedCloseSettlement: 3.95,
      liquidationPrice: 81.12,
      liquidationDistancePercent: 18.88,
    });

    const response = await POST(
      new Request('http://localhost/api/markets/perps/preview', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          ticker: 'abc',
          side: 'long',
          size: 100,
          leverage: 5,
        }),
      }) as NextRequest
    );

    expect(response.status).toBe(200);
    expect(mockPreviewOpenPosition).not.toHaveBeenCalled();
    expect(mockPreviewOrder).toHaveBeenCalledWith({
      userId: 'user-1',
      ticker: 'abc',
      side: 'long',
      size: 100,
      leverage: 5,
    });
    expect(await response.json()).toEqual({
      preview: expect.objectContaining({
        settlementMode: 'offchain',
        rebalanceType: 'flip',
        totalRequired: 1.25,
      }),
    });
  });
});
