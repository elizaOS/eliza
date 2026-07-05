/**
 * Tests for the signup initial-credits grant fallback in syncUserFromSteward.
 *
 * When a brand-new Steward user signs up (branch 5: create user + org), the
 * org is created with a zero balance and the welcome bonus is granted via
 * creditsService.addCredits (which writes a credit-ledger row AND the balance).
 * If that ledger write fails, the grant must NOT be converted into an unledgered
 * direct balance write: the code logs the failure, rolls back the organization,
 * and propagates the error so the signup can retry cleanly.
 *
 * These tests drive the real syncUserFromSteward through to branch 5 with every
 * touched service mocked, then assert the grant-vs-fallback decision in
 * isolation (#8427 / cloud-launch tracker E4).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mock state captured per test ─────────────────────────────────────────
const addCreditsCalls: unknown[] = [];
const orgUpdateCalls: Array<{ id: string; data: unknown }> = [];
const orgDeleteCalls: string[] = [];
const loggerErrorCalls: Array<{ message: string; context?: unknown }> = [];
let addCreditsImpl: (params: unknown) => Promise<unknown> = async (params) => {
  addCreditsCalls.push(params);
  return { success: true };
};

const createdOrg = { id: "org-new-1", slug: "alice-abc123", credit_balance: "0.00" };
const createdUser = { id: "user-new-1", organization_id: "org-new-1" };
const finalUserWithOrg = {
  id: "user-new-1",
  steward_user_id: "steward-123",
  email: "alice@example.com",
  name: "alice",
  wallet_address: null,
  role: "owner",
  email_verified: true,
  wallet_verified: false,
  organization: { id: "org-new-1", name: "alice's Organization" },
};

mock.module("./services/credits", () => ({
  creditsService: {
    addCredits: (params: unknown) => addCreditsImpl(params),
  },
}));

mock.module("./services/organizations", () => ({
  organizationsService: {
    getBySlug: async () => undefined,
    create: async () => createdOrg,
    update: async (id: string, data: unknown) => {
      orgUpdateCalls.push({ id, data });
      return { ...createdOrg, ...(data as object) };
    },
    delete: async (id: string) => {
      orgDeleteCalls.push(id);
      return undefined;
    },
  },
}));

mock.module("./services/users", () => ({
  usersService: {
    getByStewardId: async () => undefined,
    getByEmailWithOrganization: async () => undefined,
    getByWalletAddress: async () => undefined,
    getByWalletAddressWithOrganization: async () => undefined,
    getStewardIdentityForWrite: async () => undefined,
    getByStewardIdForWrite: async () => finalUserWithOrg,
    create: async () => createdUser,
    update: async () => undefined,
    linkStewardId: async () => undefined,
    upsertStewardIdentity: async () => undefined,
  },
}));

mock.module("./services/invites", () => ({
  invitesService: {
    findPendingInviteByEmail: async () => undefined,
  },
}));

mock.module("./services/api-keys", () => ({
  apiKeysService: {
    listByOrganization: async () => [],
    create: async () => ({ id: "key-1" }),
    ensureUserHasApiKey: async () => undefined,
  },
}));

mock.module("./services/characters/characters", () => ({
  charactersService: {
    existsForOrganization: async () => false,
    create: async () => ({ id: "char-1" }),
  },
}));

mock.module("./services/discord", () => ({
  discordService: {
    logUserSignup: async () => undefined,
  },
}));

mock.module("./services/email", () => ({
  emailService: {
    sendWelcomeEmail: async () => undefined,
  },
}));

mock.module("./db/repositories/organization-invites", () => ({
  organizationInvitesRepository: {
    markAsAccepted: async () => undefined,
  },
}));

mock.module("./db/repositories/users", () => ({
  usersRepository: {
    delete: async () => undefined,
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

const baseParams = {
  stewardUserId: "steward-123",
  email: "alice@example.com",
  name: "alice",
};

describe("syncUserFromSteward — initial-credits grant fallback", () => {
  beforeEach(() => {
    addCreditsCalls.length = 0;
    orgUpdateCalls.length = 0;
    orgDeleteCalls.length = 0;
    loggerErrorCalls.length = 0;
    // Default to the happy path; failure tests override this.
    addCreditsImpl = async (params) => {
      addCreditsCalls.push(params);
      return { success: true };
    };
    // Pin the grant amount so String(initialCredits) === "5".
    process.env.INITIAL_FREE_CREDITS = "5";
  });

  test("happy path: addCredits succeeds → no fallback update, no error logged", async () => {
    const { syncUserFromSteward } = await import("./steward-sync");

    const result = await syncUserFromSteward(baseParams);

    // The grant went through the ledger.
    expect(addCreditsCalls).toHaveLength(1);
    expect(addCreditsCalls[0]).toMatchObject({
      organizationId: "org-new-1",
      amount: 5,
      metadata: { type: "initial_free_credits", source: "signup" },
    });
    // No direct-balance fallback write for the grant.
    expect(
      orgUpdateCalls.filter((c) => (c.data as { credit_balance?: string }).credit_balance),
    ).toHaveLength(0);
    // No grant failure surfaced.
    expect(loggerErrorCalls.some((c) => c.message.includes("addCredits failed"))).toBe(false);
    expect(result).toMatchObject({
      ...finalUserWithOrg,
      initialCreditsGranted: true,
      initialFreeCreditsUsd: 5,
    });
  });

  test("ledger failure: rolls back the org and does not write an unledgered balance", async () => {
    addCreditsImpl = async (params) => {
      addCreditsCalls.push(params);
      throw new Error("ledger write failed");
    };

    const { syncUserFromSteward } = await import("./steward-sync");

    await expect(syncUserFromSteward(baseParams)).rejects.toThrow("ledger write failed");

    // addCredits was attempted.
    expect(addCreditsCalls).toHaveLength(1);

    // No fallback wrote the balance directly as String(initialCredits).
    const directBalanceUpdate = orgUpdateCalls.find(
      (c) => (c.data as { credit_balance?: string }).credit_balance !== undefined,
    );
    expect(directBalanceUpdate).toBeUndefined();
    expect(orgDeleteCalls).toEqual(["org-new-1"]);

    const grantError = loggerErrorCalls.find((c) =>
      c.message.includes("addCredits failed for new org"),
    );
    expect(grantError).toBeDefined();
    // The failure detail is inlined in the message string — Workers Logs drops
    // logger context objects, which is how this failure stayed invisible.
    expect(grantError!.message).toContain("org-new-1");
    expect(grantError!.message).toContain("ledger write failed");
  });
});
