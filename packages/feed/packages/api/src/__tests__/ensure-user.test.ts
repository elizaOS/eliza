import { beforeEach, describe, expect, it, mock } from "bun:test";

const mockFindUserByIdentifier = mock(() => Promise.resolve(null));
const mockInvalidateUserIdentifierCaches = mock(() => Promise.resolve());
const mockResolveUserIdentifierKind = mock(() => "privyId");

const selectResponses: unknown[][] = [];
const insertReturningResponses: unknown[][] = [];

const mockSelect = mock(() => {
  const chain = {
    from: (_table?: unknown) => chain,
    where: (_condition?: unknown) => chain,
    limit: () => Promise.resolve(selectResponses.shift() ?? []),
  };
  return chain;
});

const mockInsertReturning = mock(() =>
  Promise.resolve(insertReturningResponses.shift() ?? []),
);
const mockOnConflictDoNothing = mock(() => ({
  returning: mockInsertReturning,
}));
const mockInsertValues = mock(() => ({
  onConflictDoNothing: mockOnConflictDoNothing,
}));
const mockInsert = mock(() => ({
  values: mockInsertValues,
}));

const mockUpdateReturning = mock(() => Promise.resolve([]));
const mockUpdateWhere = mock(() => ({ returning: mockUpdateReturning }));
const mockUpdateSet = mock(() => ({ where: mockUpdateWhere }));
const mockUpdate = mock(() => ({ set: mockUpdateSet }));

mock.module("@feed/db", () => ({
  db: {
    insert: mockInsert,
    select: mockSelect,
    update: mockUpdate,
  },
  eq: (left: unknown, right: unknown) => ({ left, right }),
  users: {
    id: "id",
    privyId: "privyId",
    username: "username",
    displayName: "displayName",
    walletAddress: "walletAddress",
    isActor: "isActor",
    profileImageUrl: "profileImageUrl",
  },
}));

mock.module("@feed/shared", () => ({
  resolveUserIdentifierKind: mockResolveUserIdentifierKind,
}));

mock.module("drizzle-orm", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
}));

mock.module("../cache/cached-database-service", () => ({
  cachedDb: {
    invalidateUserIdentifierCaches: mockInvalidateUserIdentifierCaches,
  },
}));

mock.module("../users/user-lookup", () => ({
  findUserByIdentifier: mockFindUserByIdentifier,
}));

const { ensureMinimalUserByIdentifier, ensureUserForAuth } = await import(
  "../users/ensure-user"
);

describe("ensure-user", () => {
  beforeEach(() => {
    mockFindUserByIdentifier.mockClear();
    mockInvalidateUserIdentifierCaches.mockClear();
    mockResolveUserIdentifierKind.mockClear();
    mockSelect.mockClear();
    mockInsert.mockClear();
    mockInsertValues.mockClear();
    mockOnConflictDoNothing.mockClear();
    mockInsertReturning.mockClear();
    mockUpdate.mockClear();
    selectResponses.length = 0;
    insertReturningResponses.length = 0;
    mockFindUserByIdentifier.mockImplementation(() => Promise.resolve(null));
    mockResolveUserIdentifierKind.mockImplementation(() => "privyId");
  });

  it("returns the concurrently created minimal user after an insert conflict", async () => {
    const identifier = "steward:test:test-public-bootstrap";
    insertReturningResponses.push([]);
    selectResponses.push([{ id: identifier }]);

    const user = await ensureMinimalUserByIdentifier(identifier);

    expect(user).toEqual({ id: identifier });
    expect(mockFindUserByIdentifier).toHaveBeenCalledWith(identifier, {
      id: true,
    });
    expect(mockInvalidateUserIdentifierCaches).not.toHaveBeenCalled();
  });

  it("reloads the minimal user by primary key after a username insert conflict", async () => {
    const identifier = "testuser";
    mockResolveUserIdentifierKind.mockImplementation(() => "username");
    insertReturningResponses.push([]);
    selectResponses.push([]);
    selectResponses.push([{ id: identifier }]);

    const user = await ensureMinimalUserByIdentifier(identifier);

    expect(user).toEqual({ id: identifier });
    expect(mockInvalidateUserIdentifierCaches).not.toHaveBeenCalled();
  });

  it("invalidates identifier caches when minimal bootstrap wins the insert", async () => {
    const identifier = "steward:test:test-public-created";
    insertReturningResponses.push([{ id: identifier }]);

    const user = await ensureMinimalUserByIdentifier(identifier);

    expect(user).toEqual({ id: identifier });
    expect(mockInvalidateUserIdentifierCaches).toHaveBeenCalledWith({
      id: identifier,
      privyId: identifier,
      username: null,
    });
  });

  it("reloads the authenticated user after a concurrent insert conflict", async () => {
    const identifier = "steward:test:test-auth-bootstrap";
    insertReturningResponses.push([]);
    selectResponses.push([]);
    selectResponses.push([
      {
        id: identifier,
        privyId: identifier,
        username: null,
        displayName: null,
        walletAddress: null,
        isActor: false,
        profileImageUrl: null,
      },
    ]);

    const authUser = {
      userId: identifier,
      privyId: identifier,
      isAgent: false,
    };

    const result = await ensureUserForAuth(authUser);

    expect(result.user.id).toBe(identifier);
    expect(authUser.dbUserId).toBe(identifier);
    expect(mockInvalidateUserIdentifierCaches).not.toHaveBeenCalled();
  });
});
