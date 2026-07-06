/**
 * Regression tests for eager per-org Steward tenant provisioning at signup
 * (#14645).
 *
 * Steward tenants used to be created LAZILY, only at agent-provision time
 * (docker-sandbox-provider → ensureStewardTenant). A brand-new user therefore
 * had no Steward tenant, so the app's first post-login call
 * (`GET /steward/user/me/tenants`) returned 403, which the frontend read as
 * "not authenticated" → an infinite bounce back to /login. The user could
 * never reach agent-provision to self-heal (629/630 staging orgs had a NULL
 * steward_tenant_id).
 *
 * Fix under test: syncUserFromSteward's new-user branch (branch 5) now calls
 * ensureStewardTenant(org.id) after the user + org are fully created. Two
 * properties are asserted here:
 *
 *   (a) a new-user signup provisions the tenant for the NEW org, and
 *   (b) FAIL-OPEN: a Steward failure (unreachable, 5xx, ...) must NOT block
 *       signup — the sync still resolves with the user, the org is NOT rolled
 *       back, and the failure is logged as a warning carrying the org id
 *       (the lazy agent-provision call site remains as the later self-heal).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mock state captured per test ─────────────────────────────────────────
const ensureStewardTenantCalls: string[] = [];
const orgDeleteCalls: string[] = [];
const loggerWarnCalls: Array<{ message: string; context?: unknown }> = [];
const loggerErrorCalls: Array<{ message: string; context?: unknown }> = [];
let ensureStewardTenantImpl: (organizationId: string) => Promise<unknown> = async (
  organizationId,
) => {
  ensureStewardTenantCalls.push(organizationId);
  return { tenantId: `elizacloud-${organizationId}`, apiKey: "tenant-key", isNew: true };
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

mock.module("./services/steward-tenant-config", () => ({
  ensureStewardTenant: (organizationId: string) => ensureStewardTenantImpl(organizationId),
  resolveDefaultStewardTenantId: () => "elizacloud",
  resolveStewardTenantCredentials: async () => ({ tenantId: "elizacloud" }),
  DEFAULT_STEWARD_TENANT_ID: "elizacloud",
}));

mock.module("./services/credits", () => ({
  creditsService: {
    addCredits: async () => ({ success: true }),
  },
}));

mock.module("./services/organizations", () => ({
  organizationsService: {
    getBySlug: async () => undefined,
    create: async () => createdOrg,
    update: async () => createdOrg,
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
    error: (message: string, context?: unknown) => {
      loggerErrorCalls.push({ message, context });
    },
    warn: (message: string, context?: unknown) => {
      loggerWarnCalls.push({ message, context });
    },
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

describe("syncUserFromSteward — eager Steward tenant provisioning (#14645)", () => {
  beforeEach(() => {
    ensureStewardTenantCalls.length = 0;
    orgDeleteCalls.length = 0;
    loggerWarnCalls.length = 0;
    loggerErrorCalls.length = 0;
    // Default to the happy path; failure tests override this.
    ensureStewardTenantImpl = async (organizationId) => {
      ensureStewardTenantCalls.push(organizationId);
      return { tenantId: `elizacloud-${organizationId}`, apiKey: "tenant-key", isNew: true };
    };
    process.env.INITIAL_FREE_CREDITS = "5";
  });

  test("new-user signup provisions a Steward tenant for the new org", async () => {
    const { syncUserFromSteward } = await import("./steward-sync");

    const result = await syncUserFromSteward(baseParams);

    // The tenant was provisioned eagerly, exactly once, for the created org.
    expect(ensureStewardTenantCalls).toEqual(["org-new-1"]);
    // Signup completed normally.
    expect(result).toMatchObject(finalUserWithOrg);
    expect(orgDeleteCalls).toHaveLength(0);
  });

  test("FAIL-OPEN: signup still succeeds when Steward tenant provisioning rejects", async () => {
    ensureStewardTenantImpl = async (organizationId) => {
      ensureStewardTenantCalls.push(organizationId);
      throw new Error("Steward unreachable: connect ECONNREFUSED");
    };

    const { syncUserFromSteward } = await import("./steward-sync");

    // No throw: signup resolves with the user despite the Steward failure.
    const result = await syncUserFromSteward(baseParams);
    expect(result).toMatchObject(finalUserWithOrg);

    // The provisioning WAS attempted for the new org.
    expect(ensureStewardTenantCalls).toEqual(["org-new-1"]);

    // The org was NOT rolled back over a Steward failure (agent-provision
    // self-heals the tenant later; deleting the org would orphan the signup).
    expect(orgDeleteCalls).toHaveLength(0);

    // The failure is observable: a warning carrying the org id and the cause.
    const warn = loggerWarnCalls.find((c) =>
      c.message.includes("Eager Steward tenant provisioning failed"),
    );
    expect(warn).toBeDefined();
    expect(warn!.message).toContain("org-new-1");
    expect(warn!.message).toContain("Steward unreachable");
  });
});
