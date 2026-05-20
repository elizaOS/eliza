import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { NextRequest } from 'next/server';

const notificationsTable = {
  id: 'notifications.id',
  userId: 'notifications.userId',
  actorId: 'notifications.actorId',
  createdAt: 'notifications.createdAt',
  read: 'notifications.read',
  type: 'notifications.type',
};

const usersTable = {
  id: 'users.id',
  displayName: 'users.displayName',
  username: 'users.username',
  profileImageUrl: 'users.profileImageUrl',
  notificationDigestEnabled: 'users.notificationDigestEnabled',
  notificationDigestFrequency: 'users.notificationDigestFrequency',
  notificationDigestDeliveryChannel: 'users.notificationDigestDeliveryChannel',
};

const mockAuthenticate = mock(async () => ({ userId: 'user-1' }));
const mockGetCacheOrFetch = mock(
  async <T>(_key: string, fetchFn: () => Promise<T>) => await fetchFn()
);
const mockSuccessResponse = mock(
  (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
);
const mockGetBlockedUserIds = mock(async () => []);
const mockGetMutedUserIds = mock(async () => []);
const mockGetBlockedByUserIds = mock(async () => []);
const mockLoggerInfo = mock(() => undefined);
const mockLoggerWarn = mock(() => undefined);
const mockLoggerError = mock(() => undefined);

let notificationRows: Array<
  Record<string, unknown> & { actorId?: string | null }
>;
let unreadCountRows: Array<{ count: number | string }>;
let actorRows: Array<Record<string, unknown>>;
let digestRows: Array<Record<string, unknown>>;
let notificationSelectError: unknown;
let unreadCountError: unknown;
let actorSelectError: unknown;
let digestSelectError: unknown;

const mockNotificationLimit = mock(async () => {
  if (notificationSelectError) {
    throw notificationSelectError;
  }
  return notificationRows;
});
const mockNotificationOrderBy = mock(() => ({ limit: mockNotificationLimit }));
const mockNotificationWhere = mock(() => ({
  orderBy: mockNotificationOrderBy,
}));

const mockUnreadWhere = mock(async () => {
  if (unreadCountError) {
    throw unreadCountError;
  }
  return unreadCountRows;
});

const mockActorWhere = mock(async () => {
  if (actorSelectError) {
    throw actorSelectError;
  }
  return actorRows;
});

const mockDigestLimit = mock(async () => {
  if (digestSelectError) {
    throw digestSelectError;
  }
  return digestRows;
});
const mockDigestWhere = mock(() => ({ limit: mockDigestLimit }));

const mockDbSelect = mock((shape?: unknown) => ({
  from: (table: unknown) => {
    if (table === notificationsTable) {
      const isCountQuery =
        !!shape &&
        typeof shape === 'object' &&
        shape !== null &&
        'count' in shape;

      return isCountQuery
        ? { where: mockUnreadWhere }
        : { where: mockNotificationWhere };
    }

    if (table === usersTable) {
      const keys =
        shape && typeof shape === 'object' && shape !== null
          ? Object.keys(shape as Record<string, unknown>)
          : [];

      if (keys.includes('notificationDigestEnabled')) {
        return { where: mockDigestWhere };
      }

      return { where: mockActorWhere };
    }

    throw new Error('Unexpected table mock');
  },
}));

const _actualBabylonApi = await import('@babylon/api');
mock.module('@babylon/api', () => ({
  ..._actualBabylonApi,
  authenticate: mockAuthenticate,
  CACHE_KEYS: { USER: 'user' },
  getCacheOrFetch: mockGetCacheOrFetch,
  InternalServerError: class InternalServerError extends Error {},
  invalidateCachePattern: mock(async () => undefined),
  successResponse: mockSuccessResponse,
  withErrorHandling:
    (handler: (request: NextRequest) => Promise<Response>) =>
    async (request: NextRequest) => {
      try {
        return await handler(request);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
    },
}));

const _actualDb = await import('@babylon/db');
mock.module('@babylon/db', () => ({
  ..._actualDb,
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  count: () => ({ op: 'count' }),
  db: {
    select: mockDbSelect,
  },
  desc: (value: unknown) => ({ op: 'desc', value }),
  eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
  getBlockedByUserIds: mockGetBlockedByUserIds,
  getBlockedUserIds: mockGetBlockedUserIds,
  getMutedUserIds: mockGetMutedUserIds,
  inArray: (column: unknown, values: unknown[]) => ({
    op: 'inArray',
    column,
    values,
  }),
  notifications: notificationsTable,
  users: usersTable,
}));

const _actualShared = await import('@babylon/shared');
mock.module('@babylon/shared', () => ({
  ..._actualShared,
  DEFAULT_NOTIFICATION_DIGEST_SETTINGS: {
    digestEnabled: true,
    frequency: 'daily',
    deliveryChannel: 'both',
  },
  toISO: (val: Date | string) =>
    val instanceof Date ? val.toISOString() : new Date(val).toISOString(),
  logger: {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
  },
  MarkNotificationsReadSchema: {
    parse: (value: unknown) => value,
  },
  NotificationsQuerySchema: {
    parse: (input: Record<string, string>) => ({
      limit: Number(input.limit ?? '50'),
      unreadOnly: input.unreadOnly === 'true',
      type: input.type ?? undefined,
    }),
  },
  toISOOrNull: (val: Date | string | null | undefined) =>
    val == null
      ? null
      : val instanceof Date
        ? val.toISOString()
        : new Date(val).toISOString(),
}));

const { GET: getNotifications } = await import(
  '../../../apps/web/src/app/api/notifications/route'
);
const { GET: getDigestSettings } = await import(
  '../../../apps/web/src/app/api/notifications/digest-settings/route'
);

function makeRequest(path: string): NextRequest {
  return new Request(`http://localhost${path}`, {
    headers: { Authorization: 'Bearer test-token' },
  }) as NextRequest;
}

describe('notification route fallbacks', () => {
  beforeEach(() => {
    notificationRows = [
      {
        id: 'notif-1',
        type: 'follow',
        title: 'New follower',
        actorId: 'actor-1',
        postId: null,
        commentId: null,
        chatId: null,
        groupId: null,
        inviteId: null,
        message: 'Alpha followed you',
        data: null,
        read: false,
        createdAt: new Date('2026-03-19T10:00:00.000Z'),
      },
    ];
    unreadCountRows = [{ count: 1 }];
    actorRows = [
      {
        id: 'actor-1',
        displayName: 'Alpha',
        username: 'alpha',
        profileImageUrl: null,
      },
    ];
    digestRows = [
      {
        notificationDigestEnabled: false,
        notificationDigestFrequency: 'weekly',
        notificationDigestDeliveryChannel: 'email',
      },
    ];
    notificationSelectError = undefined;
    unreadCountError = undefined;
    actorSelectError = undefined;
    digestSelectError = undefined;

    mockAuthenticate.mockClear();
    mockGetCacheOrFetch.mockClear();
    mockSuccessResponse.mockClear();
    mockGetBlockedUserIds.mockClear();
    mockGetMutedUserIds.mockClear();
    mockGetBlockedByUserIds.mockClear();
    mockLoggerInfo.mockClear();
    mockLoggerWarn.mockClear();
    mockLoggerError.mockClear();
    mockDbSelect.mockClear();
    mockNotificationWhere.mockClear();
    mockNotificationOrderBy.mockClear();
    mockNotificationLimit.mockClear();
    mockUnreadWhere.mockClear();
    mockActorWhere.mockClear();
    mockDigestWhere.mockClear();
    mockDigestLimit.mockClear();
  });

  test('returns an empty notifications payload when the notification schema is missing', async () => {
    notificationSelectError = Object.assign(
      new Error('column "data" does not exist'),
      {
        code: '42703',
      }
    );

    const response = await getNotifications(
      makeRequest('/api/notifications?unreadOnly=true&limit=1')
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      notifications: [],
      unreadCount: 0,
    });
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockActorWhere).not.toHaveBeenCalled();
  });

  test('does not swallow unrelated schema failures from moderation lookups', async () => {
    const moderationError = Object.assign(
      new Error('relation "UserMute" does not exist'),
      {
        code: '42P01',
      }
    );
    mockGetMutedUserIds.mockRejectedValueOnce(moderationError);

    const response = await getNotifications(makeRequest('/api/notifications'));
    const body = await response.json();

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(body.notifications).toBeUndefined();
    expect(mockGetCacheOrFetch).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  test('returns default digest settings when digest columns are missing', async () => {
    digestSelectError = Object.assign(
      new Error('column "notificationDigestEnabled" does not exist'),
      {
        code: '42703',
      }
    );

    const response = await getDigestSettings(
      makeRequest('/api/notifications/digest-settings')
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      settings: {
        digestEnabled: true,
        frequency: 'daily',
        deliveryChannel: 'both',
      },
    });
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });
});
