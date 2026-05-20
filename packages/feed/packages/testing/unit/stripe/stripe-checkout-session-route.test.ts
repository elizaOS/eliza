import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';

const STRIPE_CHECKOUT_UNAVAILABLE_MESSAGE =
  'Card payments are temporarily unavailable. Please try again later.';

const mockAuthenticate = mock(async () => ({
  dbUserId: 'user-123',
  email: 'user@example.com',
}));
const mockTrackServerEvent = mock(async () => undefined);
const mockCreateSession = mock(async () => ({
  id: 'cs_test_123',
  url: 'https://checkout.stripe.com/c/pay/cs_test_123',
}));
const mockGetBaseUrl = mock(() => 'https://babylon.market');
const mockValidatePurchaseAmount = mock(() => ({ valid: true }));
const mockLoggerInfo = mock(() => undefined);
const mockLoggerError = mock(() => undefined);

class MockServiceUnavailableError extends Error {
  statusCode: number;
  code?: string;
  context?: Record<string, unknown>;

  constructor(
    message = 'Service temporarily unavailable',
    code?: string,
    context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ServiceUnavailableError';
    this.statusCode = 503;
    this.code = code;
    this.context = context;
  }
}

const _actualBabylonApi = await import('@babylon/api');
mock.module('@babylon/api', () => ({
  ..._actualBabylonApi,
  authenticate: mockAuthenticate,
  ServiceUnavailableError: MockServiceUnavailableError,
  withErrorHandling:
    (handler: (req: NextRequest) => Promise<Response>) =>
    async (req: NextRequest) => {
      try {
        return await handler(req);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'An unexpected error occurred';
        const statusCode =
          typeof error === 'object' &&
          error !== null &&
          'statusCode' in error &&
          typeof error.statusCode === 'number'
            ? error.statusCode
            : 500;

        return new Response(JSON.stringify({ error: message }), {
          status: statusCode,
          headers: { 'content-type': 'application/json' },
        });
      }
    },
}));

const _actualShared = await import('@babylon/shared');
mock.module('@babylon/shared', () => ({
  ..._actualShared,
  logger: {
    info: mockLoggerInfo,
    error: mockLoggerError,
  },
}));

mock.module('@/lib/posthog/server', () => ({
  trackServerEvent: mockTrackServerEvent,
}));

const _actualStripeServer = await import('@/lib/stripe/server');
mock.module('@/lib/stripe/server', () => ({
  ..._actualStripeServer,
  calculatePointsFromUSD: (amountUSD: number) => Math.floor(amountUSD * 100),
  getBaseUrl: mockGetBaseUrl,
  POINTS_CONFIG: {
    ..._actualStripeServer.POINTS_CONFIG,
    CURRENCY: 'usd',
  },
  stripe: {
    checkout: {
      sessions: {
        create: mockCreateSession,
      },
    },
  },
  validatePurchaseAmount: mockValidatePurchaseAmount,
}));

const { POST } = await import('@/app/api/stripe/checkout/session/route');

function makeRequest(
  body: Record<string, unknown>,
  headers?: Record<string, string>
): NextRequest {
  return new Request('https://babylon.market/api/stripe/checkout/session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      origin: 'https://babylon.market',
      Authorization: 'Bearer test-token',
      ...headers,
    },
    body: JSON.stringify(body),
  }) as NextRequest;
}

describe('Stripe checkout session route', () => {
  beforeEach(() => {
    mockAuthenticate.mockClear();
    mockAuthenticate.mockResolvedValue({
      dbUserId: 'user-123',
      email: 'user@example.com',
    });
    mockTrackServerEvent.mockClear();
    mockCreateSession.mockClear();
    mockCreateSession.mockResolvedValue({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    });
    mockGetBaseUrl.mockClear();
    mockGetBaseUrl.mockReturnValue('https://babylon.market');
    mockValidatePurchaseAmount.mockClear();
    mockValidatePurchaseAmount.mockReturnValue({ valid: true });
    mockLoggerInfo.mockClear();
    mockLoggerError.mockClear();
  });

  afterAll(() => {
    mock.restore();
  });

  it('creates a checkout session and returns the redirect URL', async () => {
    const response = await POST(makeRequest({ amountUSD: 25 }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      sessionId: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    });
    expect(mockValidatePurchaseAmount).toHaveBeenCalledWith(25);
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        customer_email: 'user@example.com',
        cancel_url: 'https://babylon.market/markets?stripe_cancelled=true',
        success_url:
          'https://babylon.market/markets?stripe_success=true&session_id={CHECKOUT_SESSION_ID}',
        metadata: {
          app: 'babylon',
          userId: 'user-123',
          balanceUnits: '2500',
          amountUSD: '25',
          purchaseType: 'trading_balance',
        },
      })
    );
    expect(mockTrackServerEvent).toHaveBeenCalledWith(
      'user-123',
      'stripe_checkout_initiated',
      {
        amountUSD: 25,
        balanceUnits: 2500,
        sessionId: 'cs_test_123',
      }
    );
  });

  it('returns a stable 503 when Stripe checkout creation is unavailable', async () => {
    mockCreateSession.mockRejectedValueOnce(
      new Error('STRIPE_SECRET_KEY environment variable is required')
    );

    const response = await POST(makeRequest({ amountUSD: 25 }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: STRIPE_CHECKOUT_UNAVAILABLE_MESSAGE,
    });
    expect(mockTrackServerEvent).not.toHaveBeenCalled();
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });
});
