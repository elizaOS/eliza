/**
 * Fail-closed error semantics for wallet signup: an internal DB failure during
 * org/user creation must PROPAGATE (never swallow into a fabricated user),
 * while the designed unique-violation race recovers to the winning row and a
 * genuinely-found existing user returns distinctly. Collaborators are mocked to
 * inject the two failure shapes; the real findOrCreateUserByWalletAddress
 * control flow is under test (deterministic mocks, no live DB, no network).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.INITIAL_FREE_CREDITS = "0";
process.env.NODE_ENV ||= "test";

const EVM_ADDRESS = `0x${"cd".repeat(20)}`;

// Mutable behavior holders — each test rewires the collaborator responses.
let getByWallet: (addr: string) => Promise<unknown>;
let findBySlug: (slug: string) => Promise<unknown>;
let orgCreate: (input: unknown) => Promise<unknown>;
let userCreate: (input: { organization_id: string; role: string }) => Promise<unknown>;

mock.module("../../db/repositories/organizations", () => ({
  organizationsRepository: { findBySlug: (s: string) => findBySlug(s) },
}));
mock.module("../../db/repositories/users", () => ({
  usersRepository: { create: (i: { organization_id: string; role: string }) => userCreate(i) },
}));
mock.module("./organizations", () => ({
  organizationsService: { create: (i: unknown) => orgCreate(i) },
}));
mock.module("./users", () => ({
  usersService: {
    getByWalletAddressWithOrganization: (a: string) => getByWallet(a),
    findBySolanaWalletAddressWithOrganization: (a: string) => getByWallet(a),
  },
}));
mock.module("./credits", () => ({
  creditsService: {
    addCredits: () => {
      throw new Error("credits must not be touched with grantInitialCredits:false");
    },
  },
}));
mock.module("./signup-grant-guard", () => ({
  runWithSignupGrantIpCapDetailed: () => {
    throw new Error("grant guard must not run with grantInitialCredits:false");
  },
}));
mock.module("../runtime/request-context", () => ({ getClientIp: () => "1.2.3.4" }));

let walletSignup: typeof import("./wallet-signup");

beforeAll(async () => {
  walletSignup = await import("./wallet-signup");
});

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = mock(() => {
    throw new Error("no network allowed in this test");
  }) as never;
  // Sensible defaults; individual tests override.
  getByWallet = async () => null;
  findBySlug = async () => null;
  orgCreate = async () => {
    throw new Error("orgCreate not configured");
  };
  userCreate = async () => {
    throw new Error("userCreate not configured");
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("wallet-signup fail-closed error policy", () => {
  test("rejects malformed INITIAL_FREE_CREDITS instead of accepting a partial parse", async () => {
    process.env.INITIAL_FREE_CREDITS = "12abc";

    await expect(import(`./wallet-signup.ts?bad-credits-${Date.now()}`)).rejects.toThrow(
      /INITIAL_FREE_CREDITS/,
    );
  });

  test("rejects negative INITIAL_FREE_CREDITS instead of falling back to the default", async () => {
    process.env.INITIAL_FREE_CREDITS = "-1";

    await expect(import(`./wallet-signup.ts?negative-credits-${Date.now()}`)).rejects.toThrow(
      /INITIAL_FREE_CREDITS/,
    );
  });

  test("internal DB failure during org creation PROPAGATES (not swallowed into a fake user)", async () => {
    process.env.INITIAL_FREE_CREDITS = "0";
    getByWallet = async () => null;
    findBySlug = async () => null;
    orgCreate = async () => {
      throw new Error("connection terminated unexpectedly");
    };

    await expect(
      walletSignup.findOrCreateUserByWalletAddress(EVM_ADDRESS, { grantInitialCredits: false }),
    ).rejects.toThrow("connection terminated unexpectedly");
  });

  test("unique-violation on org create is a DESIGNED race recovery to the winning org", async () => {
    const racedOrg = { id: "org-raced", slug: "wallet-slug" };
    let slugCalls = 0;
    getByWallet = async () => null;
    findBySlug = async () => (slugCalls++ === 0 ? null : racedOrg);
    orgCreate = async () => {
      throw new Error("duplicate key value violates unique constraint");
    };
    userCreate = async (input) => ({
      id: "user-1",
      organization_id: input.organization_id,
      role: input.role,
    });

    const res = await walletSignup.findOrCreateUserByWalletAddress(EVM_ADDRESS, {
      grantInitialCredits: false,
    });

    expect(res.isNewAccount).toBe(true);
    expect(res.user.organization).toBe(racedOrg as never);
    expect(res.user.organization_id).toBe("org-raced");
  });

  test("internal DB failure during user creation PROPAGATES", async () => {
    const org = { id: "org-1", slug: "wallet-slug" };
    getByWallet = async () => null;
    findBySlug = async () => org;
    userCreate = async () => {
      throw new Error("deadlock detected");
    };

    await expect(
      walletSignup.findOrCreateUserByWalletAddress(EVM_ADDRESS, { grantInitialCredits: false }),
    ).rejects.toThrow("deadlock detected");
  });

  test("user-create unique-violation with unrecoverable re-fetch RETHROWS (never fabricates a user)", async () => {
    const org = { id: "org-1", slug: "wallet-slug" };
    // Both the initial lookup and the post-race re-fetch return null: the race
    // handler must not invent a user, it must rethrow the original error.
    getByWallet = async () => null;
    findBySlug = async () => org;
    userCreate = async () => {
      throw new Error("duplicate key value violates unique constraint users_wallet_address");
    };

    await expect(
      walletSignup.findOrCreateUserByWalletAddress(EVM_ADDRESS, { grantInitialCredits: false }),
    ).rejects.toThrow("duplicate key value violates unique constraint");
  });

  test("a genuinely-found existing user returns distinctly (isNewAccount=false, no creation)", async () => {
    const existing = { id: "u-existing", organization: { id: "o-existing" }, role: "owner" };
    getByWallet = async () => existing;

    const res = await walletSignup.findOrCreateUserByWalletAddress(EVM_ADDRESS, {
      grantInitialCredits: false,
    });

    expect(res.isNewAccount).toBe(false);
    expect(res.user).toBe(existing as never);
  });
});
