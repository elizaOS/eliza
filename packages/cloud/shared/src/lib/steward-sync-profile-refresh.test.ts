/**
 * Tests for the existing-user profile refresh in syncUserFromSteward (branch 1)
 * and the error-description helpers behind the sign-in observability fix.
 *
 * Branch 1 writes claims-derived email/wallet_address into UNIQUE columns with
 * every login. When another row already owns the value, that update 23505s on
 * EVERY sign-in of the same user — the deterministic per-user loop behind the
 * prod steward-nonce-exchange 500s. The refresh is best-effort: the user is
 * already identified by steward_user_id, so a unique-constraint conflict must
 * log loudly and keep the stored profile instead of failing the whole sign-in.
 * Any other update failure still aborts (and is now logged with its Postgres
 * code/constraint inlined in the message, since Workers Logs drops context
 * objects).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const updateCalls: Array<{ id: string; data: unknown }> = [];
const loggerErrorCalls: Array<{ message: string; context?: unknown }> = [];
let updateImpl: (id: string, data: unknown) => Promise<unknown> = async (id, data) => {
  updateCalls.push({ id, data });
  return undefined;
};

const storedUser = {
  id: "user-1",
  steward_user_id: "steward-123",
  email: "old@example.com",
  name: "old-name",
  wallet_address: null,
  email_verified: true,
  wallet_verified: false,
  organization: { id: "org-1", name: "org" },
};
const refreshedUser = { ...storedUser, email: "alice@example.com", name: "alice" };

mock.module("./services/users", () => ({
  usersService: {
    getByStewardId: async () => storedUser,
    getByStewardIdForWrite: async () => refreshedUser,
    getByEmailWithOrganization: async () => undefined,
    getByWalletAddress: async () => undefined,
    getByWalletAddressWithOrganization: async () => undefined,
    getStewardIdentityForWrite: async () => undefined,
    create: async () => {
      throw new Error("create must not run for an existing user");
    },
    update: (id: string, data: unknown) => updateImpl(id, data),
    linkStewardId: async () => undefined,
    upsertStewardIdentity: async () => undefined,
  },
}));

mock.module("./utils/logger", () => ({
  logger: {
    error: (message: string, context?: unknown) => {
      loggerErrorCalls.push({ message, context });
    },
    warn: () => {},
    info: () => {},
    debug: () => {},
  },
  redact: {
    id: (v: string) => v,
    orgId: (v: string) => v,
    userId: (v: string) => v,
  },
}));

function pgError(
  message: string,
  fields: { code?: string; constraint?: string; detail?: string },
): Error {
  return Object.assign(new Error(message), fields);
}

// Claims email differs from the stored row → shouldUpdate fires.
const baseParams = {
  stewardUserId: "steward-123",
  email: "alice@example.com",
  name: "alice",
};

describe("syncUserFromSteward — existing-user profile refresh (branch 1)", () => {
  beforeEach(() => {
    updateCalls.length = 0;
    loggerErrorCalls.length = 0;
    updateImpl = async (id, data) => {
      updateCalls.push({ id, data });
      return undefined;
    };
  });

  test("happy path: refresh succeeds and the re-read row is returned", async () => {
    const { syncUserFromSteward } = await import("./steward-sync");

    const result = await syncUserFromSteward(baseParams);

    expect(updateCalls).toHaveLength(1);
    expect(result).toBe(refreshedUser as never);
    expect(loggerErrorCalls).toHaveLength(0);
  });

  test("unique-constraint conflict: sign-in continues with the stored profile and the collision is logged with its constraint inlined", async () => {
    updateImpl = async () => {
      throw pgError("duplicate key value violates unique constraint", {
        code: "23505",
        constraint: "users_email_unique",
        detail: "Key (email)=(alice@example.com) already exists.",
      });
    };

    const { syncUserFromSteward } = await import("./steward-sync");

    const result = await syncUserFromSteward(baseParams);

    // Sign-in resolved with the pre-refresh row — no throw, no 500.
    expect(result).toBe(storedUser as never);
    const conflictLog = loggerErrorCalls.find((c) =>
      c.message.includes("continuing sign-in with the stored profile"),
    );
    expect(conflictLog).toBeDefined();
    // Everything needed to identify the collision is IN the message string
    // (Workers Logs drops logger context objects).
    expect(conflictLog!.message).toContain("user-1");
    expect(conflictLog!.message).toContain("code=23505");
    expect(conflictLog!.message).toContain("constraint=users_email_unique");
    expect(conflictLog!.message).toContain("alice@example.com");
  });

  test("driver-wrapped conflict (code on error.cause) is tolerated the same way", async () => {
    updateImpl = async () => {
      throw new Error("update failed", {
        cause: pgError("duplicate key value violates unique constraint", {
          code: "23505",
          constraint: "users_wallet_address_unique",
        }),
      });
    };

    const { syncUserFromSteward } = await import("./steward-sync");

    const result = await syncUserFromSteward(baseParams);

    expect(result).toBe(storedUser as never);
    expect(
      loggerErrorCalls.some((c) => c.message.includes("constraint=users_wallet_address_unique")),
    ).toBe(true);
  });

  test("non-conflict failure still aborts the sync — and is logged with the error inlined", async () => {
    updateImpl = async () => {
      throw new Error("Connection terminated unexpectedly");
    };

    const { syncUserFromSteward } = await import("./steward-sync");

    await expect(syncUserFromSteward(baseParams)).rejects.toThrow(
      "Connection terminated unexpectedly",
    );
    const failureLog = loggerErrorCalls.find((c) => c.message.includes("profile refresh failed"));
    expect(failureLog).toBeDefined();
    expect(failureLog!.message).toContain("Connection terminated unexpectedly");
  });
});

describe("error-description helpers", () => {
  test("isUniqueViolation matches direct and cause-wrapped 23505s, nothing else", async () => {
    const { isUniqueViolation } = await import("./steward-sync");

    expect(isUniqueViolation(pgError("dup", { code: "23505" }))).toBe(true);
    expect(
      isUniqueViolation(new Error("wrapped", { cause: pgError("dup", { code: "23505" }) })),
    ).toBe(true);
    expect(isUniqueViolation(pgError("fk", { code: "23503" }))).toBe(false);
    expect(isUniqueViolation(new Error("plain"))).toBe(false);
    expect(isUniqueViolation("string")).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  test("describeSyncError inlines message, code, constraint and detail", async () => {
    const { describeSyncError } = await import("./steward-sync");

    const described = describeSyncError(
      pgError("duplicate key value violates unique constraint", {
        code: "23505",
        constraint: "users_email_unique",
        detail: "Key (email)=(a@b.co) already exists.",
      }),
    );
    expect(described).toContain("duplicate key value violates unique constraint");
    expect(described).toContain("code=23505");
    expect(described).toContain("constraint=users_email_unique");
    expect(described).toContain("detail=Key (email)=(a@b.co) already exists.");
  });

  test("describeSyncError reads Postgres fields from error.cause for wrapped driver errors", async () => {
    const { describeSyncError } = await import("./steward-sync");

    const described = describeSyncError(
      new Error("query failed", {
        cause: pgError("dup", { code: "23505", constraint: "users_wallet_address_unique" }),
      }),
    );
    expect(described).toContain("query failed");
    expect(described).toContain("code=23505");
    expect(described).toContain("constraint=users_wallet_address_unique");
  });

  test("describeSyncError appends a stack excerpt for non-Postgres errors", async () => {
    const { describeSyncError } = await import("./steward-sync");

    const described = describeSyncError(new Error("something unexpected"));
    expect(described).toContain("something unexpected");
    expect(described).toContain("stack=");
  });
});
