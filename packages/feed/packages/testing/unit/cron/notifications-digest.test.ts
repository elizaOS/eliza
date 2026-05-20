import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';

const mockRecordCronExecution = mock(() => {});
const mockRelayCronToStaging = mock();
const mockVerifyCronAuth = mock(() => true);
const mockListDigestCandidates = mock();
const mockIsDigestDue = mock(() => true);
const mockDeliverDigestForUser = mock(async ({ candidate }) => ({
  delivered: true,
  hadContent: candidate.id === 'a' || candidate.id === 'b',
}));

const _actualBabylonApi = await import('@babylon/api');
mock.module('@babylon/api', () => ({
  ..._actualBabylonApi,
  getDeploymentEnvironment: () =>
    process.env.VERCEL_ENV === 'production'
      ? 'production'
      : process.env.VERCEL_ENV === 'preview'
        ? 'staging'
        : 'development',
  recordCronExecution: mockRecordCronExecution,
  relayCronToStaging: mockRelayCronToStaging,
  successResponse: (body: unknown, status = 200) =>
    Response.json(body, { status }),
  verifyCronAuth: mockVerifyCronAuth,
  withErrorHandling: (handler: (request: Request) => Promise<Response>) =>
    handler,
}));

mock.module('@/lib/services/notification-digest-service', () => ({
  deliverDigestForUser: mockDeliverDigestForUser,
  isDigestDue: mockIsDigestDue,
  listDigestCandidates: mockListDigestCandidates,
}));

const { GET, shouldProcessUser } = await import(
  '../../../../apps/web/src/app/api/cron/notifications-digest/route'
);

describe('notifications-digest cron fan-out', () => {
  beforeEach(() => {
    mockRecordCronExecution.mockClear();
    mockRelayCronToStaging.mockReset();
    mockVerifyCronAuth.mockReset();
    mockVerifyCronAuth.mockReturnValue(true);
    mockListDigestCandidates.mockReset();
    mockIsDigestDue.mockReset();
    mockIsDigestDue.mockReturnValue(true);
    mockDeliverDigestForUser.mockReset();
    mockDeliverDigestForUser.mockImplementation(async ({ candidate }) => ({
      delivered: true,
      hadContent: candidate.id === 'a' || candidate.id === 'b',
    }));
    delete process.env.SHARED_DATABASE_WITH_STAGING;
    delete process.env.VERCEL_ENV;
  });

  test('partitions local production execution when relay fan-out is active', async () => {
    process.env.VERCEL_ENV = 'production';
    mockRelayCronToStaging.mockResolvedValue({
      forwarded: true,
      status: 200,
    });
    mockListDigestCandidates.mockResolvedValue([
      {
        id: 'a',
        digestEnabled: true,
        digestFrequency: 'daily',
        deliveryChannel: 'email',
        lastSentAt: null,
      },
      {
        id: 'b',
        digestEnabled: true,
        digestFrequency: 'daily',
        deliveryChannel: 'email',
        lastSentAt: null,
      },
    ]);

    const response = await GET(
      new NextRequest('https://babylon.market/api/cron/notifications-digest')
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(shouldProcessUser('a', true)).toBe(false);
    expect(shouldProcessUser('b', true)).toBe(true);
    expect(mockDeliverDigestForUser).toHaveBeenCalledTimes(1);
    expect(mockDeliverDigestForUser.mock.calls[0]?.[0]?.candidate.id).toBe('b');
    expect(data).toMatchObject({
      success: true,
      processed: 1,
      delivered: 1,
      skippedPartition: 1,
    });
  });

  test('partitions relayed staging execution using the relay header', async () => {
    process.env.VERCEL_ENV = 'preview';
    mockRelayCronToStaging.mockResolvedValue({ forwarded: false });
    mockListDigestCandidates.mockResolvedValue([
      {
        id: 'a',
        digestEnabled: true,
        digestFrequency: 'daily',
        deliveryChannel: 'email',
        lastSentAt: null,
      },
      {
        id: 'b',
        digestEnabled: true,
        digestFrequency: 'daily',
        deliveryChannel: 'email',
        lastSentAt: null,
      },
    ]);

    const request = new NextRequest(
      'https://staging.babylon.market/api/cron/notifications-digest',
      {
        headers: {
          'x-cron-relay': 'notifications-digest',
        },
      }
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(shouldProcessUser('a', true)).toBe(true);
    expect(shouldProcessUser('b', true)).toBe(false);
    expect(mockDeliverDigestForUser).toHaveBeenCalledTimes(1);
    expect(mockDeliverDigestForUser.mock.calls[0]?.[0]?.candidate.id).toBe('a');
    expect(data).toMatchObject({
      success: true,
      processed: 1,
      delivered: 1,
      skippedPartition: 1,
    });
  });
});
