/**
 * Self-heal contract of ensureDefaultCharacter: a default-character create
 * that fails (and is swallowed so signup/session resolution survive) must be
 * re-attempted by a later invocation until the org has its default Eliza —
 * never left as a permanently character-less account. Deterministic harness:
 * the characters service is a controllable in-memory mock; no live model.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let orgCharacters: Array<{ id: string }> = [];
let createFailuresRemaining = 0;
let createCalls: Array<Record<string, unknown>> = [];

mock.module("./services/characters/characters", () => ({
  charactersService: {
    existsForOrganization: async () => orgCharacters.length > 0,
    create: async (data: Record<string, unknown>) => {
      createCalls.push(data);
      if (createFailuresRemaining > 0) {
        createFailuresRemaining--;
        throw new Error("db write failed");
      }
      const created = { id: `char-${createCalls.length}` };
      orgCharacters.push(created);
      return created;
    },
  },
}));

// steward-sync's other service imports; inert stubs so the module loads.
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
mock.module("./services/users", () => ({
  usersService: {
    getByStewardId: async () => undefined,
    getByStewardIdForWrite: async () => undefined,
    getByEmailWithOrganization: async () => undefined,
    getByWalletAddress: async () => undefined,
    getByWalletAddressWithOrganization: async () => undefined,
    create: async () => ({ id: "user-1" }),
    update: async () => undefined,
    linkStewardId: async () => undefined,
    upsertStewardIdentity: async () => undefined,
  },
}));
mock.module("./services/invites", () => ({
  invitesService: { findPendingInviteByEmail: async () => undefined },
}));
mock.module("./services/api-keys", () => ({
  apiKeysService: {
    listByOrganization: async () => [],
    create: async () => ({ id: "key-1" }),
  },
}));
mock.module("./services/discord", () => ({
  discordService: { logUserSignup: async () => undefined },
}));
mock.module("./services/email", () => ({
  emailService: { sendWelcomeEmail: async () => undefined },
}));

const { ensureDefaultCharacter } = await import("./steward-sync");

beforeEach(() => {
  orgCharacters = [];
  createFailuresRemaining = 0;
  createCalls = [];
});

describe("ensureDefaultCharacter self-heal", () => {
  test("a swallowed create failure is retried by the next run, which seeds the default", async () => {
    createFailuresRemaining = 1;

    // Signup-time run: the create fails; the helper must resolve (signup
    // survives) but the org is left without its default character.
    await ensureDefaultCharacter("user-1", "org-1");
    expect(createCalls.length).toBe(1);
    expect(orgCharacters.length).toBe(0);

    // Session-time re-run (auth.ts fires this on every session-cache miss):
    // the org still has zero characters, so the create is re-attempted and
    // the default Eliza is seeded from the template.
    await ensureDefaultCharacter("user-1", "org-1");
    expect(createCalls.length).toBe(2);
    expect(orgCharacters.length).toBe(1);
    expect(createCalls[1].name).toBe("Eliza");
    expect(createCalls[1].user_id).toBe("user-1");
    expect(createCalls[1].organization_id).toBe("org-1");
  });

  test("no-op when the organization already has a character", async () => {
    orgCharacters = [{ id: "char-existing" }];
    await ensureDefaultCharacter("user-1", "org-1");
    expect(createCalls.length).toBe(0);
  });

  test("never rejects, so void-firing from session resolution is safe", async () => {
    createFailuresRemaining = 1;
    await expect(ensureDefaultCharacter("user-1", "org-1")).resolves.toBeUndefined();
  });
});
