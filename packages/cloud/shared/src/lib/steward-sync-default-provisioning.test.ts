/**
 * Deterministic coverage for direct-signup post-commit provisioning.
 *
 * Worker callers return only after the canonical user, organization, identity,
 * required default API key, and an optional caller barrier are ready. waitUntil
 * owns only the independently self-healing default-character and Steward-tenant
 * tail; non-Worker callers retain strict inline provisioning without a barrier.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

let apiKeyProvision = deferred<void>();
let characterProvision = deferred<{ id: string }>();
let tenantProvision = deferred<{ tenantId: string }>();
let apiKeyProvisionStarted = false;
let characterProvisionStarted = false;
let tenantProvisionStarted = false;
let welcomeEmailStarted = false;
let discordLogStarted = false;
let freshUserCreateCompleted = false;
let freshIdentityInitializeCompleted = false;
let genericCreateAttempted = false;
let genericIdentityUpsertAttempted = false;
let finalIdentityReadAttempted = false;
let organizationCreateAttempts = 0;
let organizationSlugPreflightAttempts = 0;
const organizationCreateErrors: unknown[] = [];
const loggerErrors: Array<{ message: string; context?: unknown }> = [];
const loggerInfos: Array<{ message: string; context?: unknown }> = [];
const loggerWarnings: Array<{ message: string; context?: unknown }> = [];

const createdOrg = {
  id: "org-new-1",
  slug: "alice-abc123",
  credit_balance: "0.00",
};
const createdUser = {
  id: "user-new-1",
  organization_id: "org-new-1",
  steward_user_id: "steward-123",
  email: "alice@example.com",
  name: "alice",
  wallet_address: null,
  role: "owner",
  email_verified: true,
  wallet_verified: false,
};

mock.module("./services/credits", () => ({
  assertCreditRefundWithinReservation: () => {
    throw new Error("credit refund assertion is outside this test path");
  },
  assertValidCreditSettlementCosts: () => {
    throw new Error("credit settlement assertion is outside this test path");
  },
  creditsService: { addCredits: async () => ({ success: true }) },
}));
mock.module("./services/organizations", () => ({
  organizationsService: {
    getBySlug: async () => {
      organizationSlugPreflightAttempts += 1;
      return undefined;
    },
    create: async () => {
      organizationCreateAttempts += 1;
      const error = organizationCreateErrors.shift();
      if (error) throw error;
      return createdOrg;
    },
    update: async () => createdOrg,
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
    getByStewardIdForWrite: async () => {
      finalIdentityReadAttempted = true;
      return undefined;
    },
    createFreshStewardSignupUser: async () => {
      freshUserCreateCompleted = true;
      return createdUser;
    },
    initializeFreshStewardIdentity: async ({ user, stewardUserId }) => {
      expect(freshUserCreateCompleted).toBe(true);
      expect(user).toBe(createdUser);
      expect(stewardUserId).toBe("steward-123");
      freshIdentityInitializeCompleted = true;
    },
    create: async () => {
      genericCreateAttempted = true;
      return createdUser;
    },
    upsertStewardIdentity: async () => {
      genericIdentityUpsertAttempted = true;
    },
    update: async () => undefined,
    linkStewardId: async () => undefined,
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
mock.module("./services/invites", () => ({
  invitesService: { findPendingInviteByEmail: async () => undefined },
}));
mock.module("./services/api-keys", () => ({
  apiKeysService: {
    listByOrganization: async () => [],
    create: async () => ({ id: "key-1" }),
    provisionDefaultApiKey: async () => {
      expect(freshIdentityInitializeCompleted).toBe(true);
      expect(finalIdentityReadAttempted).toBe(false);
      apiKeyProvisionStarted = true;
      await apiKeyProvision.promise;
    },
  },
}));
mock.module("./services/characters/characters", () => ({
  charactersService: {
    hasHealthyCloudCharacterMirror: async () => false,
    create: async () => {
      expect(freshIdentityInitializeCompleted).toBe(true);
      expect(finalIdentityReadAttempted).toBe(false);
      characterProvisionStarted = true;
      return characterProvision.promise;
    },
  },
}));
mock.module("./services/steward-tenant-config", () => ({
  ensureStewardTenant: async () => {
    expect(freshIdentityInitializeCompleted).toBe(true);
    expect(finalIdentityReadAttempted).toBe(false);
    tenantProvisionStarted = true;
    return tenantProvision.promise;
  },
  resolveDefaultStewardTenantId: () => "elizacloud",
  resolveStewardTenantCredentials: async () => ({ tenantId: "elizacloud" }),
  DEFAULT_STEWARD_TENANT_ID: "elizacloud",
}));
mock.module("./services/discord", () => ({
  discordService: {
    logUserSignup: async () => {
      discordLogStarted = true;
    },
  },
}));
mock.module("./services/email", () => ({
  emailService: {
    sendWelcomeEmail: async () => {
      welcomeEmailStarted = true;
    },
  },
}));
mock.module("./utils/logger", () => ({
  logger: {
    debug: () => {},
    info: (message: string, context?: unknown) => {
      loggerInfos.push({ message, context });
    },
    error: (message: string, context?: unknown) => {
      loggerErrors.push({ message, context });
    },
    warn: (message: string, context?: unknown) => {
      loggerWarnings.push({ message, context });
    },
  },
  redact: {
    email: (value: string) => value,
    id: (value: string) => value,
    orgId: (value: string) => value,
    phone: (value: string) => value,
    userId: (value: string) => value,
    wallet: (value: string) => value,
  },
}));

const { syncUserFromSteward } = await import("./steward-sync");

const baseParams = {
  stewardUserId: "steward-123",
  email: "alice@example.com",
};

describe("syncUserFromSteward direct-signup provisioning", () => {
  beforeEach(() => {
    apiKeyProvision = deferred<void>();
    characterProvision = deferred<{ id: string }>();
    tenantProvision = deferred<{ tenantId: string }>();
    apiKeyProvisionStarted = false;
    characterProvisionStarted = false;
    tenantProvisionStarted = false;
    welcomeEmailStarted = false;
    discordLogStarted = false;
    freshUserCreateCompleted = false;
    freshIdentityInitializeCompleted = false;
    genericCreateAttempted = false;
    genericIdentityUpsertAttempted = false;
    finalIdentityReadAttempted = false;
    organizationCreateAttempts = 0;
    organizationSlugPreflightAttempts = 0;
    organizationCreateErrors.length = 0;
    loggerErrors.length = 0;
    loggerInfos.length = 0;
    loggerWarnings.length = 0;
  });

  test("Worker orders key, caller barrier, safe tail, then best-effort notifications", async () => {
    const background: Promise<unknown>[] = [];
    const callerBarrier = deferred<void>();
    let callerBarrierStarted = false;

    const syncPromise = syncUserFromSteward({
      ...baseParams,
      executionCtx: {
        waitUntil: (promise) => background.push(promise),
      },
      afterRequiredSignupProvisioning: async (user) => {
        expect(user.id).toBe("user-new-1");
        callerBarrierStarted = true;
        await callerBarrier.promise;
      },
    });
    await waitFor(() => apiKeyProvisionStarted);

    expect(freshUserCreateCompleted).toBe(true);
    expect(freshIdentityInitializeCompleted).toBe(true);
    expect(genericCreateAttempted).toBe(false);
    expect(genericIdentityUpsertAttempted).toBe(false);
    expect(finalIdentityReadAttempted).toBe(false);
    expect(organizationCreateAttempts).toBe(1);
    expect(organizationSlugPreflightAttempts).toBe(0);
    expect(background).toHaveLength(0);
    expect(characterProvisionStarted).toBe(false);
    expect(tenantProvisionStarted).toBe(false);
    expect(callerBarrierStarted).toBe(false);
    expect(welcomeEmailStarted).toBe(false);
    expect(discordLogStarted).toBe(false);

    apiKeyProvision.resolve();
    await waitFor(() => callerBarrierStarted);
    expect(background).toHaveLength(0);
    expect(characterProvisionStarted).toBe(false);
    expect(tenantProvisionStarted).toBe(false);
    expect(welcomeEmailStarted).toBe(false);
    expect(discordLogStarted).toBe(false);

    callerBarrier.resolve();
    const user = await syncPromise;

    expect(user.id).toBe("user-new-1");
    expect(user.postCommitProvisioningDeferred).toBe(true);
    expect(background).toHaveLength(1);
    await waitFor(() => characterProvisionStarted && tenantProvisionStarted);
    expect(welcomeEmailStarted).toBe(true);
    expect(discordLogStarted).toBe(true);

    characterProvision.resolve({ id: "char-1" });
    tenantProvision.resolve({ tenantId: "elizacloud-org-new-1" });
    await expect(background[0]).resolves.toBeUndefined();
    expect(loggerInfos).toContainEqual({
      message: "[StewardSync] Direct-signup post-commit provisioning settled",
      context: expect.objectContaining({
        organizationId: "org-new-1",
        userId: "user-new-1",
        outcomes: [
          { operation: "default character", status: "fulfilled" },
          { operation: "Steward tenant", status: "fulfilled" },
        ],
      }),
    });
  });

  test("Worker tail contains only safe resources and isolates both failures", async () => {
    const background: Promise<unknown>[] = [];

    const syncPromise = syncUserFromSteward({
      ...baseParams,
      executionCtx: {
        waitUntil: (promise) => background.push(promise),
      },
    });
    await waitFor(() => apiKeyProvisionStarted);
    apiKeyProvision.resolve();
    const user = await syncPromise;
    expect(user.postCommitProvisioningDeferred).toBe(true);
    await waitFor(() => characterProvisionStarted && tenantProvisionStarted);

    characterProvision.reject(new Error("character unavailable"));
    tenantProvision.reject(new Error("tenant unavailable"));

    await expect(background[0]).resolves.toBeUndefined();
    expect(loggerErrors.some(({ message }) => message.includes("default API key"))).toBe(false);
    expect(
      loggerErrors.some(
        ({ message, context }) =>
          message.includes("default character") ||
          String(context).includes("character unavailable"),
      ),
    ).toBe(true);
    expect(
      loggerWarnings.some(
        ({ message }) =>
          message.includes("Steward tenant") && message.includes("tenant unavailable"),
      ),
    ).toBe(true);
  });

  test("Worker required API-key rejection fails signup without a deferred-ready result or tail", async () => {
    const background: Promise<unknown>[] = [];
    const syncPromise = syncUserFromSteward({
      ...baseParams,
      executionCtx: {
        waitUntil: (promise) => background.push(promise),
      },
    });
    await waitFor(() => apiKeyProvisionStarted);

    apiKeyProvision.reject(new Error("strict Worker default-key failure"));

    await expect(syncPromise).rejects.toThrow("strict Worker default-key failure");
    expect(background).toHaveLength(0);
    expect(characterProvisionStarted).toBe(false);
    expect(tenantProvisionStarted).toBe(false);
  });

  test("non-Worker fallback keeps default API-key failure strict and inline", async () => {
    const syncPromise = syncUserFromSteward(baseParams);
    await waitFor(() => apiKeyProvisionStarted);

    expect(characterProvisionStarted).toBe(false);
    expect(tenantProvisionStarted).toBe(false);
    apiKeyProvision.reject(new Error("strict default-key failure"));

    await expect(syncPromise).rejects.toThrow("strict default-key failure");
    expect(characterProvisionStarted).toBe(false);
    expect(tenantProvisionStarted).toBe(false);
  });

  test("retries the exact organization slug constraint without a preflight read", async () => {
    organizationCreateErrors.push(
      Object.assign(new Error("generated slug collision"), {
        code: "23505",
        constraint: "organizations_slug_unique",
      }),
    );
    apiKeyProvision.resolve();
    characterProvision.resolve({ id: "char-1" });
    tenantProvision.resolve({ tenantId: "elizacloud-org-new-1" });

    await expect(syncUserFromSteward(baseParams)).resolves.toMatchObject({
      id: "user-new-1",
      organization: { id: "org-new-1" },
    });

    expect(organizationCreateAttempts).toBe(2);
    expect(organizationSlugPreflightAttempts).toBe(0);
    expect(freshIdentityInitializeCompleted).toBe(true);
  });

  test("does not retry an unrelated organization unique violation", async () => {
    organizationCreateErrors.push(
      Object.assign(new Error("unrelated organization authority collision"), {
        code: "23505",
        constraint: "organizations_steward_tenant_id_unique",
      }),
    );

    await expect(syncUserFromSteward(baseParams)).rejects.toThrow(
      "unrelated organization authority collision",
    );
    expect(organizationCreateAttempts).toBe(1);
    expect(organizationSlugPreflightAttempts).toBe(0);
    expect(freshUserCreateCompleted).toBe(false);
  });
});
