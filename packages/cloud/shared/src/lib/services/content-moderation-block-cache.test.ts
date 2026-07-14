/**
 * Unit tests for the Tier-3 in-isolate block-decision memo on
 * `contentModerationService.shouldBlockUser` (#9899), gated behind
 * INFERENCE_HOT_PATH_CACHES. The admin service (the per-request Postgres read
 * being removed from the warm path) is mocked at the module boundary so the
 * tests can count authoritative reads.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as adminActual from "./admin";

let dbReads = 0;
let blockedUsers: Set<string>;
let readShouldThrow = false;

mock.module("./admin", () => ({
  ...adminActual,
  adminService: {
    ...adminActual.adminService,
    shouldBlockUser: async (userId: string) => {
      dbReads++;
      if (readShouldThrow) throw new Error("db unreachable");
      return blockedUsers.has(userId);
    },
    unbanUser: async (userId: string) => {
      blockedUsers.delete(userId);
    },
  },
}));

const { contentModerationService, __clearShouldBlockUserCache } = await import(
  "./content-moderation"
);

const originalHotPathCaches = process.env.INFERENCE_HOT_PATH_CACHES;

afterAll(() => {
  mock.module("./admin", () => adminActual);
  if (originalHotPathCaches === undefined) delete process.env.INFERENCE_HOT_PATH_CACHES;
  else process.env.INFERENCE_HOT_PATH_CACHES = originalHotPathCaches;
});

let n = 0;
const uid = () => `user-${++n}`;

describe("shouldBlockUser memo (#9899 Tier-3)", () => {
  beforeEach(() => {
    process.env.INFERENCE_HOT_PATH_CACHES = "true";
    __clearShouldBlockUserCache();
    dbReads = 0;
    blockedUsers = new Set();
    readShouldThrow = false;
  });

  test("INFERENCE_HOT_PATH_CACHES off = no memo: every check reads authoritatively (today's behavior)", async () => {
    process.env.INFERENCE_HOT_PATH_CACHES = "false";
    const user = uid();
    expect(await contentModerationService.shouldBlockUser(user)).toBe(false);
    blockedUsers.add(user);
    // A ban is visible IMMEDIATELY with the flag off — nothing was memoized.
    expect(await contentModerationService.shouldBlockUser(user)).toBe(true);
    expect(dbReads).toBe(2);
  });

  test("memoizes both allowed and blocked decisions per user", async () => {
    const ok = uid();
    const banned = uid();
    blockedUsers.add(banned);

    expect(await contentModerationService.shouldBlockUser(ok)).toBe(false);
    expect(await contentModerationService.shouldBlockUser(banned)).toBe(true);
    expect(dbReads).toBe(2);

    // Warm repeats never touch the DB — including the memoized `false`.
    expect(await contentModerationService.shouldBlockUser(ok)).toBe(false);
    expect(await contentModerationService.shouldBlockUser(banned)).toBe(true);
    expect(dbReads).toBe(2);
  });

  test("a thrown DB read is NOT cached: it propagates and the next call retries", async () => {
    const user = uid();
    readShouldThrow = true;
    await expect(contentModerationService.shouldBlockUser(user)).rejects.toThrow("db unreachable");
    readShouldThrow = false;
    blockedUsers.add(user);
    expect(await contentModerationService.shouldBlockUser(user)).toBe(true);
    expect(dbReads).toBe(2);
  });

  test("resetViolations drops the memoized decision", async () => {
    const user = uid();
    blockedUsers.add(user);
    expect(await contentModerationService.shouldBlockUser(user)).toBe(true);

    await contentModerationService.resetViolations(user);

    expect(await contentModerationService.shouldBlockUser(user)).toBe(false);
    expect(dbReads).toBe(2);
  });
});
