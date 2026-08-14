/**
 * Tests the withheld-welcome-bonus persistence in syncUserFromSteward (branch 5:
 * brand-new user + org).
 *
 * When the anti-sybil per-IP grant cap withholds the signup bonus, the sync
 * must (a) report the withheld metadata on the returned user AND (b) record the
 * decision on the new org's settings via organizationsService.update — that
 * settings record is what lets the agent credit gate explain the later
 * $0-balance 402 at /join with the real reason instead of a bare
 * "Insufficient credits" (the auth response is long gone by then).
 *
 * Same deterministic scaffolding as steward-sync-grant.test.ts, with the grant
 * guard mocked to return the withheld decision.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const orgUpdateCalls: Array<{ id: string; data: unknown }> = [];
const addCreditsCalls: unknown[] = [];

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

const WITHHELD_MESSAGE =
  "Welcome credit unavailable because this network reached the daily free-credit limit. Add funds to start an agent.";

mock.module("./services/signup-grant-guard", () => ({
  runWithSignupGrantIpCapDetailed: async () => ({
    granted: false,
    withheldReason: "ip_daily_cap",
    withheldMessage: WITHHELD_MESSAGE,
    cap: 3,
    windowHours: 24,
  }),
  welcomeBonusWithheldSettingsPatch: (decision: {
    withheldReason?: string;
    withheldMessage?: string;
  }) =>
    decision.withheldReason
      ? {
          welcomeBonusWithheld: {
            reason: decision.withheldReason,
            ...(decision.withheldMessage ? { message: decision.withheldMessage } : {}),
          },
        }
      : null,
}));

mock.module("./services/credits", () => ({
  creditsService: {
    addCredits: async (params: unknown) => {
      addCreditsCalls.push(params);
      return { success: true };
    },
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
    delete: async () => undefined,
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
    provisionDefaultApiKey: async () => undefined,
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
    error: () => {},
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

describe("syncUserFromSteward — withheld welcome bonus persistence", () => {
  beforeEach(() => {
    orgUpdateCalls.length = 0;
    addCreditsCalls.length = 0;
    process.env.INITIAL_FREE_CREDITS = "5";
  });

  test("withheld grant → metadata on the result AND the settings record on the org", async () => {
    const { syncUserFromSteward } = await import("./steward-sync");

    const result = await syncUserFromSteward(baseParams);

    // The auth response metadata still reports the withheld bonus.
    expect(result).toMatchObject({
      initialCreditsGranted: false,
      initialFreeCreditsUsd: 0,
      welcomeBonusWithheld: true,
      welcomeBonusWithheldReason: "ip_daily_cap",
      welcomeBonusWithheldMessage: WITHHELD_MESSAGE,
    });

    // The durable settings record for the later 402 explanation.
    const settingsWrite = orgUpdateCalls.find(
      (c) =>
        c.id === "org-new-1" &&
        (c.data as { settings?: { welcomeBonusWithheld?: unknown } }).settings
          ?.welcomeBonusWithheld,
    );
    expect(settingsWrite).toBeDefined();
    expect(
      (settingsWrite!.data as { settings: { welcomeBonusWithheld: unknown } }).settings
        .welcomeBonusWithheld,
    ).toEqual({ reason: "ip_daily_cap", message: WITHHELD_MESSAGE });
  });
});
