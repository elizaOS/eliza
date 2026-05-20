import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHmac } from 'node:crypto';

const _actualShared = await import('@babylon/shared');
const _actualDb = await import('@babylon/db');

const insertReturningMock = mock(async () => [{ id: 'inbox-123' }]);
const insertOnConflictMock = mock(() => ({
  returning: insertReturningMock,
}));
const insertValuesMock = mock(() => ({
  onConflictDoNothing: insertOnConflictMock,
}));
const insertMock = mock(() => ({
  values: insertValuesMock,
}));
const generateSnowflakeIdMock = mock(async () => 'inbox-123');

let ingestSentryWebhook: typeof import('../../../packages/api/src/services/sentry-webhook-inbox-service').ingestSentryWebhook;

function computeTimestampPrefixedSignature(
  secret: string,
  timestamp: string,
  rawBody: string
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

function computeBodyOnlySignature(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function toTimestampDate(timestamp: string): Date {
  return new Date(Number.parseInt(timestamp, 10) * 1000);
}

describe('ingestSentryWebhook signature compatibility', () => {
  beforeAll(async () => {
    mock.module('@babylon/db', () => ({
      ..._actualDb,
      db: {
        insert: insertMock,
      },
      generateSnowflakeId: generateSnowflakeIdMock,
      sentryWebhookInboxes: {
        dedupeKey: 'dedupeKey',
        id: 'id',
      },
    }));

    mock.module('@babylon/shared', () => ({
      ..._actualShared,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    }));

    ({ ingestSentryWebhook } = await import(
      '../../../packages/api/src/services/sentry-webhook-inbox-service'
    ));
  });

  beforeEach(() => {
    insertMock.mockClear();
    insertValuesMock.mockClear();
    insertOnConflictMock.mockClear();
    insertReturningMock.mockClear();
    generateSnowflakeIdMock.mockClear();
  });

  it('accepts timestamp-prefixed signatures', async () => {
    const rawBody = JSON.stringify({
      action: 'assigned',
      data: {
        project: { slug: 'babylon' },
        issue: { id: '123', shortId: 'BAB-123', title: 'Test issue' },
      },
    });
    const timestamp = '1772915046';
    const secret = 'secret';

    const result = await ingestSentryWebhook({
      rawBody,
      secret,
      now: toTimestampDate(timestamp),
      headers: {
        signature: computeTimestampPrefixedSignature(
          secret,
          timestamp,
          rawBody
        ),
        timestamp,
        resource: 'issue',
        event: 'assigned',
        requestId: null,
        userAgent: 'bun-test',
      },
    });

    expect(result.ok).toBe(true);
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it('accepts body-only signatures used by current Sentry internal integrations', async () => {
    const rawBody = JSON.stringify({
      action: 'assigned',
      data: {
        project: { slug: 'babylon' },
        issue: { id: '456', shortId: 'BAB-456', title: 'Body-only signature' },
      },
    });
    const timestamp = '1772915046';
    const secret = 'secret';

    const result = await ingestSentryWebhook({
      rawBody,
      secret,
      now: toTimestampDate(timestamp),
      headers: {
        signature: computeBodyOnlySignature(secret, rawBody),
        timestamp,
        resource: 'issue',
        event: 'assigned',
        requestId: null,
        userAgent: 'bun-test',
      },
    });

    expect(result.ok).toBe(true);
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it('still rejects invalid signatures', async () => {
    const rawBody = JSON.stringify({
      action: 'assigned',
      data: {
        project: { slug: 'babylon' },
        issue: { id: '789', shortId: 'BAB-789', title: 'Bad signature' },
      },
    });
    const timestamp = '1772915046';

    const result = await ingestSentryWebhook({
      rawBody,
      secret: 'secret',
      now: toTimestampDate(timestamp),
      headers: {
        signature: '0'.repeat(64),
        timestamp,
        resource: 'issue',
        event: 'assigned',
        requestId: null,
        userAgent: 'bun-test',
      },
    });

    expect(result).toEqual({
      ok: false,
      httpStatus: 401,
      code: 'INVALID_SIGNATURE',
      message: 'Sentry webhook signature mismatch.',
    });
    expect(insertMock).toHaveBeenCalledTimes(0);
  });
});
