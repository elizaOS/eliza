/**
 * Unit Tests: Whitelist → Default Alpha Group Assignment
 *
 * Verifies that when a user is added to the whitelist via addToWhitelist(),
 * UserAlphaGroupAssignmentService.assignDefaultGroups() is called for new
 * entries but NOT for already-existing entries.
 *
 * Run with: bun test packages/api/src/__tests__/whitelist-group-assignment.test.ts
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Mocks — must be set up BEFORE importing the module under test
// ---------------------------------------------------------------------------

const mockAssignDefaultGroups = mock(() =>
  Promise.resolve({
    success: true,
    groupsAssigned: 3,
    assignments: [
      {
        npcId: 'npc-1',
        npcName: 'NPC Alpha',
        tier: 3 as const,
        groupId: 'g1',
        chatId: 'c1',
      },
      {
        npcId: 'npc-2',
        npcName: 'NPC Beta',
        tier: 3 as const,
        groupId: 'g2',
        chatId: 'c2',
      },
      {
        npcId: 'npc-3',
        npcName: 'NPC Gamma',
        tier: 3 as const,
        groupId: 'g3',
        chatId: 'c3',
      },
    ],
    errors: [],
  })
);

const mockLoggerInfo = mock();
const mockLoggerError = mock();
// Track what the DB insert returns — controls whether addToWhitelist thinks
// the entry is new or already exists.
const mockInsertReturnId = 'new-id';

// We need a unique ID that nanoid will generate so we can compare
let capturedNanoid = '';
const mockNanoid = mock(() => {
  capturedNanoid = `mock-nanoid-${Date.now()}`;
  return capturedNanoid;
});

// Mock DB — simplified chain that supports .insert().values().onConflictDoUpdate().returning()
const mockReturning = mock(() => Promise.resolve([{ id: mockInsertReturnId }]));
const mockOnConflictDoUpdate = mock(() => ({ returning: mockReturning }));
const mockValues = mock(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
const mockInsert = mock(() => ({ values: mockValues }));
const mockDb = { insert: mockInsert };

// Mock modules BEFORE importing the service
mock.module('@babylon/db', () => ({
  db: mockDb,
  // Drizzle operators
  aliasedTable: (table: unknown) => table,
  and: (...args: unknown[]) => args,
  asc: (col: unknown) => col,
  avg: (col: unknown) => col,
  between: (col: unknown, a: unknown, b: unknown) => ({ col, a, b }),
  count: (col?: unknown) => col,
  desc: (col: unknown) => col,
  eq: (a: unknown, b: unknown) => [a, b],
  exists: (q: unknown) => q,
  gt: (a: unknown, b: unknown) => ({ op: 'gt', a, b }),
  gte: (a: unknown, b: unknown) => ({ op: 'gte', a, b }),
  ilike: (a: unknown, b: unknown) => ({ op: 'ilike', a, b }),
  inArray: (a: unknown, b: unknown) => [a, b],
  isNotNull: (a: unknown) => a,
  isNull: (a: unknown) => a,
  like: (a: unknown, b: unknown) => ({ op: 'like', a, b }),
  lt: (a: unknown, b: unknown) => ({ op: 'lt', a, b }),
  lte: (a: unknown, b: unknown) => ({ op: 'lte', a, b }),
  max: (col: unknown) => col,
  min: (col: unknown) => col,
  ne: (a: unknown, b: unknown) => ({ op: 'ne', a, b }),
  not: (a: unknown) => a,
  notExists: (q: unknown) => q,
  notInArray: (a: unknown, b: unknown) => [a, b],
  or: (...args: unknown[]) => args,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
  sum: (col: unknown) => col,
  // RLS helpers
  asPublic: () => ({}),
  asSystem: () => ({}),
  asUser: () => ({}),
  // Schema tables
  adminAuditLogs: {},
  balanceTransactions: {},
  follows: {},
  generationLocks: {},
  nftOwnership: {},
  positions: {},
  referrals: {},
  users: { id: 'id' },
  userApiKeys: {},
  // Other re-exports
  queryMonitor: {},
  ROLE_PERMISSIONS: {},
  generateSnowflakeId: () => 'id',
  isValidSnowflakeId: () => true,
  whitelist: {
    id: 'id',
    userId: 'userId',
    source: 'source',
    reason: 'reason',
    grantedBy: 'grantedBy',
    grantedAt: 'grantedAt',
    revokedAt: 'revokedAt',
  },
  whitelistConfig: {},
  nftSnapshot: { userId: 'userId' },
}));

mock.module('@babylon/engine', () => ({
  UserAlphaGroupAssignmentService: {
    assignDefaultGroups: mockAssignDefaultGroups,
  },
}));

mock.module('@babylon/shared', () => ({
  logger: {
    info: mockLoggerInfo,
    warn: mock(),
    error: mockLoggerError,
    debug: mock(),
  },
}));

mock.module('nanoid', () => ({
  nanoid: mockNanoid,
}));

// Also mock PointsService since whitelist-service imports it
mock.module('../services/points-service', () => ({
  PointsService: {},
}));

mock.module('../services/whitelist-email-service', () => ({
  sendWhitelistWelcomeEmailToUser: mock(() => Promise.resolve()),
  sendWhitelistWelcomeEmailsToUsers: mock(() => Promise.resolve()),
}));

// NOW import the function under test
const { addToWhitelist } = await import('../services/whitelist-service');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('addToWhitelist → group assignment', () => {
  beforeEach(() => {
    mockAssignDefaultGroups.mockClear();
    mockLoggerInfo.mockClear();
    mockLoggerError.mockClear();
    mockInsert.mockClear();
    mockReturning.mockClear();
  });

  it('should call assignDefaultGroups for a NEW whitelist entry', async () => {
    // When the returned id matches nanoid's output, the entry is new
    mockReturning.mockImplementation(() => {
      // Return the same id that nanoid generated → new entry
      return Promise.resolve([{ id: capturedNanoid }]);
    });

    const result = await addToWhitelist({
      userId: 'user-123',
      source: 'admin_manual',
      reason: 'Testing',
      grantedBy: 'admin-1',
    });

    expect(result.alreadyExists).toBe(false);

    // assignDefaultGroups is fire-and-forget, so we need to flush microtasks
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockAssignDefaultGroups).toHaveBeenCalledTimes(1);
    expect(mockAssignDefaultGroups).toHaveBeenCalledWith('user-123');
  });

  it('should NOT call assignDefaultGroups for an ALREADY EXISTING entry', async () => {
    // When the returned id differs from nanoid's output, the entry already exists
    mockReturning.mockImplementation(() => {
      return Promise.resolve([{ id: 'some-other-existing-id' }]);
    });

    const result = await addToWhitelist({
      userId: 'user-456',
      source: 'admin_manual',
    });

    expect(result.alreadyExists).toBe(true);

    // Wait for any potential async calls
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockAssignDefaultGroups).toHaveBeenCalledTimes(0);
  });

  it('should log success when groups are assigned', async () => {
    mockReturning.mockImplementation(() => {
      return Promise.resolve([{ id: capturedNanoid }]);
    });

    mockAssignDefaultGroups.mockImplementation(() =>
      Promise.resolve({
        success: true,
        groupsAssigned: 3,
        assignments: [],
        errors: [],
      })
    );

    await addToWhitelist({
      userId: 'user-789',
      source: 'leaderboard',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockAssignDefaultGroups).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalled();

    // Find the specific log call about group assignment
    const groupAssignmentLog = mockLoggerInfo.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === 'string' &&
        call[0].includes('Assigned default alpha groups to whitelisted user')
    );
    expect(groupAssignmentLog).toBeDefined();
  });

  it('should log error if assignDefaultGroups throws', async () => {
    mockReturning.mockImplementation(() => {
      return Promise.resolve([{ id: capturedNanoid }]);
    });

    mockAssignDefaultGroups.mockImplementation(() =>
      Promise.reject(new Error('DB connection failed'))
    );

    // Should NOT throw — error is caught internally
    const result = await addToWhitelist({
      userId: 'user-error',
      source: 'admin_manual',
    });

    expect(result.alreadyExists).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockLoggerError).toHaveBeenCalled();
    const errorLog = mockLoggerError.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === 'string' &&
        call[0].includes('Failed to assign default alpha groups')
    );
    expect(errorLog).toBeDefined();
  });

  it('should not block the whitelist response if side-effects are slow', async () => {
    mockReturning.mockImplementation(() => {
      return Promise.resolve([{ id: capturedNanoid }]);
    });

    // Simulate slow side-effects (500ms each)
    mockAssignDefaultGroups.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                success: true,
                groupsAssigned: 3,
                assignments: [],
                errors: [],
              }),
            500
          )
        )
    );

    const startTime = Date.now();
    const result = await addToWhitelist({
      userId: 'user-slow',
      source: 'admin_manual',
    });
    const elapsed = Date.now() - startTime;

    // addToWhitelist should return immediately (fire-and-forget for both)
    expect(result.alreadyExists).toBe(false);
    expect(elapsed).toBeLessThan(200);
  });
});
