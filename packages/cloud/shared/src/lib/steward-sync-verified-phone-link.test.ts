/**
 * Exercises mature email/wallet account convergence through the real Steward
 * sync decision tree with deterministic service boundaries. A verified phone
 * must be projected before the Steward subject changes, remain idempotent on
 * retry, and fail closed on another account's phone ownership.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Phone convergence is independent of the separately governed signup-grant
// policy; keep this suite on the zero-credit branch so it exercises only the
// identity transaction and its unique-conflict recovery.
process.env.INITIAL_FREE_CREDITS = "0";

const PHONE = "+14155552711";
const EMAIL = "phone-owner@example.com";
const WALLET = "0x1234567890abcdef1234567890abcdef12345678";

type TestUser = Record<string, unknown> & {
  id: string;
  steward_user_id: string;
  organization_id: string;
  organization: { id: string; name: string };
  phone_number: string | null;
  phone_verified: boolean;
};

const calls: Array<{ method: string; args: unknown[] }> = [];
let emailUser: TestUser | undefined;
let walletUser: TestUser | undefined;
let emailLookupCount = 0;
let emailLookupDelay = 0;
let createConflict = false;
let phoneLinkConflict = false;

function record(method: string, ...args: unknown[]): void {
  calls.push({ method, args });
}

function callsFor(method: string): unknown[][] {
  return calls.filter((call) => call.method === method).map((call) => call.args);
}

function linkedStewardUser(stewardUserId: string): TestUser | undefined {
  return [emailUser, walletUser].find((user) => user?.steward_user_id === stewardUserId);
}

const promotePhonePersonalAccountToSteward = mock(async () => ({ status: "not_found" as const }));
const findPendingPhoneTelegramPersonalAccountConvergence = mock(
  async ({ stewardUserId }: { stewardUserId: string }) => {
    const user = linkedStewardUser(stewardUserId);
    return user ? { status: "canonical_user" as const, user } : { status: "not_found" as const };
  },
);
const linkVerifiedPhone = mock(async (userId: string, phoneNumber: string) => {
  record("linkVerifiedPhone", userId, phoneNumber);
  if (phoneLinkConflict) {
    throw Object.assign(new Error("duplicate phone owner"), {
      code: "23505",
      constraint: "users_phone_number_unique",
    });
  }
  const user = [emailUser, walletUser].find((candidate) => candidate?.id === userId);
  if (!user) return undefined;
  user.phone_number = phoneNumber;
  user.phone_verified = true;
  return user;
});

mock.module("../db/repositories/users", () => ({
  usersRepository: {
    delete: async () => undefined,
    findPendingPhoneTelegramPersonalAccountConvergence,
    findBySolanaWalletAddressWithOrganization: async () => undefined,
    linkVerifiedPhone,
    promotePhonePersonalAccountToSteward,
  },
}));

mock.module("./services/users", () => ({
  usersService: {
    createFreshStewardSignupUser: async () => {
      record("create");
      if (createConflict) {
        throw Object.assign(new Error("duplicate account"), { code: "23505" });
      }
      throw new Error("unexpected new account creation");
    },
    initializeFreshStewardIdentity: async () => undefined,
    create: async () => {
      record("create");
      if (createConflict) {
        throw Object.assign(new Error("duplicate account"), { code: "23505" });
      }
      throw new Error("unexpected new account creation");
    },
    getByEmailWithOrganization: async (email: string) => {
      record("getByEmailWithOrganization", email);
      emailLookupCount += 1;
      return emailLookupCount <= emailLookupDelay ? undefined : emailUser;
    },
    getByStewardId: async (stewardUserId: string) => linkedStewardUser(stewardUserId),
    getByStewardIdForWrite: async (stewardUserId: string) => linkedStewardUser(stewardUserId),
    getByWalletAddressWithOrganization: async (walletAddress: string) => {
      record("getByWalletAddressWithOrganization", walletAddress);
      return walletUser;
    },
    getStewardIdentityForWrite: async () => undefined,
    linkStewardId: async (userId: string, stewardUserId: string) => {
      record("linkStewardId", userId, stewardUserId);
      const user = [emailUser, walletUser].find((candidate) => candidate?.id === userId);
      if (user) user.steward_user_id = stewardUserId;
    },
    update: async (userId: string, data: Record<string, unknown>) => {
      record("update", userId, data);
      const user = [emailUser, walletUser].find((candidate) => candidate?.id === userId);
      if (user) Object.assign(user, data);
      return user;
    },
    upsertStewardIdentity: async (userId: string, stewardUserId: string) => {
      record("upsertStewardIdentity", userId, stewardUserId);
    },
  },
}));

mock.module("./services/invites", () => ({
  invitesService: { findPendingInviteByEmail: async () => undefined },
}));

mock.module("./services/organizations", () => ({
  organizationsService: {
    create: async () => ({ id: "discarded-org", name: "Discarded", credit_balance: "0.00" }),
    delete: async (id: string) => record("deleteOrganization", id),
    getBySlug: async () => undefined,
  },
}));

mock.module("./services/steward-tenant-config", () => ({
  ensureStewardTenant: async () => undefined,
}));

mock.module("./utils/logger", () => ({
  logger: {
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  },
}));

const { StewardPhoneAccountConflictError, syncUserFromSteward } = await import("./steward-sync");

function matureUser(overrides: Partial<TestUser>): TestUser {
  return {
    id: "mature-user",
    steward_user_id: "legacy-subject",
    organization_id: "mature-org",
    organization: { id: "mature-org", name: "Mature Org" },
    phone_number: null,
    phone_verified: false,
    name: "Phone Owner",
    email: null,
    email_verified: false,
    wallet_address: null,
    wallet_chain_type: null,
    wallet_verified: false,
    role: "owner",
    is_active: true,
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
  emailUser = undefined;
  walletUser = undefined;
  emailLookupCount = 0;
  emailLookupDelay = 0;
  createConflict = false;
  phoneLinkConflict = false;
  findPendingPhoneTelegramPersonalAccountConvergence.mockReset();
  findPendingPhoneTelegramPersonalAccountConvergence.mockImplementation(
    async ({ stewardUserId }) => {
      const user = linkedStewardUser(stewardUserId);
      return user ? { status: "canonical_user", user } : { status: "not_found" };
    },
  );
  promotePhonePersonalAccountToSteward.mockReset();
  promotePhonePersonalAccountToSteward.mockResolvedValue({ status: "not_found" });
  linkVerifiedPhone.mockClear();
});

describe("syncUserFromSteward verified-phone mature-account convergence", () => {
  test("links a verified phone before linking an existing email account", async () => {
    emailUser = matureUser({ email: EMAIL, email_verified: true });

    const result = await syncUserFromSteward({
      stewardUserId: "steward-email",
      email: EMAIL,
      verifiedPhone: PHONE,
    });

    expect(result.id).toBe("mature-user");
    expect(result.phone_number).toBe(PHONE);
    expect(result.phone_verified).toBe(true);
    expect(callsFor("linkVerifiedPhone")).toEqual([["mature-user", PHONE]]);
    expect(callsFor("update")[0]?.[1]).toMatchObject({ steward_user_id: "steward-email" });
    expect(calls.findIndex((call) => call.method === "linkVerifiedPhone")).toBeLessThan(
      calls.findIndex((call) => call.method === "upsertStewardIdentity"),
    );
  });

  test("links a verified phone before linking an existing wallet account", async () => {
    walletUser = matureUser({
      id: "wallet-user",
      wallet_address: WALLET,
      wallet_chain_type: "ethereum",
      wallet_verified: true,
    });

    const result = await syncUserFromSteward({
      stewardUserId: "steward-wallet",
      walletAddress: WALLET,
      walletChainType: "ethereum",
      verifiedPhone: PHONE,
    });

    expect(result.id).toBe("wallet-user");
    expect(result.phone_number).toBe(PHONE);
    expect(callsFor("linkVerifiedPhone")).toEqual([["wallet-user", PHONE]]);
    expect(callsFor("linkStewardId")).toEqual([["wallet-user", "steward-wallet"]]);
    expect(calls.findIndex((call) => call.method === "linkVerifiedPhone")).toBeLessThan(
      calls.findIndex((call) => call.method === "linkStewardId"),
    );
  });

  test("reasserts the same phone projection idempotently on repeat sign-in", async () => {
    emailUser = matureUser({ email: EMAIL, email_verified: true });
    const params = {
      stewardUserId: "steward-email",
      email: EMAIL,
      verifiedPhone: PHONE,
    };

    await syncUserFromSteward(params);
    await syncUserFromSteward(params);

    expect(callsFor("linkVerifiedPhone")).toEqual([
      ["mature-user", PHONE],
      ["mature-user", PHONE],
    ]);
    expect(emailUser).toMatchObject({
      steward_user_id: "steward-email",
      phone_number: PHONE,
      phone_verified: true,
    });
  });

  test("fails closed before Steward linking when another account owns the phone", async () => {
    emailUser = matureUser({ email: EMAIL, email_verified: true });
    phoneLinkConflict = true;

    await expect(
      syncUserFromSteward({
        stewardUserId: "steward-email",
        email: EMAIL,
        verifiedPhone: PHONE,
      }),
    ).rejects.toMatchObject<Partial<InstanceType<typeof StewardPhoneAccountConflictError>>>({
      reason: "verified_phone_unique_conflict",
    });
    expect(emailUser.steward_user_id).toBe("legacy-subject");
    expect(callsFor("update")).toHaveLength(0);
    expect(callsFor("upsertStewardIdentity")).toHaveLength(0);
  });

  test("fails closed when the mature account already has a different verified phone", async () => {
    emailUser = matureUser({
      email: EMAIL,
      email_verified: true,
      phone_number: "+14155552712",
      phone_verified: true,
    });
    linkVerifiedPhone.mockRejectedValueOnce(
      Object.assign(new Error("verified phone mismatch"), {
        code: "VERIFIED_PHONE_MISMATCH",
      }),
    );

    await expect(
      syncUserFromSteward({
        stewardUserId: "steward-email",
        email: EMAIL,
        verifiedPhone: PHONE,
      }),
    ).rejects.toMatchObject<Partial<InstanceType<typeof StewardPhoneAccountConflictError>>>({
      reason: "verified_phone_mismatch",
    });
    expect(emailUser.steward_user_id).toBe("legacy-subject");
    expect(callsFor("upsertStewardIdentity")).toHaveLength(0);
  });

  test("links an unowned verified phone to the existing Steward subject without attempting promotion", async () => {
    emailUser = matureUser({ steward_user_id: "steward-existing" });
    // Real repository behavior for this state: the subject already owns a
    // canonical row, so promotion would misreport it as owned by another user
    // and 409 the first verified-phone session (#19365).
    promotePhonePersonalAccountToSteward.mockResolvedValue({
      status: "steward_subject_owned_by_other_user" as never,
    });

    const result = await syncUserFromSteward({
      stewardUserId: "steward-existing",
      verifiedPhone: PHONE,
    });

    expect(result.id).toBe("mature-user");
    expect(result.phone_number).toBe(PHONE);
    expect(result.phone_verified).toBe(true);
    expect(promotePhonePersonalAccountToSteward).not.toHaveBeenCalled();
    expect(callsFor("linkVerifiedPhone")).toEqual([["mature-user", PHONE]]);
  });

  test("repeats the existing-subject phone link idempotently on retry", async () => {
    emailUser = matureUser({ steward_user_id: "steward-existing" });
    promotePhonePersonalAccountToSteward.mockResolvedValue({
      status: "steward_subject_owned_by_other_user" as never,
    });
    const params = { stewardUserId: "steward-existing", verifiedPhone: PHONE };

    const first = await syncUserFromSteward(params);
    const retry = await syncUserFromSteward(params);

    expect(first.id).toBe("mature-user");
    expect(retry.id).toBe("mature-user");
    expect(promotePhonePersonalAccountToSteward).not.toHaveBeenCalled();
    expect(callsFor("create")).toHaveLength(0);
    expect(callsFor("linkVerifiedPhone")).toEqual([
      ["mature-user", PHONE],
      ["mature-user", PHONE],
    ]);
  });

  test("fails closed for an existing subject when another account owns the phone", async () => {
    emailUser = matureUser({ steward_user_id: "steward-existing" });
    phoneLinkConflict = true;

    await expect(
      syncUserFromSteward({
        stewardUserId: "steward-existing",
        verifiedPhone: PHONE,
      }),
    ).rejects.toMatchObject<Partial<InstanceType<typeof StewardPhoneAccountConflictError>>>({
      reason: "verified_phone_unique_conflict",
    });
    expect(emailUser).toMatchObject({ phone_number: null, phone_verified: false });
    expect(promotePhonePersonalAccountToSteward).not.toHaveBeenCalled();
  });

  test("links the verified phone in unique-conflict recovery before returning the mature row", async () => {
    emailUser = matureUser({ email: EMAIL, email_verified: true });
    emailLookupDelay = 1;
    createConflict = true;

    const result = await syncUserFromSteward({
      stewardUserId: "steward-recovered",
      email: EMAIL,
      verifiedPhone: PHONE,
    });

    expect(result.id).toBe("mature-user");
    expect(callsFor("create")).toHaveLength(1);
    expect(callsFor("linkVerifiedPhone")).toEqual([["mature-user", PHONE]]);
    expect(callsFor("deleteOrganization")).toEqual([["discarded-org"]]);
    expect(emailUser).toMatchObject({
      steward_user_id: "steward-recovered",
      phone_number: PHONE,
      phone_verified: true,
    });
  });
});
