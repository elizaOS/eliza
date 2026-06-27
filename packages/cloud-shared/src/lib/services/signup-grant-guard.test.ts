import { beforeEach, describe, expect, mock, test } from "bun:test";

// Each call to dbRead.execute returns the next queued count row.
let nextCount = 0;
const execute = mock(async () => ({ rows: [{ count: String(nextCount) }] }));

mock.module("../../db/client", () => ({
  dbRead: { execute },
}));

mock.module("../utils/logger", () => ({
  logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
}));

const { signupGrantAllowedForIp, FREE_GRANT_IP_LIMITS } = await import("./signup-grant-guard");

const CAP = FREE_GRANT_IP_LIMITS.MAX_FREE_GRANTS_PER_IP_DAILY;

describe("signupGrantAllowedForIp (anti-sybil free-grant cap)", () => {
  beforeEach(() => {
    execute.mockClear();
    nextCount = 0;
  });

  test("falls open without querying when no IP is known", async () => {
    expect(await signupGrantAllowedForIp(undefined)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  test("allows grants below the daily cap", async () => {
    nextCount = CAP - 1;
    expect(await signupGrantAllowedForIp("1.2.3.4")).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("withholds the grant once the daily cap is reached", async () => {
    nextCount = CAP;
    expect(await signupGrantAllowedForIp("1.2.3.4")).toBe(false);
  });

  test("withholds the grant when the cap is exceeded", async () => {
    nextCount = CAP + 5;
    expect(await signupGrantAllowedForIp("1.2.3.4")).toBe(false);
  });
});
