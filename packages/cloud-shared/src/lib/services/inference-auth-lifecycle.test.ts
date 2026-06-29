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
 * Plus: invalidation is best-effort and must never throw into the lifecycle write.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Captured side effects + per-test repository state ───────────────────────
const invalidatedHashBatches: string[][] = [];
const userDeleteCalls: string[] = [];
const orgDeleteCalls: string[] = [];

let userApiKeys: Array<{ key_hash: string }> = [];
let orgApiKeys: Array<{ key_hash: string }> = [];
let userRecord: Record<string, unknown> | undefined;
let listByOrganizationUsers: unknown[] = [];
let listByUserError: Error | null = null;

mock.module("./inference-auth-cache", () => ({
  invalidateInferenceAuthContextsByKeyHashes: async (hashes: readonly string[]) => {
    invalidatedHashBatches.push([...hashes]);
  },
}));

mock.module("../../db/repositories", () => ({
  apiKeysRepository: {
    listByUser: async (_userId: string) => {
      if (listByUserError) throw listByUserError;
      return userApiKeys;
    },
    listByOrganization: async (_orgId: string) => orgApiKeys,
  },
  usersRepository: {
    findById: async (_id: string) => userRecord,
    update: async (id: string, data: Record<string, unknown>) => ({ ...userRecord, ...data, id }),
    delete: async (id: string) => {
      userDeleteCalls.push(id);
      // Simulate the row (and its keys) being gone after delete so a test can
      // prove the key hashes were resolved BEFORE this call.
      userApiKeys = [];
    },
    listByOrganization: async (_orgId: string) => listByOrganizationUsers,
  },
  organizationsRepository: {
    update: async (id: string, data: Record<string, unknown>) => ({ id, ...data }),
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
  userDeleteCalls.length = 0;
  orgDeleteCalls.length = 0;
  userApiKeys = [];
  orgApiKeys = [];
  userRecord = undefined;
  listByOrganizationUsers = [];
  listByUserError = null;
});

describe("UsersService — IAC invalidation on lifecycle", () => {
  test("update with is_active=false evicts the user's cached key hashes", async () => {
    userRecord = { id: "u1", organization_id: "o1", email: null };
    userApiKeys = [{ key_hash: "uh1" }, { key_hash: "uh2" }];

    const { usersService } = await import("./users");
    await usersService.update("u1", { is_active: false });

    expect(invalidatedHashBatches).toEqual([["uh1", "uh2"]]);
  });

  test("update without an is_active=false transition does NOT invalidate", async () => {
    userRecord = { id: "u1", organization_id: "o1", email: null };
    userApiKeys = [{ key_hash: "uh1" }];

    const { usersService } = await import("./users");
    await usersService.update("u1", { name: "renamed" });
    await usersService.update("u1", { is_active: true });

    expect(invalidatedHashBatches).toEqual([]);
  });

  test("delete resolves the key hashes BEFORE deleting the row", async () => {
    // organization_id null so the last-user org-cascade is skipped.
    userRecord = { id: "u1", organization_id: null, email: null };
    userApiKeys = [{ key_hash: "uh1" }];

    const { usersService } = await import("./users");
    await usersService.delete("u1");

    expect(userDeleteCalls).toEqual(["u1"]);
    // The row is wiped on delete; a non-empty batch proves resolution happened first.
    expect(invalidatedHashBatches).toEqual([["uh1"]]);
  });

  test("delete invalidation is best-effort: a cache/db failure does not throw", async () => {
    userRecord = { id: "u1", organization_id: null, email: null };
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

    const { organizationsService } = await import("./organizations");
    await organizationsService.update("o1", { is_active: false });

    expect(invalidatedHashBatches).toEqual([["oh1", "oh2"]]);
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
