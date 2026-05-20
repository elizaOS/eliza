import { beforeEach, describe, expect, it, mock } from "bun:test";

const whitelistTable = {
  id: "id",
  userId: "userId",
  source: "source",
  revokedAt: "revokedAt",
};
const whitelistConfigTable = {
  id: "id",
  leaderboardRankThreshold: "leaderboardRankThreshold",
};
const nftSnapshotTable = { userId: "userId" };
const usersTable = {
  id: "id",
  reputationPoints: "reputationPoints",
  invitePoints: "invitePoints",
  createdAt: "createdAt",
  isActor: "isActor",
  isAgent: "isAgent",
};

let mockWhitelistEntry: {
  source: "leaderboard" | "admin_manual" | "snapshot_first_100";
  revokedAt: Date | null;
} | null = null;
let mockWhitelistConfigRow: { leaderboardRankThreshold: number | null } | null =
  {
    leaderboardRankThreshold: 25_000,
  };
let mockUserRow: {
  id: string;
  reputationPoints: number;
  invitePoints: number;
  createdAt: Date;
  isActor: boolean;
  isAgent: boolean;
} | null = null;
let mockUsersAheadCount = 0;

const mockDbSelect = mock((fields?: unknown) => ({
  from: (table: unknown) => {
    if (table === whitelistTable) {
      return {
        where: () => ({
          limit: () =>
            Promise.resolve(mockWhitelistEntry ? [mockWhitelistEntry] : []),
        }),
      };
    }

    if (table === whitelistConfigTable) {
      return {
        where: () => ({
          limit: () =>
            Promise.resolve(
              mockWhitelistConfigRow ? [mockWhitelistConfigRow] : [],
            ),
        }),
      };
    }

    if (table === usersTable) {
      const isCountQuery =
        typeof fields === "object" &&
        fields !== null &&
        "count" in (fields as Record<string, unknown>);

      if (isCountQuery) {
        return {
          where: () => Promise.resolve([{ count: mockUsersAheadCount }]),
        };
      }

      return {
        where: () => ({
          limit: () => Promise.resolve(mockUserRow ? [mockUserRow] : []),
        }),
      };
    }

    if (table === nftSnapshotTable) {
      return {
        where: () => Promise.resolve([]),
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
      returning: () => Promise.resolve([]),
    }),
    onConflictDoUpdate: () => ({
      returning: () => Promise.resolve([]),
    }),
  }),
}));

mock.module("@feed/db", () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
  },
  and: (...args: unknown[]) => args,
  asc: (col: unknown) => col,
  count: () => "count",
  desc: (col: unknown) => col,
  eq: (a: unknown, b: unknown) => [a, b],
  gt: (a: unknown, b: unknown) => [a, b],
  inArray: (a: unknown, b: unknown) => [a, b],
  isNull: (a: unknown) => a,
  lt: (a: unknown, b: unknown) => [a, b],
  nftSnapshot: nftSnapshotTable,
  or: (...args: unknown[]) => args,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
  users: usersTable,
  whitelist: whitelistTable,
  whitelistConfig: whitelistConfigTable,
}));

mock.module("@feed/engine", () => ({
  UserAlphaGroupAssignmentService: {
    assignDefaultGroups: mock(() => Promise.resolve()),
  },
}));

mock.module("@feed/shared", () => ({
  logger: {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  },
}));

mock.module("nanoid", () => ({
  nanoid: mock(() => "mock-id"),
}));

mock.module("../services/whitelist-email-service", () => ({
  sendWhitelistWelcomeEmailToUser: mock(() => Promise.resolve()),
  sendWhitelistWelcomeEmailsToUsers: mock(() => Promise.resolve()),
}));

const { checkWhitelistAccess, isUserWhitelistedByLeaderboard } = await import(
  "../services/whitelist-service"
);

describe("whitelist access resolution", () => {
  beforeEach(() => {
    mockDbSelect.mockClear();
    mockDbInsert.mockClear();
    mockWhitelistEntry = null;
    mockWhitelistConfigRow = { leaderboardRankThreshold: 25_000 };
    mockUserRow = {
      id: "user-1",
      reputationPoints: 5_000,
      invitePoints: 300,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      isActor: false,
      isAgent: false,
    };
    mockUsersAheadCount = 0;
  });

  it("allows users with an active whitelist entry", async () => {
    mockWhitelistEntry = {
      source: "admin_manual",
      revokedAt: null,
    };

    const result = await checkWhitelistAccess("user-1");

    expect(result).toEqual({
      allowed: true,
      source: "admin_manual",
    });
  });

  it("does not bypass revoked whitelist entries with leaderboard access", async () => {
    mockWhitelistEntry = {
      source: "leaderboard",
      revokedAt: new Date("2026-03-01T00:00:00.000Z"),
    };
    mockUsersAheadCount = 10;

    const result = await checkWhitelistAccess("user-1");

    expect(result).toEqual({
      allowed: false,
      source: null,
    });
  });

  it("allows users inside the leaderboard threshold when no whitelist row exists", async () => {
    mockUsersAheadCount = 12_999;

    const result = await checkWhitelistAccess("user-1");

    expect(result).toEqual({
      allowed: true,
      source: "leaderboard",
    });
  });

  it("rejects users outside the configured leaderboard threshold", async () => {
    mockUsersAheadCount = 25_000;

    const result = await checkWhitelistAccess("user-1");

    expect(result).toEqual({
      allowed: false,
      source: null,
    });
  });

  it("returns false for actors and agents in dynamic leaderboard checks", async () => {
    mockUserRow = {
      id: "user-1",
      reputationPoints: 5_000,
      invitePoints: 300,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      isActor: true,
      isAgent: false,
    };

    await expect(isUserWhitelistedByLeaderboard("user-1")).resolves.toBe(false);

    mockUserRow = {
      id: "user-1",
      reputationPoints: 5_000,
      invitePoints: 300,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      isActor: false,
      isAgent: true,
    };

    await expect(isUserWhitelistedByLeaderboard("user-1")).resolves.toBe(false);
  });

  it("returns false when the user does not exist in the users table", async () => {
    mockUserRow = null;

    await expect(isUserWhitelistedByLeaderboard("nonexistent")).resolves.toBe(
      false,
    );
  });
});
