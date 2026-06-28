/**
 * #9899 regression: auto-suspension via the moderation pipeline must drop the
 * user's inference auth-context (IAC) at the moment they cross into a blocking
 * state — otherwise a just-suspended user keeps fast-pathing /v1/chat/completions
 * for up to the IAC TTL. The invalidation is wired into the authoritative
 * mutation (`updateUserModerationStatus`), so it fires regardless of which
 * surface recorded the violation (chat, messages, A2A).
 *
 * Mocks the DB + api-key repo + IAC cache so the transition logic is exercised
 * without a live database.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

interface ModStatusRow {
  status: string;
  totalViolations: number;
  warningCount: number;
  riskScore: number;
  lastWarningAt: Date | null;
}
let existingStatus: ModStatusRow | undefined;

mock.module("../../db/client", () => ({
  dbRead: {
    query: { userModerationStatus: { findFirst: async () => existingStatus } },
  },
  dbWrite: {
    insert: () => ({ values: () => ({ returning: async () => [{ id: "violation-1" }] }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

mock.module("../../db/repositories", () => ({
  apiKeysRepository: {
    listByUser: async () => [{ key_hash: "hash-1" }, { key_hash: "hash-2" }],
  },
}));

const invalidateSpy = mock(async (_hashes: readonly string[]) => undefined);
mock.module("./inference-auth-cache", () => ({
  invalidateInferenceAuthContextsByKeyHashes: invalidateSpy,
}));

const { adminService } = await import("./admin");

async function recordRefusal(userId = "user-1") {
  await adminService.recordViolation({
    userId,
    messageText: "policy-violating text",
    categories: ["spam"],
    scores: {},
    action: "refused",
  });
}

beforeEach(() => {
  invalidateSpy.mockClear();
});

describe("moderation auto-suspension invalidates IAC", () => {
  test("crossing into a blocking state (4 -> 5 violations) drops the user's IAC", async () => {
    existingStatus = {
      status: "clean",
      totalViolations: 4,
      warningCount: 0,
      riskScore: 80,
      lastWarningAt: null,
    };
    await recordRefusal();
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith(["hash-1", "hash-2"]);
  });

  test("an already-blocking user does not re-invalidate (transition-only)", async () => {
    existingStatus = {
      status: "clean",
      totalViolations: 5,
      warningCount: 0,
      riskScore: 100,
      lastWarningAt: null,
    };
    await recordRefusal();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("a violation below the blocking threshold does not invalidate", async () => {
    existingStatus = {
      status: "clean",
      totalViolations: 1,
      warningCount: 0,
      riskScore: 20,
      lastWarningAt: null,
    };
    await recordRefusal();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("a brand-new violator (no prior row) does not invalidate", async () => {
    existingStatus = undefined;
    await recordRefusal();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
