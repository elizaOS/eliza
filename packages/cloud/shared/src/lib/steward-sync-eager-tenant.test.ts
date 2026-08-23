/**
 * Regression tests for per-org Steward tenant provisioning at signup
 * (#14645).
 *
 * Steward tenants used to be created only at agent-provision time, leaving
 * newly created organizations without their downstream Steward resources.
 * Follow-up receipts on #14645 established that `/user/me/tenants` returning
 * 403 for a tenant-scoped session is expected and is swallowed by
 * `@stwd/react@0.7.2`; it does not clear auth and was not the staging login-loop
 * cause. Tenant provisioning remains an important post-commit readiness and
 * self-heal invariant, but it is not part of cookie/session authority.
 *
 * Properties asserted here:
 *
 *   (a) non-Worker signup provisions the new org inline,
 *   (b) a Worker owns the idempotent provisioning tail through waitUntil, and
 *   (c) FAIL-OPEN: Steward failure never rolls back the committed signup and
 *       remains observable for the later agent-provision/sign-in self-heal.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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

// Branch-1 (existing user) fixture: field-for-field match with baseParams so
// the profile-refresh `shouldUpdate` stays false and the sync goes straight to
// the tenant self-heal + return.
const existingUser = {
  id: "user-existing-1",
  organization_id: "org-existing-1",
  name: "alice",
  email: "alice@example.com",
  email_verified: true,
  wallet_address: undefined,
  wallet_chain_type: undefined,
  wallet_verified: false,
};
// Default = new-user path (no existing user); existing-user tests override.
let getByStewardIdImpl: () => Promise<unknown> = async () => undefined;

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
  assertCreditRefundWithinReservation: () => {
    throw new Error("credit refund assertion is outside this test path");
  },
  assertValidCreditSettlementCosts: () => {
    throw new Error("credit settlement assertion is outside this test path");
  },
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
    getByStewardId: () => getByStewardIdImpl(),
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
    hasHealthyCloudCharacterMirror: async () => false,
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

mock.module("../db/repositories/users", () => ({
  usersRepository: {
    delete: async () => undefined,
    findPendingPhoneTelegramPersonalAccountConvergence: async () => ({
      status: "not_found" as const,
    }),
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
    getByStewardIdImpl = async () => undefined;
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

  test("Worker signup hands the eager tenant call to waitUntil", async () => {
    const tenant = deferred<{
      tenantId: string;
      apiKey: string;
      isNew: boolean;
    }>();
    ensureStewardTenantImpl = async (organizationId) => {
      ensureStewardTenantCalls.push(organizationId);
      return tenant.promise;
    };
    const background: Promise<unknown>[] = [];

    const { syncUserFromSteward } = await import("./steward-sync");
    const result = await syncUserFromSteward({
      ...baseParams,
      executionCtx: {
        waitUntil: (promise) => background.push(promise),
      },
    });

    expect(result).toMatchObject(finalUserWithOrg);
    expect(ensureStewardTenantCalls).toEqual(["org-new-1"]);
    expect(background).toHaveLength(1);

    tenant.resolve({
      tenantId: "elizacloud-org-new-1",
      apiKey: "tenant-key",
      isNew: true,
    });
    await expect(background[0]).resolves.toBeUndefined();
  });

  // ── #14645 residual: existing-org self-heal on sign-in ──────────────────
  // #14869's new-user call did not cover organizations created before it.
  // Returning users therefore retain the sign-in self-heal so legacy orgs
  // converge before downstream agent provisioning needs the tenant.

  test("existing-user sign-in self-heals the org's Steward tenant", async () => {
    getByStewardIdImpl = async () => existingUser;

    const { syncUserFromSteward } = await import("./steward-sync");
    const result = await syncUserFromSteward(baseParams);

    // The heal was attempted exactly once, for the EXISTING org.
    expect(ensureStewardTenantCalls).toEqual(["org-existing-1"]);
    // Sign-in resolved with the existing user (no new org/user creation).
    expect(result).toMatchObject({ id: "user-existing-1" });
  });

  test("FAIL-OPEN: existing-user sign-in still succeeds when the tenant heal rejects", async () => {
    getByStewardIdImpl = async () => existingUser;
    ensureStewardTenantImpl = async (organizationId) => {
      ensureStewardTenantCalls.push(organizationId);
      throw new Error("Steward unreachable: connect ECONNREFUSED");
    };

    const { syncUserFromSteward } = await import("./steward-sync");

    // No throw: a Steward outage must not turn sign-in into an error.
    const result = await syncUserFromSteward(baseParams);
    expect(result).toMatchObject({ id: "user-existing-1" });
    expect(ensureStewardTenantCalls).toEqual(["org-existing-1"]);

    // Observable: a warning carrying the org id and the cause.
    const warn = loggerWarnCalls.find((c) => c.message.includes("Sign-in tenant self-heal failed"));
    expect(warn).toBeDefined();
    expect(warn!.message).toContain("org-existing-1");
    expect(warn!.message).toContain("Steward unreachable");
  });

  test("existing user without an organization_id skips the heal", async () => {
    getByStewardIdImpl = async () => ({ ...existingUser, organization_id: null });

    const { syncUserFromSteward } = await import("./steward-sync");
    const result = await syncUserFromSteward(baseParams);

    expect(ensureStewardTenantCalls).toHaveLength(0);
    expect(result).toMatchObject({ id: "user-existing-1" });
  });
});
