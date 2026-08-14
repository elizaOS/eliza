/**
 * Wallet signup must make the creator the OWNER of the org it creates.
 *
 * Surfaced by the #11488 credentials-tab visual e2e: a fresh SIWE/wallet
 * signup created its own organization but landed as a plain "member" (the
 * users.role schema default) — unable to invite teammates, manage members, or
 * manage the org credential pool in an org where they are the only human.
 * The anonymous-migration signup path (session.ts) already sets "owner";
 * these tests pin the wallet paths (EVM + Solana) to the same semantics,
 * against a REAL PGlite DB — no repository mocking.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

const PGLITE_TIMEOUT = 120_000;

const EVM_ADDRESS = `0x${"ab".repeat(20)}`;
const SOLANA_ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

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

describe("wallet signup org role", () => {
  test("PGlite harness is up (fail loudly, never skip silently)", () => {
    if (!pgliteReady) throw pgliteError;
    expect(pgliteReady).toBe(true);
  });

  test(
    "fresh EVM wallet signup creates the org with the user as OWNER",
    async () => {
      if (!pgliteReady) throw pgliteError;
      const { user, isNewAccount } = await walletSignup.findOrCreateUserByWalletAddress(
        EVM_ADDRESS,
        {
          grantInitialCredits: false,
        },
      );
      expect(isNewAccount).toBe(true);
      expect(user.organization_id).toBeTruthy();
      expect(user.role).toBe("owner");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "returning EVM wallet keeps the same owner user (no re-create)",
    async () => {
      if (!pgliteReady) throw pgliteError;
      const first = await walletSignup.findOrCreateUserByWalletAddress(EVM_ADDRESS, {
        grantInitialCredits: false,
      });
      const again = await walletSignup.findOrCreateUserByWalletAddress(EVM_ADDRESS, {
        grantInitialCredits: false,
      });
      expect(again.isNewAccount).toBe(false);
      expect(again.user.id).toBe(first.user.id);
      expect(again.user.role).toBe("owner");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "fresh Solana wallet signup creates the org with the user as OWNER",
    async () => {
      if (!pgliteReady) throw pgliteError;
      const { user, isNewAccount } = await walletSignup.findOrCreateSolanaUserByWalletAddress(
        SOLANA_ADDRESS,
        { grantInitialCredits: false },
      );
      expect(isNewAccount).toBe(true);
      expect(user.organization_id).toBeTruthy();
      expect(user.role).toBe("owner");
    },
    PGLITE_TIMEOUT,
  );
});
