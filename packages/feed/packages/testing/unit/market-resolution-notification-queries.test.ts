import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as actualApi from "@feed/api";
import * as actualShared from "@feed/shared";

const positionsTable = {
  marketId: "positions.marketId",
  status: "positions.status",
  outcome: "positions.outcome",
  pnl: "positions.pnl",
  resolvedAt: "positions.resolvedAt",
  shares: "positions.shares",
  userId: "positions.userId",
};

const usersTable = {
  id: "users.id",
  managedBy: "users.managedBy",
  isAgent: "users.isAgent",
  displayName: "users.displayName",
};

const marketsTable = {
  id: "markets.id",
  question: "markets.question",
};

type Condition =
  | {
      op: "and" | "or";
      conditions: Condition[];
    }
  | {
      op: "eq" | "gt" | "gte" | "lt";
      left: unknown;
      right: unknown;
    }
  | {
      op: "isNotNull";
      value: unknown;
    };

let capturedWhere: Condition | null = null;

const mockWhere = mock(async (condition: Condition) => {
  capturedWhere = condition;
  return [];
});

const mockCreateNotification = mock(async () => ({ created: true }));
const mockBroadcastToChannel = mock(async () => undefined);
const mockSendNotificationEmail = mock(async () => undefined);

mock.module("@feed/api", () => ({
  ...actualApi,
  broadcastToChannel: mockBroadcastToChannel,
  createNotification: mockCreateNotification,
  sendNotificationEmail: mockSendNotificationEmail,
}));

mock.module("@feed/shared", () => ({
  ...actualShared,
  logger: {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  },
}));

mock.module("@feed/db", () => ({
  and: (...conditions: Condition[]) => ({ op: "and", conditions }),
  db: {
    select: mock(() => ({
      from: mock(() => ({
        innerJoin: mock(() => ({
          leftJoin: mock(() => ({
            where: mockWhere,
          })),
        })),
      })),
    })),
  },
  eq: (left: unknown, right: unknown) => ({ op: "eq", left, right }),
  gt: (left: unknown, right: unknown) => ({ op: "gt", left, right }),
  gte: (left: unknown, right: unknown) => ({ op: "gte", left, right }),
  isNotNull: (value: unknown) => ({ op: "isNotNull", value }),
  lt: (left: unknown, right: unknown) => ({ op: "lt", left, right }),
  markets: marketsTable,
  or: (...conditions: Condition[]) => ({ op: "or", conditions }),
  positions: positionsTable,
  users: usersTable,
}));

const { notifyResolvedMarketOwners } = await import(
  "../../../apps/web/src/lib/services/market-resolution-notifications"
);
const { buildDigestForUser } = await import(
  "../../../apps/web/src/lib/services/notification-digest-service"
);

function expectSharesFilter(condition: Condition | null) {
  expect(condition).not.toBeNull();
  expect(condition).toMatchObject({ op: "and" });
  // Extract<Condition, { op: 'and' }> is `never` because `and` shares a union arm with `or` (`op: 'and' | 'or'`).
  const conditions = (condition as { op: "and"; conditions: Condition[] })
    .conditions;
  expect(conditions).toContainEqual({
    op: "gt",
    left: "positions.shares",
    right: "0",
  });
}

describe("market resolution notification queries", () => {
  beforeEach(() => {
    capturedWhere = null;
    mockWhere.mockClear();
    mockCreateNotification.mockClear();
    mockBroadcastToChannel.mockClear();
    mockSendNotificationEmail.mockClear();
  });

  test("notifyResolvedMarketOwners excludes zero-share positions", async () => {
    const createdCount = await notifyResolvedMarketOwners("market-1");

    expect(createdCount).toBe(0);
    expectSharesFilter(capturedWhere);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  test("buildDigestForUser excludes zero-share positions", async () => {
    const digest = await buildDigestForUser({
      userId: "user-1",
      frequency: "daily",
      now: new Date("2026-03-20T15:00:00.000Z"),
    });

    expect(digest).toBeNull();
    expectSharesFilter(capturedWhere);
    expect(mockSendNotificationEmail).not.toHaveBeenCalled();
  });
});
