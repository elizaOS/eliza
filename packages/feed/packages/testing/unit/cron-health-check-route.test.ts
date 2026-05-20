import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetSystemStatusSnapshot = mock();
const mockSendDiscordSystemAlertIfNeeded = mock();

const _actualBabylonApi = await import('@babylon/api');
mock.module('@babylon/api', () => ({
  ..._actualBabylonApi,
  getSystemStatusSnapshot: mockGetSystemStatusSnapshot,
  sendDiscordSystemAlertIfNeeded: mockSendDiscordSystemAlertIfNeeded,
  withCronAuth: (
    _jobName: string,
    handler: (request: NextRequest) => Promise<Response>
  ) => handler,
  withErrorHandling: (handler: (request: NextRequest) => Promise<Response>) =>
    handler,
}));

const { GET } = await import(
  '../../../apps/web/src/app/api/cron/health-check/route'
);

function createSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    status: 'healthy',
    issues: [],
    criticalIssues: [],
    timestamp: '2026-03-07T12:00:00.000Z',
    summary: {
      total: 9,
      healthyCount: 9,
      warningCount: 0,
      criticalCount: 0,
    },
    health: {
      database: true,
      redis: true,
      overall: true,
      timestamp: '2026-03-07T12:00:00.000Z',
    },
    ...overrides,
  };
}

describe('cron health-check route', () => {
  beforeEach(() => {
    mockGetSystemStatusSnapshot.mockReset();
    mockSendDiscordSystemAlertIfNeeded.mockReset();
  });

  test('returns healthy response when database is connected', async () => {
    mockGetSystemStatusSnapshot.mockResolvedValue(createSnapshot());
    mockSendDiscordSystemAlertIfNeeded.mockResolvedValue({
      sent: false,
      reason: 'status_not_critical',
    });

    const response = await GET(
      new NextRequest('https://babylon.market/api/cron/health-check')
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.status).toBe('healthy');
    expect(data.database).toBe('connected');
    expect(data.systemStatus).toBe('healthy');
    expect(data.alert.reason).toBe('status_not_critical');
  });

  test('returns unhealthy response and alert metadata when database is down', async () => {
    mockGetSystemStatusSnapshot.mockResolvedValue(
      createSnapshot({
        status: 'critical',
        issues: ['Database: Unavailable'],
        criticalIssues: ['Database: Unavailable'],
        summary: {
          total: 9,
          healthyCount: 7,
          warningCount: 1,
          criticalCount: 1,
        },
        health: {
          database: false,
          redis: true,
          overall: false,
          timestamp: '2026-03-07T12:00:00.000Z',
        },
      })
    );
    mockSendDiscordSystemAlertIfNeeded.mockResolvedValue({
      sent: true,
      reason: 'sent',
    });

    const response = await GET(
      new NextRequest('https://babylon.market/api/cron/health-check')
    );
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.success).toBe(false);
    expect(data.status).toBe('unhealthy');
    expect(data.database).toBe('error');
    expect(data.systemStatus).toBe('critical');
    expect(data.criticalIssues).toContain('Database: Unavailable');
    expect(data.alert.sent).toBe(true);
  });
});
