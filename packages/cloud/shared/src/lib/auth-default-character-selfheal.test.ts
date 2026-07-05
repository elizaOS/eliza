/**
 * Regression: session resolution must self-heal an account left without its
 * default Eliza character.
 *
 * The only create site for the default character is the one-time new-user
 * signup branch in steward-sync, and a create failure there is swallowed so
 * the signup survives. Every later login returns at the existing-user branch,
 * so before this heal existed such an account stayed character-less forever.
 * This drives the real getCurrentUserFromRequest and the real
 * ensureDefaultCharacter on a session-cache miss for an existing user whose
 * org has zero characters, and proves the default is re-seeded. Deterministic
 * harness: cache/token-verify/db services are in-memory mocks; no live model.
 */

import { describe, expect, mock, test } from "bun:test";

const existingUser = {
  id: "user-1",
  steward_user_id: "steward-123",
  email: "alice@example.com",
  name: "alice",
  role: "owner",
  is_active: true,
  organization_id: "org-1",
  organization: { id: "org-1", name: "alice's Organization", is_active: true },
};

let characterCreateCalls: Array<Record<string, unknown>> = [];

mock.module("./cache/client", () => ({
  cache: {
    get: async () => null,
    set: async () => undefined,
    del: async () => undefined,
  },
}));
mock.module("./auth/steward-client", () => ({
  verifyStewardTokenCached: async () => ({ userId: "steward-123" }),
  invalidateStewardTokenCache: async () => undefined,
}));
mock.module("./auth/playwright-test-session", () => ({
  isPlaywrightTestAuthEnabled: () => false,
  verifyPlaywrightTestSessionToken: () => null,
  PLAYWRIGHT_TEST_SESSION_COOKIE_NAME: "pw-test-session",
}));
mock.module("./auth/wallet-auth", () => ({
  verifyWalletSignature: async () => {
    throw new Error("unused in this test");
  },
}));
mock.module("./services/admin", () => ({ adminService: {} }));
mock.module("./services/user-sessions", () => ({
  userSessionsService: { getOrCreateSession: async () => ({ id: "sess-1" }) },
}));
mock.module("./services/users", () => ({
  usersService: {
    getByStewardId: async () => existingUser,
    getByStewardIdForWrite: async () => existingUser,
    getByEmailWithOrganization: async () => undefined,
    getByWalletAddress: async () => undefined,
    getByWalletAddressWithOrganization: async () => undefined,
    getWithOrganization: async () => existingUser,
    create: async () => existingUser,
    update: async () => undefined,
    linkStewardId: async () => undefined,
    upsertStewardIdentity: async () => undefined,
  },
}));
// The user already has their default API key, isolating the character heal.
mock.module("./services/api-keys", () => ({
  apiKeysService: {
    listByOrganization: async () => [{ user_id: "user-1" }],
    create: async () => ({ id: "key-1" }),
    ensureUserHasApiKey: async () => undefined,
    validateApiKey: async () => null,
    incrementUsageDebounced: () => undefined,
  },
}));
mock.module("./services/characters/characters", () => ({
  charactersService: {
    existsForOrganization: async () => false,
    create: async (data: Record<string, unknown>) => {
      characterCreateCalls.push(data);
      return { id: "char-1" };
    },
  },
}));
// Remaining steward-sync imports (auth.ts pulls the real module); inert stubs.
mock.module("./services/credits", () => ({
  creditsService: { addCredits: async () => ({ success: true }) },
}));
mock.module("./services/organizations", () => ({
  organizationsService: {
    getBySlug: async () => undefined,
    create: async () => ({ id: "org-1" }),
    update: async () => undefined,
    delete: async () => undefined,
  },
}));
mock.module("./services/invites", () => ({
  invitesService: { findPendingInviteByEmail: async () => undefined },
}));
mock.module("./services/discord", () => ({
  discordService: { logUserSignup: async () => undefined },
}));
mock.module("./services/email", () => ({
  emailService: { sendWelcomeEmail: async () => undefined },
}));

const { getCurrentUserFromRequest } = await import("./auth");

describe("session-resolution default-character self-heal", () => {
  test("cache miss for an existing user with a character-less org re-seeds the default Eliza", async () => {
    characterCreateCalls = [];

    const request = new Request("http://localhost/api/anything", {
      headers: { cookie: "steward-token=tok-abc" },
    });

    const user = await getCurrentUserFromRequest(request);
    expect(user?.id).toBe("user-1");

    // The heal is awaited inside session resolution (a void-fired promise can
    // be cancelled on Cloudflare Workers), so it has completed by now.
    expect(characterCreateCalls.length).toBe(1);
    expect(characterCreateCalls[0].name).toBe("Eliza");
    expect(characterCreateCalls[0].user_id).toBe("user-1");
    expect(characterCreateCalls[0].organization_id).toBe("org-1");
  });
});
