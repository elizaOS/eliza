import { beforeEach, describe, expect, it, mock } from 'bun:test';

const authenticateMock = mock(async () => ({
  userId: 'sender-1',
  dbUserId: 'sender-1',
}));
const checkRateLimitAsyncMock = mock(async () => ({
  allowed: true,
  retryAfter: 60,
}));
const transferMock = mock(async () => ({
  success: true as const,
  transferId: 'transfer-1',
  amount: 25,
  senderUserId: 'sender-1',
  recipientUserId: 'receiver-1',
  senderBalanceBefore: 100,
  senderBalanceAfter: 75,
  recipientBalanceBefore: 5,
  recipientBalanceAfter: 30,
}));

const apiModulePath = new URL(
  '../../../../../../../../packages/api/src/index.ts',
  import.meta.url
).pathname;
const sharedModulePath = new URL(
  '../../../../../../../../packages/shared/src/index.ts',
  import.meta.url
).pathname;

const apiModuleFactory = () => ({
  authenticate: authenticateMock,
  BusinessLogicError: class BusinessLogicError extends Error {
    code: string;

    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
  checkRateLimitAsync: checkRateLimitAsyncMock,
  logger: { info: mock(() => undefined) },
  RATE_LIMIT_CONFIGS: {
    A2A_TRANSFER_OPS: {
      maxRequests: 10,
      windowMs: 60000,
      actionType: 'a2a_transfer_ops',
    },
  },
  rateLimitError: (retryAfter?: number) =>
    Response.json({ error: 'Too many requests', retryAfter }, { status: 429 }),
  successResponse: (body: unknown) => Response.json(body),
  TradingBalanceTransferService: {
    transfer: transferMock,
  },
  withErrorHandling: (handler: (...args: unknown[]) => unknown) => handler,
});

const sharedModuleFactory = () => ({
  TransferTradingBalanceSchema: {
    parse: (body: unknown) => body,
  },
});

mock.module('@babylon/api', apiModuleFactory);
mock.module(apiModulePath, apiModuleFactory);
mock.module('@babylon/shared', sharedModuleFactory);
mock.module(sharedModulePath, sharedModuleFactory);

async function loadPostHandler() {
  const module = await import(`./route?test=${Date.now()}`);
  return module.POST;
}

describe('POST /api/users/trading-balance/transfer', () => {
  beforeEach(() => {
    authenticateMock.mockClear();
    checkRateLimitAsyncMock.mockClear();
    transferMock.mockClear();
    (globalThis as Record<string, unknown>).__routeTransferResult = {
      success: true,
      transferId: 'transfer-1',
      amount: 25,
      senderUserId: 'sender-1',
      recipientUserId: 'receiver-1',
      senderBalanceBefore: 100,
      senderBalanceAfter: 75,
      recipientBalanceBefore: 5,
      recipientBalanceAfter: 30,
    };
    (globalThis as Record<string, unknown>).__routeRateLimitResult = {
      allowed: true,
      retryAfter: 60,
    };
  });

  it('transfers trading balance through the canonical route', async () => {
    const POST = await loadPostHandler();
    const response = (await POST(
      new Request('https://example.com/api/users/trading-balance/transfer', {
        method: 'POST',
        body: JSON.stringify({
          recipientUserId: 'receiver-1',
          amount: 25,
          description: 'settlement',
        }),
      }) as unknown as import('next/server').NextRequest
    )) as Response;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.transfer.id).toBe('transfer-1');
    expect(body.transfer.amount).toBe('25');
    expect(body.sender.balanceAfter).toBe('75');
    expect(body.recipient.balanceAfter).toBe('30');
  });

  it('returns 429 when rate limited', async () => {
    checkRateLimitAsyncMock.mockResolvedValueOnce({
      allowed: false,
      retryAfter: 12,
    });
    (globalThis as Record<string, unknown>).__routeRateLimitResult = {
      allowed: false,
      retryAfter: 12,
    };

    const POST = await loadPostHandler();
    const response = (await POST(
      new Request('https://example.com/api/users/trading-balance/transfer', {
        method: 'POST',
        body: JSON.stringify({
          recipientUserId: 'receiver-1',
          amount: 25,
        }),
      }) as unknown as import('next/server').NextRequest
    )) as Response;
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.retryAfter).toBe(12);
  });
});
