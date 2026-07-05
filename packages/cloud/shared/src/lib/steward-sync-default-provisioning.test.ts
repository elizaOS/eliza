/**
 * Regression: brand-new-user default provisioning must COMPLETE before
 * syncUserFromSteward returns.
 *
 * The new-user branch provisions a default API key + a default Eliza character.
 * These used to be fire-and-forget (`void ensureUserHasApiKey(...)` /
 * `void ensureDefaultCharacter(...)`). This code runs on Cloudflare Workers,
 * where a promise not registered via executionCtx.waitUntil may be cancelled
 * once the response returns — and syncUserFromSteward is a shared-lib function
 * with no request context to reach waitUntil. A cancelled promise left the new
 * user with no default character until the session-cache-miss self-heal in
 * auth.ts runs (every later login returns at the existing-user branch, never
 * re-entering this one-time signup path). Fix: await both.
 *
 * The api-key and character create() mocks below are deferred promises whose
 * settlement the test controls — modeling slow DB writes that would still be
 * in flight when a fire-and-forget caller returned. The test proves the
 * returned promise stays pending until BOTH creates have completed.
 */

import { describe, expect, mock, test } from "bun:test";

// A deferred whose settlement we control, to model a slow DB write that would
// still be in flight if the caller did NOT await it.
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const apiKeyCreate = deferred<{ id: string }>();
const characterCreate = deferred<{ id: string }>();
let apiKeyCreateStarted = false;
let apiKeyCreateResolved = false;
let characterCreateResolved = false;

const createdOrg = {
  id: "org-new-1",
  slug: "alice-abc123",
  credit_balance: "0.00",
};
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
  creditsService: { addCredits: async () => ({ success: true }) },
}));
mock.module("./services/organizations", () => ({
  organizationsService: {
    getBySlug: async () => undefined,
    create: async () => createdOrg,
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
    getByStewardIdForWrite: async () => finalUserWithOrg,
    create: async () => createdUser,
    update: async () => undefined,
    linkStewardId: async () => undefined,
    upsertStewardIdentity: async () => undefined,
  },
}));
mock.module("./services/invites", () => ({
  invitesService: { findPendingInviteByEmail: async () => undefined },
}));
mock.module("./services/api-keys", () => {
  const create = async () => {
    apiKeyCreateStarted = true;
    const v = await apiKeyCreate.promise;
    apiKeyCreateResolved = true;
    return v;
  };
  return {
    apiKeysService: {
      listByOrganization: async () => [],
      create,
      // Mirrors steward-sync's default-key provisioner: resolves only once the
      // deferred key create has completed, so the await-not-fire-and-forget
      // proof below still measures the provisioning write itself.
      provisionDefaultApiKey: async () => {
        await create();
      },
    },
  };
});
mock.module("./services/characters/characters", () => ({
  charactersService: {
    existsForOrganization: async () => false,
    create: async () => {
      const v = await characterCreate.promise;
      characterCreateResolved = true;
      return v;
    },
  },
}));
mock.module("./services/discord", () => ({
  discordService: { logUserSignup: async () => undefined },
}));
mock.module("./services/email", () => ({
  emailService: { sendWelcomeEmail: async () => undefined },
}));

const { syncUserFromSteward } = await import("./steward-sync");

describe("syncUserFromSteward default provisioning (await, not fire-and-forget)", () => {
  test("does NOT resolve until both the api-key and character creates have completed", async () => {
    let syncResolved = false;
    const syncPromise = syncUserFromSteward({
      stewardUserId: "steward-123",
      email: "alice@example.com",
    }).then((u) => {
      syncResolved = true;
      return u;
    });

    // Let microtasks drain: the api-key create has started but is still in
    // flight, so the sync must still be pending (it awaits provisioning).
    await new Promise((r) => setTimeout(r, 10));
    expect(apiKeyCreateStarted).toBe(true);
    expect(syncResolved).toBe(false);

    // Settle the api key: the character create is still pending, so the sync
    // must remain pending too.
    apiKeyCreate.resolve({ id: "key-1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(apiKeyCreateResolved).toBe(true);
    expect(syncResolved).toBe(false);

    // Settle the character: NOW the sync may resolve.
    characterCreate.resolve({ id: "char-1" });
    const user = await syncPromise;
    expect(characterCreateResolved).toBe(true);
    expect(syncResolved).toBe(true);
    expect(user.id).toBe("user-new-1");
  });
});
