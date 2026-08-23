/**
 * How `syncUserFromSteward` canonicalizes a claimed wallet address and finds the
 * row that already holds it. Real `syncUserFromSteward` against mocked user
 * services, so the assertions are the exact values handed to the writers.
 *
 * A blanket `.toLowerCase()` is wrong for base58: `7xKX…AsU` and `7xkx…asu` are
 * different Solana keys, so folding one produces a string that matches no
 * existing row and is then stored as though it were a second wallet. The
 * observable damage is a SECOND Cloud account for one human — two rows, two
 * derived no-reply identities (`lib/oidc/wallet-email.ts`), and a git author
 * address at the forge that changes with the sign-in surface. EVM hex folds and
 * must keep folding; every EVM case below is a regression pin, not new behavior.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

/** Solana base58 with both cases present, as `/api/auth/siws/verify` stores it. */
const SOLANA = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const EVM_CHECKSUMMED = "0x1234567890AbcdEF1234567890aBcdef12345678";
const EVM_STORED = EVM_CHECKSUMMED.toLowerCase();

interface Call {
  method: string;
  args: unknown[];
}

const calls: Call[] = [];
const updateCalls: Array<{ id: string; data: Record<string, unknown> }> = [];

let userByStewardId: Record<string, unknown> | undefined;
let userByWalletFolded: Record<string, unknown> | undefined;
let userBySolanaWallet: Record<string, unknown> | undefined;
let userForWrite: Record<string, unknown> | undefined;

function record(method: string, ...args: unknown[]): void {
  calls.push({ method, args });
}

function argsFor(method: string): unknown[][] {
  return calls.filter((call) => call.method === method).map((call) => call.args);
}

mock.module("./services/users", () => ({
  usersService: {
    getByStewardId: async (id: string) => {
      record("getByStewardId", id);
      return userByStewardId;
    },
    getByStewardIdForWrite: async (id: string) => {
      record("getByStewardIdForWrite", id);
      return userForWrite;
    },
    getByEmailWithOrganization: async (email: string) => {
      record("getByEmailWithOrganization", email);
      return undefined;
    },
    getByWalletAddress: async (address: string) => {
      record("getByWalletAddress", address);
      return userByWalletFolded;
    },
    getByWalletAddressWithOrganization: async (address: string) => {
      record("getByWalletAddressWithOrganization", address);
      return userByWalletFolded;
    },
    getStewardIdentityForWrite: async () => undefined,
    create: async (data: unknown) => {
      record("create", data);
      throw new Error("a second account must not be created for a wallet that already has one");
    },
    update: async (id: string, data: Record<string, unknown>) => {
      updateCalls.push({ id, data });
      record("update", id, data);
      return undefined;
    },
    linkStewardId: async (userId: string, stewardUserId: string) => {
      record("linkStewardId", userId, stewardUserId);
    },
    upsertStewardIdentity: async (userId: string, stewardUserId: string) => {
      record("upsertStewardIdentity", userId, stewardUserId);
    },
  },
}));

mock.module("../db/repositories/users", () => ({
  usersRepository: {
    findPendingPhoneTelegramPersonalAccountConvergence: async () =>
      userByStewardId
        ? { status: "canonical_user" as const, user: userByStewardId }
        : { status: "not_found" as const },
    findBySolanaWalletAddressWithOrganization: async (address: string) => {
      record("findBySolanaWalletAddressWithOrganization", address);
      return userBySolanaWallet;
    },
    delete: async () => undefined,
  },
}));

mock.module("./utils/logger", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  redact: { id: (v: string) => v, orgId: (v: string) => v, userId: (v: string) => v },
}));

const { syncUserFromSteward } = await import("./steward-sync");

beforeEach(() => {
  calls.length = 0;
  updateCalls.length = 0;
  userByStewardId = undefined;
  userByWalletFolded = undefined;
  userBySolanaWallet = undefined;
  userForWrite = undefined;
});

describe("an existing account signing in again (step 1)", () => {
  test("keeps a Solana address byte-for-byte instead of folding it", async () => {
    // The row was created by /api/auth/siws/verify and holds the verbatim key.
    // Rewriting it here would silently re-derive the account's permanent no-reply
    // identity — the same account, a different git author address.
    const stored = {
      id: "user-solana",
      steward_user_id: "steward-solana",
      name: "solana-user",
      email: null,
      email_verified: false,
      wallet_address: SOLANA,
      wallet_chain_type: "solana",
      wallet_verified: true,
      organization_id: null,
    };
    userByStewardId = stored;
    userForWrite = stored;

    await syncUserFromSteward({
      stewardUserId: "steward-solana",
      walletAddress: SOLANA,
      walletChainType: "solana",
      name: "solana-user",
    });

    // A wallet-only claim always refreshes the profile (the stored email is
    // `null` and the claim carries none), so this write is the one that decides
    // what the column holds afterwards.
    expect(updateCalls.map((call) => call.data.wallet_address)).toEqual([SOLANA]);
  });

  test("still folds an EVM address, which is one wallet in two spellings", async () => {
    const stored = {
      id: "user-evm",
      steward_user_id: "steward-evm",
      name: "evm-user",
      email: null,
      email_verified: false,
      wallet_address: EVM_STORED,
      wallet_chain_type: "ethereum",
      wallet_verified: true,
      organization_id: null,
    };
    userByStewardId = stored;
    userForWrite = stored;

    await syncUserFromSteward({
      stewardUserId: "steward-evm",
      walletAddress: EVM_CHECKSUMMED,
      walletChainType: "ethereum",
      name: "evm-user",
    });

    expect(updateCalls.map((call) => call.data.wallet_address)).toEqual([EVM_STORED]);
  });
});

describe("a wallet-only Steward session for a wallet that already has an account (step 4)", () => {
  test("finds the Solana row with a case-SENSITIVE lookup and links it", async () => {
    // The folded lookup cannot see this row: it compares against the lowercased
    // string, which is a different key. Missing it here is what fell through to
    // step 5 and created the second account.
    userBySolanaWallet = {
      id: "user-solana",
      steward_user_id: "wallet:solana:" + SOLANA,
      wallet_address: SOLANA,
      wallet_chain_type: "solana",
      wallet_verified: true,
      organization: null,
    };
    userForWrite = { ...userBySolanaWallet, steward_user_id: "steward-new" };

    const synced = await syncUserFromSteward({
      stewardUserId: "steward-new",
      walletAddress: SOLANA,
      walletChainType: "solana",
    });

    expect(synced.id).toBe("user-solana");
    expect(argsFor("findBySolanaWalletAddressWithOrganization")).toEqual([[SOLANA]]);
    expect(argsFor("linkStewardId")).toEqual([["user-solana", "steward-new"]]);
    // The case-folding lookups must never be asked about a base58 address.
    expect(argsFor("getByWalletAddress")).toEqual([]);
    expect(argsFor("getByWalletAddressWithOrganization")).toEqual([]);
    expect(argsFor("create")).toEqual([]);
  });

  test("uses the folded lookup for EVM, with the lowercased address", async () => {
    userByWalletFolded = {
      id: "user-evm",
      steward_user_id: "wallet:evm:" + EVM_STORED,
      wallet_address: EVM_STORED,
      wallet_chain_type: "ethereum",
      wallet_verified: true,
      organization: null,
    };
    userForWrite = { ...userByWalletFolded, steward_user_id: "steward-new-evm" };

    const synced = await syncUserFromSteward({
      stewardUserId: "steward-new-evm",
      walletAddress: EVM_CHECKSUMMED,
      walletChainType: "ethereum",
    });

    expect(synced.id).toBe("user-evm");
    expect(argsFor("getByWalletAddressWithOrganization")).toEqual([[EVM_STORED]]);
    expect(argsFor("findBySolanaWalletAddressWithOrganization")).toEqual([]);
    expect(argsFor("create")).toEqual([]);
  });
});
