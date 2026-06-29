/**
 * IAC (inference auth context) cache invalidation on user-level auth-state
 * changes (#9981 review must-fix).
 *
 * The inference hot path caches a fully-authorized identity per API-key hash and
 * skips re-checking moderation on a cache hit. So a ban / suspend / deactivate /
 * delete MUST drop the user's cached IAC entries explicitly — otherwise a blocked
 * user keeps being served inference until the entry's TTL expires.
 *
 * These tests drive the REAL service code (admin / users / organizations) against
 * an in-memory cache, with the DB client + repositories mocked, and assert that
 * every enumerated blocking transition drops the live IAC entry, while a
 * non-blocking change leaves it intact (no over-invalidation). All four
 * enumerated transitions are covered here:
 *   - ban / moderation-escalation         → AdminService
 *   - user deactivate / user hard-delete   → UsersService
 *   - org deactivate / org delete          → OrganizationsService
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const ORG_ID = "22222222-2222-2222-2222-222222222222";
const RAW_KEY = "sk-test-ban-invalidation-0001";

// ── In-memory cache backing the real inference-auth-cache helpers ────────────
const store = new Map<string, unknown>();

mock.module("../cache/client", () => ({
  cache: {
    get: async (key: string) => (store.has(key) ? store.get(key) : null),
    set: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    del: async (key: string) => {
      store.delete(key);
    },
  },
}));

// ── Stateful mock of the moderation-status row backing the DB client ─────────
interface ModRow {
  userId: string;
  status: string;
  totalViolations: number;
  warningCount: number;
  riskScore: number;
  lastViolationAt?: Date | null;
  lastWarningAt?: Date | null;
  [key: string]: unknown;
}

let modRow: ModRow | null = null;

function makeInsertResult(
  rows: unknown[],
): Promise<unknown[]> & { returning: () => Promise<unknown[]> } {
  return Object.assign(Promise.resolve(rows), { returning: async () => rows });
}

mock.module("../../db/client", () => ({
  dbRead: {
    query: {
      userModerationStatus: {
        findFirst: async () => modRow ?? undefined,
      },
    },
  },
  dbWrite: {
    insert: () => ({
      values: (vals: Record<string, unknown>) => {
        // moderationViolations inserts carry messageText; ignore those for state.
        if ("messageText" in vals) {
          return makeInsertResult([{ id: "violation-1", ...vals }]);
        }
        modRow = {
          status: "clean",
          totalViolations: 0,
          warningCount: 0,
          riskScore: 0,
          ...vals,
        } as ModRow;
        return makeInsertResult([modRow]);
      },
    }),
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          modRow = { ...(modRow as ModRow), ...vals };
        },
      }),
    }),
  },
}));

// admin.ts builds queries with drizzle-orm helpers, but the DB client here is
// fully mocked, so the built expressions are never executed — stub the helpers as
// opaque builders. This also keeps the test hermetic (no installed drizzle-orm).
mock.module("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ __and: args }),
  desc: (col: unknown) => ({ __desc: col }),
  eq: (a: unknown, b: unknown) => ({ __eq: [a, b] }),
  sql: Object.assign((...args: unknown[]) => ({ __sql: args }), {
    raw: (value: unknown) => value,
  }),
}));

// admin.ts imports drizzle table objects from the schemas barrel, which otherwise
// pulls the whole plugin-sql/@elizaos/core stack into the test (and fails module
// resolution). The DB client is fully mocked, so the table objects are only ever
// passed to eq()/insert()/update() as opaque operands — stub them.
mock.module("../../db/schemas", () => ({
  adminUsers: {},
  moderationViolations: {},
  userModerationStatus: { userId: "userId" },
  users: {},
}));

// ── Mock the api-keys repository's key-hash resolvers ────────────────────────
// admin.ts imports the subpath; users.ts/organizations.ts import it from the
// repositories barrel — provide both, sharing the same activeKeyHashes state.
let activeKeyHashes: string[] = [];

mock.module("../../db/repositories/api-keys", () => ({
  apiKeysRepository: {
    findActiveKeyHashesByUserId: async () => activeKeyHashes,
    findActiveKeyHashesByOrganizationId: async () => activeKeyHashes,
  },
}));

// ── Stateful mock of the repositories barrel (users + organizations) ─────────
let userFindByIdResult: Record<string, unknown> | null = null;
let userUpdateResult: Record<string, unknown> | null = null;
let listByOrgResult: unknown[] = [];
const deletedUserIds: string[] = [];
const deletedOrgIds: string[] = [];

mock.module("../../db/repositories", () => ({
  apiKeysRepository: {
    findActiveKeyHashesByUserId: async () => activeKeyHashes,
    findActiveKeyHashesByOrganizationId: async () => activeKeyHashes,
  },
  usersRepository: {
    findById: async () => userFindByIdResult ?? undefined,
    update: async () => userUpdateResult ?? undefined,
    delete: async (id: string) => {
      deletedUserIds.push(id);
    },
    listByOrganization: async () => listByOrgResult,
  },
  organizationsRepository: {
    update: async (id: string, data: Record<string, unknown>) => ({ id, ...data }),
    delete: async (id: string) => {
      deletedOrgIds.push(id);
    },
  },
}));

mock.module("../utils/logger", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

function makeUser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: USER_ID,
    email: null,
    steward_user_id: null,
    wallet_address: null,
    organization_id: ORG_ID,
    is_active: true,
    ...overrides,
  };
}

async function writeHotEntry() {
  const { writeInferenceAuthContext, hashApiKey, INFERENCE_AUTH_CONTEXT_VERSION } = await import(
    "./inference-auth-cache"
  );
  const keyHash = hashApiKey(RAW_KEY);
  await writeInferenceAuthContext({
    v: INFERENCE_AUTH_CONTEXT_VERSION,
    cachedAt: Date.now(),
    userId: USER_ID,
    orgId: ORG_ID,
    apiKeyId: "33333333-3333-3333-3333-333333333333",
    keyHash,
  });
  return keyHash;
}

describe("IAC invalidation on user-level auth-state changes", () => {
  beforeEach(() => {
    store.clear();
    modRow = null;
    activeKeyHashes = [];
    userFindByIdResult = null;
    userUpdateResult = null;
    listByOrgResult = [];
    deletedUserIds.length = 0;
    deletedOrgIds.length = 0;
  });

  // ── Admin: ban / moderation escalation ─────────────────────────────────────

  test("banUser drops the hot IAC entry for the user's keys", async () => {
    const keyHash = await writeHotEntry();
    activeKeyHashes = [keyHash];

    const { readInferenceAuthContext } = await import("./inference-auth-cache");
    expect(await readInferenceAuthContext(keyHash)).not.toBeNull();

    const { adminService } = await import("./admin");
    await adminService.banUser({ userId: USER_ID, adminUserId: "admin-1", reason: "abuse" });

    expect(await readInferenceAuthContext(keyHash)).toBeNull();
  });

  test("moderation escalation into a blocking state drops the IAC entry", async () => {
    const keyHash = await writeHotEntry();
    activeKeyHashes = [keyHash];

    // Existing row already at 4 violations: the next violation crosses the
    // shouldBlockUser threshold (totalViolations >= 5).
    modRow = {
      userId: USER_ID,
      status: "clean",
      totalViolations: 4,
      warningCount: 0,
      riskScore: 80,
      lastWarningAt: null,
    };

    const { readInferenceAuthContext } = await import("./inference-auth-cache");
    expect(await readInferenceAuthContext(keyHash)).not.toBeNull();

    const { adminService } = await import("./admin");
    await adminService.recordViolation({
      userId: USER_ID,
      messageText: "spam spam spam",
      categories: ["spam"],
      scores: { spam: 0.99 },
      action: "flagged_for_ban",
    });

    expect(await readInferenceAuthContext(keyHash)).toBeNull();
  });

  test("a non-blocking moderation escalation does NOT drop the IAC entry", async () => {
    const keyHash = await writeHotEntry();
    activeKeyHashes = [keyHash];

    // Far below the blocking threshold: must not over-invalidate.
    modRow = {
      userId: USER_ID,
      status: "clean",
      totalViolations: 1,
      warningCount: 0,
      riskScore: 20,
      lastWarningAt: null,
    };

    const { adminService } = await import("./admin");
    await adminService.recordViolation({
      userId: USER_ID,
      messageText: "mild",
      categories: ["spam"],
      scores: { spam: 0.5 },
      action: "warned",
    });

    const { readInferenceAuthContext } = await import("./inference-auth-cache");
    expect(await readInferenceAuthContext(keyHash)).not.toBeNull();
  });

  // ── Users: deactivate / hard-delete ────────────────────────────────────────

  test("UsersService.update deactivating a user drops the IAC entry", async () => {
    const keyHash = await writeHotEntry();
    activeKeyHashes = [keyHash];
    userFindByIdResult = makeUser({ is_active: true });
    userUpdateResult = makeUser({ is_active: false });

    const { readInferenceAuthContext } = await import("./inference-auth-cache");
    expect(await readInferenceAuthContext(keyHash)).not.toBeNull();

    const { usersService } = await import("./users");
    await usersService.update(USER_ID, { is_active: false });

    expect(await readInferenceAuthContext(keyHash)).toBeNull();
  });

  test("UsersService.update without deactivation does NOT drop the IAC entry", async () => {
    const keyHash = await writeHotEntry();
    activeKeyHashes = [keyHash];
    userFindByIdResult = makeUser({ is_active: true });
    userUpdateResult = makeUser({ is_active: true });

    const { usersService } = await import("./users");
    await usersService.update(USER_ID, {});

    const { readInferenceAuthContext } = await import("./inference-auth-cache");
    expect(await readInferenceAuthContext(keyHash)).not.toBeNull();
  });

  test("UsersService.delete drops the IAC entry for an active user (the must-fix gap)", async () => {
    const keyHash = await writeHotEntry();
    activeKeyHashes = [keyHash];
    // A normal active user being hard-deleted: is_active === true, so the
    // invalidateCache gate does NOT fire — delete() must invalidate explicitly.
    userFindByIdResult = makeUser({ is_active: true });
    // Keep a user remaining in the org so the cascade-org-delete branch is skipped.
    listByOrgResult = [makeUser({ id: "other-user" })];

    const { readInferenceAuthContext } = await import("./inference-auth-cache");
    expect(await readInferenceAuthContext(keyHash)).not.toBeNull();

    const { usersService } = await import("./users");
    await usersService.delete(USER_ID);

    expect(deletedUserIds).toContain(USER_ID);
    expect(await readInferenceAuthContext(keyHash)).toBeNull();
  });

  // ── Organizations: deactivate / delete ─────────────────────────────────────

  test("OrganizationsService.update deactivating an org drops the IAC entries", async () => {
    const keyHash = await writeHotEntry();
    activeKeyHashes = [keyHash];

    const { readInferenceAuthContext } = await import("./inference-auth-cache");
    expect(await readInferenceAuthContext(keyHash)).not.toBeNull();

    const { organizationsService } = await import("./organizations");
    await organizationsService.update(ORG_ID, { is_active: false });

    expect(await readInferenceAuthContext(keyHash)).toBeNull();
  });

  test("OrganizationsService.update without deactivation does NOT drop the IAC entries", async () => {
    const keyHash = await writeHotEntry();
    activeKeyHashes = [keyHash];

    const { organizationsService } = await import("./organizations");
    // Routine update (e.g. a balance/metadata change) must not fan out.
    await organizationsService.update(ORG_ID, {});

    const { readInferenceAuthContext } = await import("./inference-auth-cache");
    expect(await readInferenceAuthContext(keyHash)).not.toBeNull();
  });

  test("OrganizationsService.delete drops the IAC entries before the cascade", async () => {
    const keyHash = await writeHotEntry();
    activeKeyHashes = [keyHash];

    const { readInferenceAuthContext } = await import("./inference-auth-cache");
    expect(await readInferenceAuthContext(keyHash)).not.toBeNull();

    const { organizationsService } = await import("./organizations");
    await organizationsService.delete(ORG_ID);

    expect(deletedOrgIds).toContain(ORG_ID);
    expect(await readInferenceAuthContext(keyHash)).toBeNull();
  });

  // ── Direct single-key revoke path ──────────────────────────────────────────

  test("api-key revoke drops the IAC entry by key hash", async () => {
    const keyHash = await writeHotEntry();

    const { readInferenceAuthContext, invalidateInferenceAuthContextByKeyHash } = await import(
      "./inference-auth-cache"
    );
    expect(await readInferenceAuthContext(keyHash)).not.toBeNull();

    await invalidateInferenceAuthContextByKeyHash(keyHash);

    expect(await readInferenceAuthContext(keyHash)).toBeNull();
  });
});
