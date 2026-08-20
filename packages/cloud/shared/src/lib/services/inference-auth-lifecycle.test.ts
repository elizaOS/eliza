/**
 * IAC (inference-auth-context) invalidation on user/org lifecycle transitions.
 *
 * Complements the ban/suspend wiring already in admin.ts (#9981). Covers the
 * four gaps that route inactive credentials back through the authoritative slow
 * path immediately instead of letting a warm IAC entry fast-path for up to the
 * authContext TTL:
 *   1. UsersService.update         → is_active flips false (user deactivate)
 *   2. UsersService.delete         → hard delete (resolve key hashes BEFORE delete)
 *   3. OrganizationsService.update → is_active flips false (org deactivate)
 *   4. OrganizationsService.delete → resolve key hashes BEFORE the delete cascade
 *
 * KV invalidation remains best-effort; the strong revocation fence is a
 * separate fail-closed prerequisite when its rollout flag is enabled.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Captured side effects + per-test repository state ───────────────────────
const invalidatedHashBatches: string[][] = [];
const invalidatedSessionBatches: string[][] = [];
const userDeleteCalls: string[] = [];
const orgDeleteCalls: string[] = [];
const lifecycleEvents: string[] = [];

let userApiKeys: Array<{ key_hash: string }> = [];
let orgApiKeys: Array<{ key_hash: string }> = [];
let userRecord: Record<string, unknown> | undefined;
let readUserRecordOverride: Record<string, unknown> | undefined;
let useReadUserRecordOverride = false;
let failNextBindingActivation = false;
let listByOrganizationUsers: unknown[] = [];
let listByUserError: Error | null = null;

mock.module("./inference-auth-cache", () => ({
  invalidateInferenceAuthContextsByKeyHashes: async (hashes: readonly string[]) => {
    invalidatedHashBatches.push([...hashes]);
  },
  invalidateInferenceSessionAuthContexts: async (ids: readonly string[]) => {
    invalidatedSessionBatches.push([...ids]);
  },
}));

mock.module("./api-keys", () => ({
  apiKeysService: {
    deactivateByUserAndOrganization: async (userId: string, orgId: string) => {
      lifecycleEvents.push(`api-keys-deactivate:${userId}:${orgId}`);
    },
  },
}));

mock.module("./inference-credential-revocation", () => ({
  setInferenceSessionBindingActive: async (
    orgId: string,
    userId: string,
    stewardUserId: string,
    active: boolean,
  ) => {
    lifecycleEvents.push(`session-binding:${orgId}:${userId}:${stewardUserId}:${active}`);
    if (active && failNextBindingActivation) {
      failNextBindingActivation = false;
      throw new Error("binding activation unavailable");
    }
  },
  revokeInferenceSessionsThrough: async (orgId: string, userId: string) => {
    lifecycleEvents.push(`session:${orgId}:${userId}`);
  },
  setInferenceOrganizationActive: async (orgId: string, active: boolean) => {
    lifecycleEvents.push(`organization:${orgId}:${active}`);
  },
  setInferenceSubjectActive: async (
    orgId: string,
    userId: string,
    active: boolean,
    reason: string,
  ) => {
    lifecycleEvents.push(`subject:${orgId}:${userId}:${active}:${reason}`);
  },
}));

mock.module("../../db/repositories", () => ({
  apiKeysRepository: {
    listByUser: async (_userId: string) => {
      if (listByUserError) throw listByUserError;
      return userApiKeys;
    },
    listByOrganization: async (_orgId: string) => orgApiKeys,
    deactivateByUserAndOrganization: async (userId: string, orgId: string) => {
      lifecycleEvents.push(`api-keys-deactivate:${userId}:${orgId}`);
    },
  },
  usersRepository: {
    findById: async (_id: string) =>
      useReadUserRecordOverride ? readUserRecordOverride : userRecord,
    findByIdForWrite: async (_id: string) => userRecord,
    findIdentityByUserIdForWrite: async () =>
      userRecord?.steward_user_id ? { steward_user_id: userRecord.steward_user_id } : undefined,
    upsertStewardIdentity: async (id: string, stewardUserId: string) => {
      lifecycleEvents.push(`identity-upsert:${id}:${stewardUserId}`);
      if (userRecord) userRecord.steward_user_id = stewardUserId;
      return { user_id: id, steward_user_id: stewardUserId };
    },
    linkStewardId: async (id: string, stewardUserId: string) => {
      lifecycleEvents.push(`identity-link:${id}:${stewardUserId}`);
      userRecord = { ...userRecord, id, steward_user_id: stewardUserId };
      return userRecord;
    },
    update: async (id: string, data: Record<string, unknown>) => {
      lifecycleEvents.push(`user-update:${id}`);
      userRecord = { ...userRecord, ...data, id };
      return userRecord;
    },
    delete: async (id: string) => {
      userDeleteCalls.push(id);
      // Simulate the row (and its keys) being gone after delete so a test can
      // prove the key hashes were resolved BEFORE this call.
      userApiKeys = [];
    },
    listByOrganization: async (_orgId: string) => listByOrganizationUsers,
  },
  organizationsRepository: {
    findBySlug: async () => undefined,
    create: async (data: Record<string, unknown>) => ({ id: "o2", ...data }),
    update: async (id: string, data: Record<string, unknown>) => ({ id, ...data }),
    findWithUsers: async () => ({
      users: listByOrganizationUsers,
    }),
    delete: async (id: string) => {
      orgDeleteCalls.push(id);
      orgApiKeys = [];
    },
  },
}));

mock.module("../cache/client", () => ({
  cache: {
    get: async () => null,
    set: async () => {},
    del: async () => {},
  },
}));

mock.module("../utils/logger", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));

beforeEach(() => {
  invalidatedHashBatches.length = 0;
  invalidatedSessionBatches.length = 0;
  userDeleteCalls.length = 0;
  orgDeleteCalls.length = 0;
  userApiKeys = [];
  orgApiKeys = [];
  userRecord = undefined;
  readUserRecordOverride = undefined;
  useReadUserRecordOverride = false;
  failNextBindingActivation = false;
  listByOrganizationUsers = [];
  listByUserError = null;
  lifecycleEvents.length = 0;
});

describe("UsersService — IAC invalidation on lifecycle", () => {
  test("update with is_active=false evicts the user's cached key hashes", async () => {
    userRecord = {
      id: "u1",
      organization_id: "o1",
      email: null,
      steward_user_id: "steward-u1",
    };
    userApiKeys = [{ key_hash: "uh1" }, { key_hash: "uh2" }];

    const { usersService } = await import("./users");
    await usersService.update("u1", { is_active: false });

    expect(invalidatedHashBatches).toEqual([["uh1", "uh2"]]);
    expect(invalidatedSessionBatches).toContainEqual(["steward-u1"]);
  });

  test("update without an is_active=false transition does NOT invalidate", async () => {
    userRecord = {
      id: "u1",
      organization_id: "o1",
      email: null,
      steward_user_id: "steward-u1",
    };
    userApiKeys = [{ key_hash: "uh1" }];

    const { usersService } = await import("./users");
    await usersService.update("u1", { name: "renamed" });
    await usersService.update("u1", { is_active: true });

    expect(invalidatedHashBatches).toEqual([]);
  });

  test("organization move fences both orgs and the old session generation before the row moves", async () => {
    userRecord = {
      id: "u1",
      organization_id: "o1",
      email: null,
      role: "member",
      steward_user_id: "steward-u1",
      is_active: true,
    };

    const { usersService } = await import("./users");
    await usersService.update("u1", { organization_id: "o2" });

    expect(lifecycleEvents).toEqual([
      "subject:o1:u1:false:membership",
      "subject:o2:u1:false:membership",
      "session:o2:u1",
      "session:o1:u1",
      "user-update:u1",
      "subject:o2:u1:true:account",
      "subject:o2:u1:true:membership",
    ]);
  });

  test("Steward identity upsert fences the prior session generation before relinking", async () => {
    userRecord = {
      id: "u1",
      organization_id: "o1",
      email: null,
      steward_user_id: "steward-old",
    };

    const { usersService } = await import("./users");
    await usersService.upsertStewardIdentity("u1", "steward-new");

    expect(lifecycleEvents).toEqual([
      "session-binding:o1:u1:steward-old:false",
      "session:o1:u1",
      "identity-upsert:u1:steward-new",
      "session-binding:o1:u1:steward-new:true",
    ]);
  });

  test("direct Steward identity update swaps the durable binding around the row write", async () => {
    userRecord = {
      id: "u1",
      organization_id: "o1",
      email: null,
      steward_user_id: "steward-old",
    };

    const { usersService } = await import("./users");
    await usersService.update("u1", { steward_user_id: "steward-new" });

    expect(lifecycleEvents).toEqual([
      "session-binding:o1:u1:steward-old:false",
      "session:o1:u1",
      "user-update:u1",
      "session-binding:o1:u1:steward-new:true",
    ]);
  });

  test("direct Steward identity update fences the primary binding when the read replica lags", async () => {
    userRecord = {
      id: "u1",
      organization_id: "o1",
      email: null,
      steward_user_id: "steward-old",
    };
    useReadUserRecordOverride = true;
    readUserRecordOverride = undefined;

    const { usersService } = await import("./users");
    await usersService.update("u1", { steward_user_id: "steward-new" });

    expect(lifecycleEvents).toEqual([
      "session-binding:o1:u1:steward-old:false",
      "session:o1:u1",
      "user-update:u1",
      "session-binding:o1:u1:steward-new:true",
    ]);
  });

  test("retrying a committed Steward identity update repairs its active binding", async () => {
    userRecord = {
      id: "u1",
      organization_id: "o1",
      email: null,
      steward_user_id: "steward-current",
    };

    const { usersService } = await import("./users");
    await usersService.update("u1", { steward_user_id: "steward-current" });

    expect(lifecycleEvents).toEqual([
      "user-update:u1",
      "session-binding:o1:u1:steward-current:true",
    ]);
  });

  test("Steward identity upsert retry clears a fence left after the row write", async () => {
    userRecord = {
      id: "u1",
      organization_id: "o1",
      email: null,
      steward_user_id: "steward-new",
    };

    const { usersService } = await import("./users");
    await usersService.upsertStewardIdentity("u1", "steward-new");

    expect(lifecycleEvents).toEqual(["session-binding:o1:u1:steward-new:true"]);
    expect(invalidatedSessionBatches).toEqual([["steward-new"]]);
  });

  test("Steward identity upsert retry uses the primary user when the read replica lags", async () => {
    userRecord = {
      id: "u1",
      organization_id: "o1",
      email: null,
      steward_user_id: "steward-new",
    };
    useReadUserRecordOverride = true;
    readUserRecordOverride = undefined;

    const { usersService } = await import("./users");
    await usersService.upsertStewardIdentity("u1", "steward-new");

    expect(lifecycleEvents).toEqual(["session-binding:o1:u1:steward-new:true"]);
  });

  test("Steward identity upsert retries cache invalidation after a post-write fence failure", async () => {
    userRecord = {
      id: "u1",
      organization_id: "o1",
      email: null,
      steward_user_id: "steward-old",
    };
    failNextBindingActivation = true;

    const { usersService } = await import("./users");
    await expect(usersService.upsertStewardIdentity("u1", "steward-new")).rejects.toThrow(
      "binding activation unavailable",
    );
    expect(userRecord?.steward_user_id).toBe("steward-new");
    expect(invalidatedSessionBatches).toEqual([]);

    lifecycleEvents.length = 0;
    await usersService.upsertStewardIdentity("u1", "steward-new");

    expect(lifecycleEvents).toEqual(["session-binding:o1:u1:steward-new:true"]);
    expect(invalidatedSessionBatches).toEqual([["steward-new"]]);
  });

  test("Steward identity link fences the prior session generation before relinking", async () => {
    userRecord = {
      id: "u1",
      organization_id: "o1",
      email: null,
      steward_user_id: "steward-old",
    };

    const { usersService } = await import("./users");
    await usersService.linkStewardId("u1", "steward-new");

    expect(lifecycleEvents).toEqual([
      "session-binding:o1:u1:steward-old:false",
      "session:o1:u1",
      "identity-link:u1:steward-new",
      "session-binding:o1:u1:steward-new:true",
    ]);
  });

  test("Steward identity link fences the primary binding when the read replica lags", async () => {
    userRecord = {
      id: "u1",
      organization_id: "o1",
      email: null,
      steward_user_id: "steward-old",
    };
    useReadUserRecordOverride = true;
    readUserRecordOverride = undefined;

    const { usersService } = await import("./users");
    await usersService.linkStewardId("u1", "steward-new");

    expect(lifecycleEvents).toEqual([
      "session-binding:o1:u1:steward-old:false",
      "session:o1:u1",
      "identity-link:u1:steward-new",
      "session-binding:o1:u1:steward-new:true",
    ]);
  });

  test("delete resolves the key hashes BEFORE deleting the row", async () => {
    // organization_id null so the last-user org-cascade is skipped.
    userRecord = {
      id: "u1",
      organization_id: null,
      email: null,
      steward_user_id: "steward-u1",
    };
    userApiKeys = [{ key_hash: "uh1" }];

    const { usersService } = await import("./users");
    await usersService.delete("u1");

    expect(userDeleteCalls).toEqual(["u1"]);
    // The row is wiped on delete; a non-empty batch proves resolution happened first.
    expect(invalidatedHashBatches).toEqual([["uh1"]]);
    expect(invalidatedSessionBatches).toContainEqual(["steward-u1"]);
  });

  test("delete fences the primary organization when the read replica lags", async () => {
    userRecord = {
      id: "u1",
      organization_id: "o1",
      email: null,
      steward_user_id: "steward-u1",
    };
    useReadUserRecordOverride = true;
    readUserRecordOverride = undefined;
    listByOrganizationUsers = [{ id: "u2" }];

    const { usersService } = await import("./users");
    await usersService.delete("u1");

    expect(lifecycleEvents).toContain("subject:o1:u1:false:account");
    expect(userDeleteCalls).toEqual(["u1"]);
  });

  test("detach fences the primary organization when the read replica lags", async () => {
    userRecord = {
      id: "u1",
      organization_id: "o1",
      email: "member@example.com",
      name: "Member",
      role: "member",
      steward_user_id: "steward-u1",
      is_active: true,
    };
    useReadUserRecordOverride = true;
    readUserRecordOverride = undefined;

    const { usersService } = await import("./users");
    const detached = await usersService.detachFromOrganization("u1");

    expect(detached.organization_id).toBe("o2");
    expect(detached.role).toBe("owner");
    expect(lifecycleEvents).toEqual([
      "subject:o1:u1:false:membership",
      "user-update:u1",
      "api-keys-deactivate:u1:o1",
    ]);
  });

  test("delete invalidation is best-effort: a cache/db failure does not throw", async () => {
    userRecord = {
      id: "u1",
      organization_id: null,
      email: null,
      steward_user_id: "steward-u1",
    };
    userApiKeys = [{ key_hash: "uh1" }];
    listByUserError = new Error("db down");

    const { usersService } = await import("./users");
    await expect(usersService.delete("u1")).resolves.toBeUndefined();
    expect(userDeleteCalls).toEqual(["u1"]);
    expect(invalidatedHashBatches).toEqual([]);
  });
});

describe("OrganizationsService — IAC invalidation on lifecycle", () => {
  test("update with is_active=false evicts the org's cached key hashes", async () => {
    orgApiKeys = [{ key_hash: "oh1" }, { key_hash: "oh2" }];
    listByOrganizationUsers = [
      { steward_user_id: "steward-u1" },
      { steward_user_id: "steward-u2" },
    ];

    const { organizationsService } = await import("./organizations");
    await organizationsService.update("o1", { is_active: false });

    expect(invalidatedHashBatches).toEqual([["oh1", "oh2"]]);
    expect(invalidatedSessionBatches).toEqual([["steward-u1", "steward-u2"]]);
  });

  test("update without an is_active=false transition does NOT invalidate", async () => {
    orgApiKeys = [{ key_hash: "oh1" }];

    const { organizationsService } = await import("./organizations");
    await organizationsService.update("o1", { name: "renamed" });
    await organizationsService.update("o1", { is_active: true });

    expect(invalidatedHashBatches).toEqual([]);
  });

  test("delete resolves the key hashes BEFORE the delete cascade", async () => {
    orgApiKeys = [{ key_hash: "oh1" }];

    const { organizationsService } = await import("./organizations");
    await organizationsService.delete("o1");

    expect(orgDeleteCalls).toEqual(["o1"]);
    // Cascade wipes the keys; a non-empty batch proves resolution happened first.
    expect(invalidatedHashBatches).toEqual([["oh1"]]);
  });
});
