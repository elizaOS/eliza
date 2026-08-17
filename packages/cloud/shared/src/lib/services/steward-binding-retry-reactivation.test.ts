/**
 * Regression coverage for #20913: an interrupted strong-revocation retry must
 * reactivate the current durable session binding rather than fence the user
 * forever. Exercises the real UsersService methods with deterministic
 * repository/cache/revocation mocks (no Redis, DB, or Steward services).
 *
 * The upsert path can commit a Steward identity row and then fail before it
 * reopens the session-binding fence. On retry the identity already equals the
 * target, so the idempotent early-return branch runs; this suite asserts that
 * branch now re-activates the binding (previously it only evicted caches) and
 * that the direct-update repair path stays green.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const bindingActivations: Array<{
  orgId: string;
  userId: string;
  stewardUserId: string;
  active: boolean;
}> = [];
const cacheDeletes: string[] = [];
const sessionInvalidations: string[][] = [];

let userRecord: Record<string, unknown> | undefined;
let identityRecord: { user_id: string; steward_user_id: string } | undefined;
let bindingActivationError: Error | null = null;

mock.module("./inference-auth-cache", () => ({
  invalidateInferenceAuthContextsByKeyHashes: async () => {},
  invalidateInferenceSessionAuthContexts: async (ids: readonly string[]) => {
    sessionInvalidations.push([...ids]);
  },
}));

mock.module("./inference-credential-revocation", () => ({
  setInferenceSessionBindingActive: async (
    orgId: string,
    userId: string,
    stewardUserId: string,
    active: boolean,
  ) => {
    if (active && bindingActivationError) {
      throw bindingActivationError;
    }
    bindingActivations.push({ orgId, userId, stewardUserId, active });
  },
  revokeInferenceSessionsThrough: async () => {},
  setInferenceSubjectActive: async () => {},
}));

mock.module("../../db/repositories", () => ({
  apiKeysRepository: { listByUser: async () => [] },
  organizationsRepository: {},
  usersRepository: {
    findById: async (_id: string) => userRecord,
    findIdentityByUserIdForWrite: async () => identityRecord,
    upsertStewardIdentity: async (id: string, stewardUserId: string) => ({
      user_id: id,
      steward_user_id: stewardUserId,
    }),
    update: async (id: string, data: Record<string, unknown>) => ({
      ...userRecord,
      ...data,
      id,
    }),
  },
}));

mock.module("../cache/client", () => ({
  cache: {
    get: async () => null,
    set: async () => {},
    del: async (key: string) => {
      cacheDeletes.push(key);
    },
  },
}));

mock.module("../utils/logger", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));

beforeEach(() => {
  bindingActivations.length = 0;
  cacheDeletes.length = 0;
  sessionInvalidations.length = 0;
  userRecord = undefined;
  identityRecord = undefined;
  bindingActivationError = null;
});

describe("UsersService.upsertStewardIdentity — idempotent retry reactivation (#20913)", () => {
  test("reactivates the current durable binding when the identity already matches", async () => {
    userRecord = { id: "u1", organization_id: "o1", steward_user_id: "steward-current" };
    identityRecord = { user_id: "u1", steward_user_id: "steward-current" };

    const { usersService } = await import("./users");
    await usersService.upsertStewardIdentity("u1", "steward-current");

    // The interrupted-retry fence repair: binding must be set active again.
    expect(bindingActivations).toEqual([
      { orgId: "o1", userId: "u1", stewardUserId: "steward-current", active: true },
    ]);
    // Existing cache-eviction behavior must be preserved.
    expect(cacheDeletes).toContain("user:steward:steward-current:v1");
    expect(cacheDeletes).toContain("user:steward-with-org:steward-current:v1");
  });

  test("skips reactivation when the matched identity has no organization", async () => {
    userRecord = { id: "u1", organization_id: null, steward_user_id: "steward-current" };
    identityRecord = { user_id: "u1", steward_user_id: "steward-current" };

    const { usersService } = await import("./users");
    await usersService.upsertStewardIdentity("u1", "steward-current");

    expect(bindingActivations).toEqual([]);
    expect(cacheDeletes).toContain("user:steward:steward-current:v1");
  });

  test("surfaces a reactivation failure instead of silently swallowing it", async () => {
    userRecord = { id: "u1", organization_id: "o1", steward_user_id: "steward-current" };
    identityRecord = { user_id: "u1", steward_user_id: "steward-current" };
    bindingActivationError = new Error("fence store unavailable");

    const { usersService } = await import("./users");
    await expect(usersService.upsertStewardIdentity("u1", "steward-current")).rejects.toThrow(
      "fence store unavailable",
    );
  });

  test("still relinks and reactivates when the identity actually changes", async () => {
    userRecord = { id: "u1", organization_id: "o1", steward_user_id: "steward-old" };
    identityRecord = { user_id: "u1", steward_user_id: "steward-old" };

    const { usersService } = await import("./users");
    await usersService.upsertStewardIdentity("u1", "steward-new");

    // Non-idempotent path: fence old (false) then reopen new (true), unchanged.
    expect(bindingActivations).toEqual([
      { orgId: "o1", userId: "u1", stewardUserId: "steward-old", active: false },
      { orgId: "o1", userId: "u1", stewardUserId: "steward-new", active: true },
    ]);
  });
});

describe("UsersService.update — direct Steward identity repair stays green (#20913)", () => {
  test("reasserts the active binding after committing the same steward id", async () => {
    userRecord = { id: "u1", organization_id: "o1", steward_user_id: "steward-current" };

    const { usersService } = await import("./users");
    await usersService.update("u1", { steward_user_id: "steward-current" });

    expect(bindingActivations).toEqual([
      { orgId: "o1", userId: "u1", stewardUserId: "steward-current", active: true },
    ]);
  });
});
