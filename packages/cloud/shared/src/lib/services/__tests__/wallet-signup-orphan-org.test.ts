/**
 * Wallet signup must be atomic AND degrade-safe: a user-create failure leaves
 * NO orphan org (and no committed welcome-credit grant), a retry converges
 * cleanly on one org + one idempotent grant, and a failing OPTIONAL welcome
 * grant is contained in a savepoint so the signup still completes without the
 * bonus instead of aborting the whole transaction.
 *
 * These tests run the REAL signup path (real transaction, real credits CTE,
 * real signup-grant guard with its per-IP advisory lock) against in-process
 * PGlite. Failures are injected in the DATABASE — plpgsql BEFORE INSERT
 * triggers armed via a flag table — so the rollback/savepoint behavior under
 * test is the real one, not a mocked seam. Fails loudly if PGlite cannot
 * initialize; never a silent skip.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.INITIAL_FREE_CREDITS = "5";

const PGLITE_TIMEOUT = 120_000;
const CLIENT_IP = "203.0.113.77";

const EVM_ADDRESS = `0x${"ab".repeat(20)}`;
const EVM_ADDRESS_2 = `0x${"cd".repeat(20)}`;
// Distinct address for the grant-containment test: the users service caches
// wallet lookups (in-memory under MOCK_REDIS), so reusing an address a prior
// test signed in with would short-circuit at the existing-user pre-check.
const EVM_ADDRESS_3 = `0x${"ef".repeat(20)}`;
const SOLANA_ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

let pgliteReady = true;
let pgliteError: unknown;
let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let walletSignup: typeof import("../wallet-signup");
let runWithRequestContext: typeof import("../../runtime/request-context").runWithRequestContext;
let flushWalletLookupCache: () => Promise<void>;

async function armUserInsertFailure(): Promise<void> {
  await dbWrite.execute(`INSERT INTO test_fail_flags (name) VALUES ('users_insert')
    ON CONFLICT (name) DO NOTHING;`);
}

async function armCreditInsertFailure(): Promise<void> {
  await dbWrite.execute(`INSERT INTO test_fail_flags (name) VALUES ('credits_insert')
    ON CONFLICT (name) DO NOTHING;`);
}

async function disarmFailures(): Promise<void> {
  await dbWrite.execute(`DELETE FROM test_fail_flags;`);
}

async function countRows(table: "organizations" | "users" | "credit_transactions") {
  const r = await dbWrite.execute(`SELECT count(*)::int AS n FROM ${table};`);
  return (r.rows[0] as { n: number }).n;
}

async function orgBalanceBySlug(slug: string): Promise<number> {
  const r = await dbWrite.execute(
    `SELECT credit_balance FROM organizations WHERE slug = '${slug}';`,
  );
  return Number((r.rows[0] as { credit_balance: string }).credit_balance);
}

/** Run signup inside a request context so the per-IP grant guard path is real. */
function signupEvm(address: string) {
  return runWithRequestContext({ clientIp: CLIENT_IP }, () =>
    walletSignup.findOrCreateUserByWalletAddress(address),
  );
}

/**
 * Assert `promise` rejects with the trigger's exception somewhere in the cause
 * chain — drizzle wraps driver errors in DrizzleQueryError (message = the
 * failed SQL), so the injected message only appears on a nested `cause`.
 */
async function expectRejectsFromTrigger(promise: Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(Error);
  const chain: string[] = [];
  let current: unknown = thrown;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    chain.push(current.message);
    current = current.cause;
  }
  expect(chain.join(" | ")).toContain("simulated transient user insert failure");
}

beforeAll(async () => {
  try {
    const dbClient = await import("../../../db/client");
    dbWrite = dbClient.dbWrite;
    closeDb = dbClient.closeDatabaseConnectionsForTests;
    const { organizations } = await import("../../../db/schemas/organizations");
    const { users } = await import("../../../db/schemas/users");
    const { creditTransactions } = await import("../../../db/schemas/credit-transactions");
    const { pushSchema } = await import("../../../db/push-schema-for-tests");
    const { apply } = await pushSchema(
      { organizations, users, creditTransactions } as never,
      dbClient.dbWrite as never,
    );
    await apply();

    // In-database failure injection: BEFORE INSERT triggers that raise while a
    // flag row exists — the real SQL failure shapes the transactional signup
    // must roll back from (users) or contain in a savepoint (credits).
    await dbWrite.execute(`CREATE TABLE IF NOT EXISTS test_fail_flags (name text PRIMARY KEY);`);
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION test_users_insert_gate() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM test_fail_flags WHERE name = 'users_insert') THEN
          RAISE EXCEPTION 'simulated transient user insert failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;`);
    await dbWrite.execute(`
      CREATE TRIGGER test_users_insert_gate_trg BEFORE INSERT ON users
        FOR EACH ROW EXECUTE FUNCTION test_users_insert_gate();`);
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION test_credits_insert_gate() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM test_fail_flags WHERE name = 'credits_insert') THEN
          RAISE EXCEPTION 'simulated transient credit insert failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;`);
    await dbWrite.execute(`
      CREATE TRIGGER test_credits_insert_gate_trg BEFORE INSERT ON credit_transactions
        FOR EACH ROW EXECUTE FUNCTION test_credits_insert_gate();`);

    walletSignup = await import("../wallet-signup");
    ({ runWithRequestContext } = await import("../../runtime/request-context"));

    // The users service caches wallet lookups (in-memory under MOCK_REDIS);
    // the DB wipe in beforeEach must be mirrored in the cache or a later test
    // reusing an address would short-circuit at the existing-user pre-check.
    const { cache } = await import("../../cache/client");
    const { CacheKeys } = await import("../../cache/keys");
    const { getAddress } = await import("viem");
    flushWalletLookupCache = async () => {
      for (const addr of [EVM_ADDRESS, EVM_ADDRESS_2, EVM_ADDRESS_3]) {
        await cache.del(CacheKeys.user.byWalletAddressWithOrg(getAddress(addr)));
      }
    };
  } catch (err) {
    pgliteReady = false;
    pgliteError = err;
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  if (!pgliteReady) return;
  await disarmFailures();
  await dbWrite.execute(`DELETE FROM credit_transactions;`);
  await dbWrite.execute(`DELETE FROM users;`);
  await dbWrite.execute(`DELETE FROM organizations;`);
  await flushWalletLookupCache();
});

describe("wallet signup — no orphan org on user-create failure", () => {
  test("PGlite harness is up (fail loudly, never skip silently)", () => {
    if (!pgliteReady) throw pgliteError;
    expect(pgliteReady).toBe(true);
  });

  test(
    "EVM: user-create failure rolls back the org AND the welcome grant, then a retry succeeds with exactly one grant",
    async () => {
      if (!pgliteReady) throw pgliteError;

      await armUserInsertFailure();
      await expectRejectsFromTrigger(signupEvm(EVM_ADDRESS));

      // The failing attempt must leave NOTHING durable behind.
      expect(await countRows("organizations")).toBe(0);
      expect(await countRows("credit_transactions")).toBe(0);
      expect(await countRows("users")).toBe(0);

      await disarmFailures();
      const retry = await signupEvm(EVM_ADDRESS);

      expect(retry.isNewAccount).toBe(true);
      expect(retry.user.role).toBe("owner");
      expect(retry.initialCreditsGranted).toBe(true);
      expect(retry.initialFreeCreditsUsd).toBe(5);

      const slug = `wallet-${EVM_ADDRESS.toLowerCase()}`;
      expect(await countRows("organizations")).toBe(1);
      expect(await countRows("users")).toBe(1);
      expect(await countRows("credit_transactions")).toBe(1);
      expect(await orgBalanceBySlug(slug)).toBeCloseTo(5, 6);
      const grantRow = await dbWrite.execute(
        `SELECT stripe_payment_intent_id FROM credit_transactions;`,
      );
      expect(
        (grantRow.rows[0] as { stripe_payment_intent_id: string }).stripe_payment_intent_id,
      ).toBe(`wallet-signup:evm:${EVM_ADDRESS.toLowerCase()}`);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "Solana: user-create failure rolls back the org and grant; retry succeeds",
    async () => {
      if (!pgliteReady) throw pgliteError;

      await armUserInsertFailure();
      await expectRejectsFromTrigger(
        runWithRequestContext({ clientIp: CLIENT_IP }, () =>
          walletSignup.findOrCreateSolanaUserByWalletAddress(SOLANA_ADDRESS),
        ),
      );

      expect(await countRows("organizations")).toBe(0);
      expect(await countRows("credit_transactions")).toBe(0);

      await disarmFailures();
      const retry = await runWithRequestContext({ clientIp: CLIENT_IP }, () =>
        walletSignup.findOrCreateSolanaUserByWalletAddress(SOLANA_ADDRESS),
      );

      expect(retry.isNewAccount).toBe(true);
      expect(retry.user.wallet_address).toBe(SOLANA_ADDRESS);
      expect(retry.initialCreditsGranted).toBe(true);
      expect(await countRows("organizations")).toBe(1);
      expect(await countRows("credit_transactions")).toBe(1);
      expect(await orgBalanceBySlug(`wallet-solana-${SOLANA_ADDRESS}`)).toBeCloseTo(5, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a pre-leaked org + committed grant (pre-fix state) is reused WITHOUT double-granting",
    async () => {
      if (!pgliteReady) throw pgliteError;

      // Simulate the exact residue the old non-transactional path could leak:
      // org committed, welcome grant committed under the idempotency key, no
      // user row. A retry must adopt the org and must NOT grant again.
      const normalized = EVM_ADDRESS_2.toLowerCase();
      const slug = `wallet-${normalized}`;
      const idempotencyKey = `wallet-signup:evm:${normalized}`;
      await dbWrite.execute(
        `INSERT INTO organizations (name, slug, credit_balance) VALUES ('Leaked', '${slug}', '5');`,
      );
      await dbWrite.execute(
        `INSERT INTO credit_transactions (organization_id, amount, type, description, metadata, stripe_payment_intent_id)
         SELECT id, '5', 'credit', 'Wallet sign-up bonus',
                '{"type":"wallet_signup","chain":"evm"}'::jsonb, '${idempotencyKey}'
         FROM organizations WHERE slug = '${slug}';`,
      );

      const res = await signupEvm(EVM_ADDRESS_2);

      expect(res.isNewAccount).toBe(true);
      expect(res.user.role).toBe("owner");
      expect(res.user.organization?.slug).toBe(slug);
      // Idempotency: still one grant row, balance unchanged at 5 (not 10).
      expect(await countRows("organizations")).toBe(1);
      expect(await countRows("credit_transactions")).toBe(1);
      expect(await orgBalanceBySlug(slug)).toBeCloseTo(5, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "second sign-in returns the existing user without creating anything new",
    async () => {
      if (!pgliteReady) throw pgliteError;

      const first = await signupEvm(EVM_ADDRESS);
      const again = await signupEvm(EVM_ADDRESS);

      expect(first.isNewAccount).toBe(true);
      expect(again.isNewAccount).toBe(false);
      expect(again.user.id).toBe(first.user.id);
      expect(await countRows("organizations")).toBe(1);
      expect(await countRows("users")).toBe(1);
      expect(await countRows("credit_transactions")).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a failing OPTIONAL welcome grant is contained: signup still completes without the bonus",
    async () => {
      if (!pgliteReady) throw pgliteError;

      // The grant runs in a savepoint inside the signup transaction. Without
      // it, this injected credit-insert failure would abort the enclosing
      // Postgres transaction and the signup would fail entirely — the
      // designed continue-without-bonus degrade could never fire.
      await armCreditInsertFailure();
      const res = await signupEvm(EVM_ADDRESS_3);

      expect(res.isNewAccount).toBe(true);
      expect(res.initialCreditsGranted).toBe(false);
      expect(res.welcomeBonusWithheld).toBe(true);
      expect(await countRows("organizations")).toBe(1);
      expect(await countRows("users")).toBe(1);
      expect(await countRows("credit_transactions")).toBe(0);
      expect(await orgBalanceBySlug(`wallet-${EVM_ADDRESS_3.toLowerCase()}`)).toBeCloseTo(0, 6);
    },
    PGLITE_TIMEOUT,
  );
});
