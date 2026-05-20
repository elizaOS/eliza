import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockSendWhitelistWelcomeEmailsToUsers = mock(() => Promise.resolve());

const whitelistTable = {
  id: 'id',
  userId: 'userId',
  source: 'source',
  reason: 'reason',
  grantedBy: 'grantedBy',
  grantedAt: 'grantedAt',
  revokedAt: 'revokedAt',
};
const whitelistConfigTable = {
  id: 'id',
  leaderboardRankThreshold: 'leaderboardRankThreshold',
};
const nftSnapshotTable = { userId: 'userId' };
const usersTable = {
  id: 'id',
  reputationPoints: 'reputationPoints',
  invitePoints: 'invitePoints',
  createdAt: 'createdAt',
  isActor: 'isActor',
  isAgent: 'isAgent',
};

let mockWhitelistConfigRow: { leaderboardRankThreshold: number | null } | null =
  {
    leaderboardRankThreshold: 100,
  };
let mockTopUsers: Array<{ id: string }> = [];
let mockSnapshotRows: Array<{ userId: string }> = [];
let mockExistingRows: Array<{ userId: string; revokedAt: Date | null }> = [];
let mockInsertedRows: Array<{ userId: string }> = [];

const mockDbSelect = mock((fields?: unknown) => ({
  from: (table: unknown) => {
    if (table === whitelistConfigTable) {
      return {
        where: () => ({
          limit: () =>
            Promise.resolve(
              mockWhitelistConfigRow ? [mockWhitelistConfigRow] : []
            ),
        }),
      };
    }

    if (table === nftSnapshotTable) {
      return {
        where: () => Promise.resolve(mockSnapshotRows),
      };
    }

    if (table === whitelistTable) {
      return {
        where: () => Promise.resolve(mockExistingRows),
      };
    }

    if (table === usersTable) {
      return {
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(mockTopUsers),
          }),
          limit: () => Promise.resolve([]),
        }),
      };
    }

    return {
      where: () => Promise.resolve([]),
    };
  },
}));

const mockDbInsert = mock(() => ({
  values: () => ({
    onConflictDoNothing: () => ({
      returning: () => Promise.resolve(mockInsertedRows),
    }),
    onConflictDoUpdate: () => ({
      returning: () => Promise.resolve([]),
    }),
  }),
}));

mock.module('@feed/db', () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
  },
  and: (...args: unknown[]) => args,
  asc: (col: unknown) => col,
  desc: (col: unknown) => col,
  eq: (a: unknown, b: unknown) => [a, b],
  gt: (a: unknown, b: unknown) => [a, b],
  inArray: (a: unknown, b: unknown) => [a, b],
  isNull: (a: unknown) => a,
  lt: (a: unknown, b: unknown) => [a, b],
  or: (...args: unknown[]) => args,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
  users: usersTable,
  whitelist: whitelistTable,
  whitelistConfig: whitelistConfigTable,
  nftSnapshot: nftSnapshotTable,
}));

mock.module('@feed/engine', () => ({
  UserAlphaGroupAssignmentService: {
    assignDefaultGroups: mock(() => Promise.resolve()),
  },
}));

mock.module('@feed/shared', () => ({
  logger: {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  },
}));

mock.module('nanoid', () => ({
  nanoid: mock(() => 'mock-id'),
}));

mock.module('../services/points-service', () => ({
  PointsService: {},
}));

mock.module('../services/whitelist-email-service', () => ({
  sendWhitelistWelcomeEmailToUser: mock(() => Promise.resolve()),
  sendWhitelistWelcomeEmailsToUsers: mockSendWhitelistWelcomeEmailsToUsers,
}));

const { autoWhitelistCurrentTopN, normalizeWhitelistLeaderboardThreshold } =
  await import('../services/whitelist-service');

describe('autoWhitelistCurrentTopN', () => {
  beforeEach(() => {
    mockDbSelect.mockClear();
    mockDbInsert.mockClear();
    mockSendWhitelistWelcomeEmailsToUsers.mockClear();

    mockWhitelistConfigRow = { leaderboardRankThreshold: 100 };
    mockTopUsers = [{ id: 'user-1' }, { id: 'user-2' }];
    mockSnapshotRows = [];
    mockExistingRows = [];
    mockInsertedRows = [{ userId: 'user-1' }, { userId: 'user-2' }];
  });

  it('does not send whitelist welcome emails for users inserted by leaderboard cron', async () => {
    const result = await autoWhitelistCurrentTopN();

    expect(result.inserted).toBe(2);
    expect(mockSendWhitelistWelcomeEmailsToUsers).toHaveBeenCalledTimes(0);
  });

  it('does not send whitelist welcome emails when leaderboard is empty', async () => {
    mockTopUsers = [];

    const result = await autoWhitelistCurrentTopN();

    expect(result.totalInTopN).toBe(0);
    expect(result.inserted).toBe(0);
    expect(mockSendWhitelistWelcomeEmailsToUsers).toHaveBeenCalledTimes(0);
  });

  it('caps the effective whitelist threshold at 25,000', async () => {
    mockWhitelistConfigRow = { leaderboardRankThreshold: 99_999 };
    mockTopUsers = [];

    const result = await autoWhitelistCurrentTopN();

    expect(result.topN).toBe(25_000);
  });
});

describe('normalizeWhitelistLeaderboardThreshold', () => {
  it('falls back to the default threshold for invalid values', () => {
    expect(normalizeWhitelistLeaderboardThreshold(null)).toBe(100);
    expect(normalizeWhitelistLeaderboardThreshold(undefined)).toBe(100);
    expect(normalizeWhitelistLeaderboardThreshold(0)).toBe(100);
    expect(normalizeWhitelistLeaderboardThreshold(-5)).toBe(100);
  });

  it('truncates and caps the threshold at 25,000', () => {
    expect(normalizeWhitelistLeaderboardThreshold(25_000.9)).toBe(25_000);
    expect(normalizeWhitelistLeaderboardThreshold(40_000)).toBe(25_000);
  });
});
