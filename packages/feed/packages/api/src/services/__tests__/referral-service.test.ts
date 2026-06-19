import { beforeEach, describe, expect, it, mock } from "bun:test";

const mockLoggerInfo = mock();

type SelectResult = Array<Record<string, string | null>>;

let selectResults: SelectResult[] = [];
let selectCallIndex = 0;
let updatePayload: Record<string, unknown> | null = null;

function resetDbState() {
  selectResults = [];
  selectCallIndex = 0;
  updatePayload = null;
}

function createSelectChain() {
  const chain: Record<string, unknown> = {};

  chain.from = mock(() => chain);
  chain.where = mock(() => chain);
  chain.limit = mock(() => chain);
  // biome-ignore lint/suspicious/noThenProperty: The mock intentionally emulates Drizzle's awaitable query chain.
  chain.then = (
    onFulfilled?: ((value: unknown) => unknown) | null,
    onRejected?: ((reason: unknown) => unknown) | null,
  ) => {
    const result = selectResults[selectCallIndex] ?? [];
    selectCallIndex += 1;

    return Promise.resolve(result).then(onFulfilled, onRejected);
  };

  return chain;
}

const mockDb = {
  select: mock(() => createSelectChain()),
  update: mock(() => {
    const chain: Record<string, unknown> = {};

    chain.set = mock((payload: Record<string, unknown>) => {
      updatePayload = payload;
      return chain;
    });
    chain.where = mock(() => Promise.resolve(undefined));

    return chain;
  }),
};

mock.module("@feed/db", () => ({
  and: (...conditions: unknown[]) => conditions,
  db: mockDb,
  dbWrite: mockDb,
  eq: (left: unknown, right: unknown) => ({ left, right }),
  ne: (left: unknown, right: unknown) => ({ left, right }),
  users: {
    id: "users.id",
    username: "users.username",
    referralCode: "users.referralCode",
  },
}));

mock.module("@feed/shared", () => ({
  logger: {
    info: mockLoggerInfo,
  },
}));

const { getOrCreateReferralCode, isReferralCodeAvailableForUser } =
  await import("../referral-service");

describe("referral-service", () => {
  beforeEach(() => {
    resetDbState();
    mockLoggerInfo.mockReset();
  });

  it("reports referral codes as unavailable when another user already owns them", async () => {
    selectResults = [[{ id: "user_2" }]];

    await expect(
      isReferralCodeAvailableForUser("user_1", "alice"),
    ).resolves.toBe(false);
  });

  it("syncs the referral code to the username when available", async () => {
    selectResults = [
      [{ id: "user_1", username: "alice", referralCode: null }],
      [],
    ];

    await expect(getOrCreateReferralCode("user_1")).resolves.toBe("alice");
    expect(updatePayload).toEqual({ referralCode: "alice" });
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
  });

  it("rejects users without usernames before generating a referral code", async () => {
    selectResults = [[{ id: "user_1", username: null, referralCode: null }]];

    await expect(getOrCreateReferralCode("user_1")).rejects.toThrow(
      "does not have a username",
    );
    expect(updatePayload).toBeNull();
  });
});
