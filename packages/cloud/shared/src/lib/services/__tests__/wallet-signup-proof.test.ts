/**
 * What `users.wallet_verified` means after a wallet signup, against a REAL
 * PGlite database — no repository mocking.
 *
 * `findOrCreate*ByWalletAddress` is shared by callers that PROVED control of the
 * address (the SIWE/SIWS sign-ins, the signed wallet-auth header) and callers
 * that were merely handed one in a request body (x402 topup, agent
 * provisioning). It used to mark every row verified, so naming a stranger's
 * public wallet opened an account asserting control of it — and the OIDC layer
 * turns that flag into a permanent no-reply identity at a relying party
 * (`lib/oidc/subject.ts`). The rule pinned here: the flag follows the caller's
 * proof, and proof only ever moves upward.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

const PGLITE_TIMEOUT = 120_000;

const NAMED_EVM = `0x${"cd".repeat(20)}`;
const PROVEN_EVM = `0x${"ef".repeat(20)}`;
const UPGRADED_EVM = `0x${"1a".repeat(20)}`;
const NAMED_SOLANA = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const PROVEN_SOLANA = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";

let pgliteReady = true;
let pgliteError: unknown;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let walletSignup: typeof import("../wallet-signup");

beforeAll(async () => {
  try {
    const dbClient = await import("../../../db/client");
    closeDb = dbClient.closeDatabaseConnectionsForTests;
    const { organizations } = await import("../../../db/schemas/organizations");
    const { users } = await import("../../../db/schemas/users");
    const { pushSchema } = await import("../../../db/push-schema-for-tests");
    const { apply } = await pushSchema(
      { organizations, users } as never,
      dbClient.dbWrite as never,
    );
    await apply();
    walletSignup = await import("../wallet-signup");
  } catch (err) {
    pgliteReady = false;
    pgliteError = err;
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDb?.();
});

describe("what a wallet signup asserts about the wallet", () => {
  test("PGlite harness is up (fail loudly, never skip silently)", () => {
    if (!pgliteReady) throw pgliteError;
    expect(pgliteReady).toBe(true);
  });

  test(
    "an address the caller was merely handed creates an UNVERIFIED wallet",
    async () => {
      if (!pgliteReady) throw pgliteError;
      const evm = await walletSignup.findOrCreateUserByWalletAddress(NAMED_EVM);
      expect(evm.isNewAccount).toBe(true);
      expect(evm.user.wallet_verified).toBe(false);

      const solana = await walletSignup.findOrCreateSolanaUserByWalletAddress(NAMED_SOLANA);
      expect(solana.isNewAccount).toBe(true);
      expect(solana.user.wallet_verified).toBe(false);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a caller that verified a signature creates a VERIFIED wallet",
    async () => {
      if (!pgliteReady) throw pgliteError;
      const evm = await walletSignup.findOrCreateUserByWalletAddress(PROVEN_EVM, {
        walletProven: true,
      });
      expect(evm.user.wallet_verified).toBe(true);

      const solana = await walletSignup.findOrCreateSolanaUserByWalletAddress(PROVEN_SOLANA, {
        walletProven: true,
      });
      expect(solana.user.wallet_verified).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "proof raises an account opened by a caller that had none, and nothing lowers it",
    async () => {
      if (!pgliteReady) throw pgliteError;
      // An x402 topup can be the first thing that ever mentions this wallet.
      // Without the upgrade the owner would sign a SIWE challenge and still hold
      // an unverified wallet forever — no identity at any relying party.
      const named = await walletSignup.findOrCreateUserByWalletAddress(UPGRADED_EVM);
      expect(named.user.wallet_verified).toBe(false);

      const proven = await walletSignup.findOrCreateUserByWalletAddress(UPGRADED_EVM, {
        walletProven: true,
      });
      expect(proven.isNewAccount).toBe(false);
      expect(proven.user.id).toBe(named.user.id);
      expect(proven.user.wallet_verified).toBe(true);

      // A later unproven mention is not evidence against a checked signature.
      const namedAgain = await walletSignup.findOrCreateUserByWalletAddress(UPGRADED_EVM);
      expect(namedAgain.user.wallet_verified).toBe(true);
    },
    PGLITE_TIMEOUT,
  );
});
