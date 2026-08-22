/**
 * Verifies anonymous quota refusal metadata through the mocked service boundary.
 * The deterministic harness proves hourly retry advice survives both legacy
 * checks and atomic reservation refunds without dispatching downstream work.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.ANON_HOURLY_LIMIT ||= "10";

const getByToken = mock(async (): Promise<Record<string, unknown> | null> => null);
const reserveMessageSlot = mock(async (): Promise<Record<string, unknown> | null> => null);
const checkRateLimit = mock(
  async (): Promise<Record<string, unknown>> => ({
    allowed: true,
    remaining: 9,
  }),
);
const refundMessageSlot = mock(async (): Promise<unknown> => null);

mock.module("./services/anonymous-sessions", () => ({
  anonymousSessionsService: {
    getByToken,
    reserveMessageSlot,
    checkRateLimit,
    refundMessageSlot,
  },
}));
mock.module("../db/helpers", () => ({ dbRead: {} }));
mock.module("../db/schemas/user-identities", () => ({ userIdentities: {} }));
mock.module("./services/users", () => ({ usersService: {} }));
mock.module("./utils/logger", () => ({
  logger: { debug: mock(), error: mock(), info: mock(), warn: mock() },
}));

const { checkAnonymousLimit, reserveAnonymousMessageSlot } = await import("./auth-anonymous");

beforeEach(() => {
  getByToken.mockReset();
  reserveMessageSlot.mockReset();
  checkRateLimit.mockReset();
  refundMessageSlot.mockReset();
  getByToken.mockResolvedValue({
    id: "anonymous-session",
    message_count: 2,
    messages_limit: 10,
  });
});

describe("reserveAnonymousMessageSlot Retry-After propagation", () => {
  test("preserves authoritative hourly retry advice on the legacy check path", async () => {
    checkRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfter: 29,
    });

    await expect(checkAnonymousLimit("anonymous-token")).resolves.toEqual({
      allowed: false,
      reason: "hourly_limit",
      remaining: 0,
      limit: 10,
      retryAfter: 29,
    });
    expect(checkRateLimit).toHaveBeenCalledWith("anonymous-session");
    expect(reserveMessageSlot).not.toHaveBeenCalled();
    expect(refundMessageSlot).not.toHaveBeenCalled();
  });

  test("preserves authoritative hourly retry advice after refunding the slot", async () => {
    reserveMessageSlot.mockResolvedValue({
      id: "anonymous-session",
      message_count: 3,
      messages_limit: 10,
    });
    checkRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfter: 37,
    });
    refundMessageSlot.mockResolvedValue({ id: "anonymous-session" });

    await expect(reserveAnonymousMessageSlot("anonymous-token")).resolves.toEqual({
      allowed: false,
      reason: "hourly_limit",
      remaining: 0,
      limit: 10,
      retryAfter: 37,
    });
    expect(checkRateLimit).toHaveBeenCalledWith("anonymous-session");
    expect(refundMessageSlot).toHaveBeenCalledWith("anonymous-session");
  });

  test("does not invent retry advice for a lifetime message refusal", async () => {
    reserveMessageSlot.mockResolvedValue(null);

    const result = await reserveAnonymousMessageSlot("anonymous-token");

    expect(result).toEqual({
      allowed: false,
      reason: "message_limit",
      remaining: 0,
      limit: 10,
    });
    expect(result).not.toHaveProperty("retryAfter");
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(refundMessageSlot).not.toHaveBeenCalled();
  });
});
