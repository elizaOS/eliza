/** Cross-session proof that a deletion cascade cannot erase newly prepared bytes. */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { encodeFunctionData, erc20Abi, type Hex, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveAccountDeletionTestDatabase } from "../../db/account-deletion-test-database";

const database = resolveAccountDeletionTestDatabase();
if (!database) throw new Error("EVM deletion tests require an isolated local database");
const realPostgres = database === "loopback-postgres";
if (realPostgres) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "true";
  process.env.NODE_ENV = "test";
}
let db: typeof import("../../db/client").dbWrite;
let close: (() => Promise<void>) | undefined;
const organizationId = "40000000-0000-4000-8000-000000000001";
const userId = "40000000-0000-4000-8000-000000000002";
const paymentId = "40000000-0000-4000-8000-000000000003";
const outboxId = "40000000-0000-4000-8000-000000000004";
const claimToken = "40000000-0000-4000-8000-000000000005";
const sweepTo = "0x0000000000000000000000000000000000000001";
const tokenAddress = "0x0000000000000000000000000000000000000002";
const payload = {
  paymentId,
  network: "base",
  tokenKind: "erc20",
  tokenAddress,
  tokenMint: null,
  tokenDecimals: 6,
  receivedUnits: "1",
  sweepTo,
};
const account = privateKeyToAccount(`0x${"33".repeat(32)}` as Hex);

beforeAll(async () => {
  if (!realPostgres) return;
  ({ dbWrite: db, closeDatabaseConnectionsForTests: close } = await import("../../db/client"));
  await db.execute(`CREATE TABLE organizations(id uuid PRIMARY KEY);
    CREATE TABLE users(id uuid PRIMARY KEY);
    CREATE TABLE crypto_payments(id uuid PRIMARY KEY,
      organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      transaction_hash text,status text,metadata jsonb DEFAULT '{}'::jsonb,
      updated_at timestamptz DEFAULT now());`);
  for (const name of ["0255_crypto_settlement_outboxes.sql", "0561_evm_sweep_nonce_authority.sql"])
    await db.execute(
      await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), "utf8"),
    );
});
beforeEach(async () => {
  if (!realPostgres) return;
  const { sql } = await import("drizzle-orm");
  const { settlementDigest } = await import("./settlement-digest");
  await db.execute(
    "TRUNCATE crypto_sweep_outbox; DELETE FROM crypto_payments; DELETE FROM organizations; DELETE FROM users",
  );
  await db.execute(sql`INSERT INTO organizations(id) VALUES(${organizationId})`);
  await db.execute(sql`INSERT INTO users(id) VALUES(${userId})`);
  await db.execute(
    sql`INSERT INTO crypto_payments(id,organization_id,user_id,status) VALUES(${paymentId},${organizationId},${userId},'confirmed')`,
  );
  await db.execute(sql`INSERT INTO crypto_sweep_outbox(id,payment_id,payload,payload_digest,state,claim_token,lease_expires_at)
    VALUES(${outboxId},${paymentId},${JSON.stringify(payload)}::jsonb,${settlementDigest(payload)},'processing',${claimToken},clock_timestamp()+interval '2 minutes')`);
});
afterAll(async () => {
  await close?.();
});
async function signed(nonce: number) {
  const rawTransaction = await account.signTransaction({
    chainId: 8453,
    nonce,
    to: tokenAddress,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [sweepTo, 1n] }),
    value: 0n,
    gas: 100000n,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
    type: "eip1559",
  });
  return {
    rawTransaction,
    transactionHash: keccak256(rawTransaction),
    metadata: {
      network: "base" as const,
      nonce: String(nonce),
      sweepTo: "0x0000000000000000000000000000000000000001",
    },
  };
}
async function prepare(wait?: () => Promise<void>) {
  const { prepareAndPersistEvmSweep } = await import("./evm-sweep-authority");
  return prepareAndPersistEvmSweep({
    outboxId,
    claimToken,
    network: "base",
    sender: account.address,
    chainId: 8453,
    readNonce: async () => 0,
    prepare: async (nonce) => {
      await wait?.();
      return signed(nonce);
    },
  });
}

test.skipIf(!realPostgres)(
  "deletion waiting on preparation rechecks the newly committed authority",
  async () => {
    const control = new Client({ connectionString: process.env.DATABASE_URL });
    const observer = new Client({ connectionString: process.env.DATABASE_URL });
    await control.connect();
    await observer.connect();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let preparation: ReturnType<typeof prepare> | undefined;
    let deletion: Promise<unknown> | undefined;
    try {
      const {
        rows: [owner],
      } = await control.query("SELECT pg_backend_pid() AS pid");
      preparation = prepare(async () => {
        entered.resolve();
        await release.promise;
      });
      await Promise.race([
        entered.promise,
        preparation.then(() => {
          throw new Error("Preparation did not reach its barrier");
        }),
      ]);
      deletion = control.query("DELETE FROM organizations WHERE id=$1", [organizationId]).then(
        (value) => value,
        (error) => error,
      );
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const {
          rows: [state],
        } = await observer.query(
          "SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",
          [owner.pid],
        );
        if (state?.blocked) {
          blocked = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
      release.resolve();
      const prepared = await preparation;
      expect(prepared.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
      const outcome = await deletion;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("cannot be erased");
      const { countUnconfirmedAccountEvmSweeps } = await import("./account-deletion-crypto-sweeps");
      expect(await countUnconfirmedAccountEvmSweeps(userId, organizationId)).toBe(1);
    } finally {
      release.resolve();
      await preparation;
      await deletion;
      await control.end();
      await observer.end();
    }
  },
);

test.skipIf(!realPostgres)(
  "only a bound confirmation permits the original user cascade",
  async () => {
    const prepared = await prepare();
    const { sql } = await import("drizzle-orm");
    const receipt = {
      transactionHash: prepared.transactionHash,
      status: "success",
      blockHash: `0x${"ab".repeat(32)}`,
      blockNumber: "12",
    };
    await expect(
      Promise.resolve(db.execute(sql`DELETE FROM users WHERE id=${userId}`)),
    ).rejects.toHaveProperty("cause.message", "Unconfirmed EVM sweep authority cannot be erased");
    await expect(
      Promise.resolve(
        db.execute(
          sql`UPDATE crypto_sweep_outbox SET state='delivered',evm_confirmed_at=clock_timestamp(),evm_confirmed_receipt=${JSON.stringify({ ...receipt, transactionHash: `0x${"00".repeat(32)}` })}::jsonb WHERE id=${outboxId}`,
        ),
      ),
    ).rejects.toHaveProperty(
      "cause.message",
      "EVM sweep receipt does not match prepared transaction",
    );
    await db.execute(
      sql`UPDATE crypto_sweep_outbox SET state='delivered',evm_confirmed_at=clock_timestamp(),evm_confirmed_receipt=${JSON.stringify(receipt)}::jsonb WHERE id=${outboxId}`,
    );
    await db.execute(sql`DELETE FROM users WHERE id=${userId}`);
    expect(
      (await db.execute(sql`SELECT id FROM crypto_sweep_outbox WHERE id=${outboxId}`)).rows,
    ).toHaveLength(0);
  },
);

test.skipIf(!realPostgres)(
  "receipt publication locks payment before outbox while deletion waits",
  async () => {
    const prepared = await prepare();
    const { sql } = await import("drizzle-orm");
    const viem = await import("viem");
    mock.module("viem", () => ({
      ...viem,
      createPublicClient: () => ({
        getTransactionReceipt: async ({ hash }: { hash: string }) => ({
          transactionHash: hash,
          status: "success",
          blockHash: `0x${"ab".repeat(32)}`,
          blockNumber: 100n,
        }),
      }),
    }));
    const { directWalletPaymentsService } = await import("./direct-wallet-payments");
    const service = directWalletPaymentsService as unknown as {
      processSweepForPayment: (
        env: Record<string, string>,
        id: string,
        hooks: { afterExternalSweep: () => Promise<void> },
      ) => Promise<boolean>;
    };
    await db.execute(sql`UPDATE crypto_sweep_outbox SET state='pending',claim_token=NULL,
      lease_expires_at=NULL WHERE id=${outboxId}`);
    const control = new Client({ connectionString: process.env.DATABASE_URL });
    const observer = new Client({ connectionString: process.env.DATABASE_URL });
    await control.connect();
    await observer.connect();
    const receiptReached = Promise.withResolvers<void>();
    let publication: Promise<boolean | Error> | undefined;
    try {
      await control.query("BEGIN; SET LOCAL lock_timeout='3s'");
      const {
        rows: [owner],
      } = await control.query("SELECT pg_backend_pid() AS pid");
      await control.query("SELECT id FROM crypto_payments WHERE id=$1 FOR UPDATE", [paymentId]);
      publication = service
        .processSweepForPayment(
          {
            CRYPTO_DIRECT_BASE_PRIVATE_KEY: `0x${"33".repeat(32)}`,
            CRYPTO_DIRECT_BASE_RECEIVE_ADDRESS: account.address,
            CRYPTO_DIRECT_BASE_SECURE_ADDRESS: sweepTo,
            CRYPTO_DIRECT_BASE_RPC_URL: "http://controlled.invalid",
          },
          paymentId,
          {
            afterExternalSweep: async () => {
              receiptReached.resolve();
            },
          },
        )
        .catch((error: Error) => error);
      await Promise.race([
        receiptReached.promise,
        publication.then((outcome) => {
          throw new Error(`Publication missed receipt barrier: ${outcome}`);
        }),
      ]);
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const { rows } = await observer.query(
          "SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'",
          [owner.pid],
        );
        if (rows.length === 1) {
          blocked = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
      const deletion = await control
        .query("DELETE FROM crypto_payments WHERE id=$1", [paymentId])
        .then(
          () => null,
          (error: Error) => error,
        );
      expect(deletion).toBeInstanceOf(Error);
      expect(deletion?.message).toBe("Unconfirmed EVM sweep authority cannot be erased");
      await control.query("ROLLBACK");
      expect(await publication).toBe(true);
      const {
        rows: [row],
      } = await observer.query(
        "SELECT state,evm_confirmed_receipt FROM crypto_sweep_outbox WHERE id=$1",
        [outboxId],
      );
      expect(row.state).toBe("delivered");
      expect(row.evm_confirmed_receipt.transactionHash).toBe(prepared.transactionHash);
      await control.query("DELETE FROM crypto_payments WHERE id=$1", [paymentId]);
      expect(
        (await observer.query("SELECT id FROM crypto_sweep_outbox WHERE id=$1", [outboxId])).rows,
      ).toHaveLength(0);
    } finally {
      await control.query("ROLLBACK");
      await publication;
      await control.end();
      await observer.end();
    }
  },
);
