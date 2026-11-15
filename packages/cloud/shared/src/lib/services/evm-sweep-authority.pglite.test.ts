/** Real sweep persistence and EVM signing; the remote chain is controlled locally. */
import { afterAll, beforeAll, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { Hex } from "viem";

const viem = await import("viem");
const { privateKeyToAccount } = await import("viem/accounts");
const { sql } = await import("drizzle-orm");
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
const KEY = `0x${"11".repeat(32)}` as Hex,
  OTHER_KEY = `0x${"22".repeat(32)}` as Hex;
const epoch = Date.parse("2027-01-01T00:00:00Z");
const counts = new Map<string, { latest: number; pending: number }>();
const accepted = new Map<string, { nonce: number; sender: string; raw: Hex }>();
const receipts = new Set<string>();
const prepared: Array<{ nonce: number; sender: string }> = [];
const submissions: Hex[] = [];
let failAfterAcceptance = false;
let expireDuringPreparation = false;
const state = (sender: string) => {
  const key = sender.toLowerCase();
  let value = counts.get(key);
  if (!value) {
    value = { latest: 7, pending: 7 };
    counts.set(key, value);
  }
  return value;
};
mock.module("viem", () => ({
  ...viem,
  createWalletClient: ({ account }: { account: { address: string } }) => ({
    prepareTransactionRequest: async (request: Record<string, unknown>) => {
      const nonce = request.nonce ?? state(account.address).pending;
      prepared.push({ nonce: Number(nonce), sender: account.address.toLowerCase() });
      if (expireDuringPreparation) {
        expireDuringPreparation = false;
        setSystemTime(Date.now() + 121000);
      }
      return {
        ...request,
        nonce,
        chainId: 8453,
        gas: 100000n,
        maxFeePerGas: 10n,
        maxPriorityFeePerGas: 1n,
        type: "eip1559",
      };
    },
  }),
  createPublicClient: () => ({
    getTransactionCount: async ({
      address,
      blockTag,
    }: {
      address: string;
      blockTag: "latest" | "pending";
    }) => state(address)[blockTag],
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      if (receipts.has(hash))
        return {
          transactionHash: hash,
          status: "success",
          blockHash: `0x${"ab".repeat(32)}`,
          blockNumber: 100n,
        };
      throw new Error("receipt not found");
    },
    getTransaction: async ({ hash }: { hash: string }) => {
      if (accepted.has(hash)) return { hash };
      throw new Error("transaction not found");
    },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      submissions.push(serializedTransaction);
      const tx = viem.parseTransaction(serializedTransaction),
        hash = viem.keccak256(serializedTransaction);
      const sender = (
        await viem.recoverTransactionAddress({ serializedTransaction })
      ).toLowerCase();
      const prior = [...accepted.entries()].find(
        ([, v]) => v.sender === sender && v.nonce === tx.nonce,
      );
      if (prior && prior[0] !== hash) throw new Error("nonce too low");
      accepted.set(hash, { nonce: Number(tx.nonce), sender, raw: serializedTransaction });
      state(sender).pending = Math.max(state(sender).pending, Number(tx.nonce) + 1);
      if (failAfterAcceptance) {
        failAfterAcceptance = false;
        throw new Error("lost provider response");
      }
      return hash;
    },
  }),
}));
const { dbWrite, getPgliteClientForTests, closeDatabaseConnectionsForTests } = await import(
  "../../db/client"
);
const { settlementDigest } = await import("./settlement-digest");
const { directWalletPaymentsService } = await import("./direct-wallet-payments");
const service = directWalletPaymentsService as unknown as {
  drainSweepOutbox: (
    env: ReturnType<typeof environment>,
    limit?: number,
  ) => Promise<{ processed: number; delivered: number; deferred: number }>;
  processSweepForPayment: (
    env: ReturnType<typeof environment>,
    id: string,
    hooks?: { afterExternalSweep?: () => Promise<void> },
  ) => Promise<boolean>;
};
function environment(key = KEY) {
  return {
    CRYPTO_DIRECT_BASE_PRIVATE_KEY: key,
    CRYPTO_DIRECT_BASE_RECEIVE_ADDRESS: privateKeyToAccount(key).address,
    CRYPTO_DIRECT_BASE_SECURE_ADDRESS: "0x0000000000000000000000000000000000000001",
    CRYPTO_DIRECT_BASE_RPC_URL: "http://controlled.invalid",
  };
}
const organizationId = "20000000-0000-4000-8000-000000000001";
const userId = "30000000-0000-4000-8000-000000000001";
const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];
async function seed(id: string, units = 100) {
  const payload = {
    paymentId: id,
    network: "base",
    tokenKind: "erc20",
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    tokenMint: null,
    tokenDecimals: 6,
    receivedUnits: String(units),
    sweepTo: environment().CRYPTO_DIRECT_BASE_SECURE_ADDRESS,
  };
  await dbWrite.execute(
    sql`INSERT INTO organizations(id) VALUES (${organizationId}) ON CONFLICT DO NOTHING`,
  );
  await dbWrite.execute(sql`INSERT INTO users(id) VALUES (${userId}) ON CONFLICT DO NOTHING`);
  await dbWrite.execute(
    sql`INSERT INTO crypto_payments(id,status,organization_id,user_id) VALUES (${id},'confirmed',${organizationId},${userId}) ON CONFLICT DO NOTHING`,
  );
  await dbWrite.execute(
    sql`INSERT INTO crypto_sweep_outbox(payment_id,payload,payload_digest) VALUES (${id},${JSON.stringify(payload)}::jsonb,${settlementDigest(payload)})`,
  );
}
async function rows() {
  return (await dbWrite.execute(sql`SELECT * FROM crypto_sweep_outbox ORDER BY payment_id`))
    .rows as Array<{
    id: string;
    payment_id: string;
    state: string;
    attempts: number;
    prepared_transaction: string | null;
    sweep_transaction_hash: string | null;
    evm_sender: string | null;
    evm_nonce: number | null;
  }>;
}
function advance() {
  setSystemTime(Date.now() + 31000);
}
function mine(hash: string) {
  const item = accepted.get(hash)!;
  receipts.add(hash);
  state(item.sender).latest = item.nonce + 1;
  state(item.sender).pending = item.nonce + 1;
}
beforeAll(async () => {
  const pg = getPgliteClientForTests();
  await pg.exec(
    "CREATE TABLE organizations(id uuid PRIMARY KEY); CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE crypto_payments(id uuid PRIMARY KEY, organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE, user_id uuid REFERENCES users(id) ON DELETE CASCADE, transaction_hash text,status text,metadata jsonb DEFAULT '{}'::jsonb,updated_at timestamptz DEFAULT now())",
  );
  for (const name of ["0255_crypto_settlement_outboxes.sql", "0561_evm_sweep_nonce_authority.sql"])
    await pg.exec(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), "utf8"));
}, 30_000);
beforeEach(async () => {
  setSystemTime(epoch);
  counts.clear();
  accepted.clear();
  receipts.clear();
  prepared.length = 0;
  submissions.length = 0;
  failAfterAcceptance = false;
  expireDuringPreparation = false;
  await dbWrite.execute(sql`TRUNCATE crypto_sweep_outbox`);
  await dbWrite.execute(sql`DELETE FROM crypto_payments`);
  await seed(ids[0]);
  await seed(ids[1], 200);
});
afterAll(async () => {
  setSystemTime();
  await closeDatabaseConnectionsForTests();
});
test("one wallet serializes two outboxes through confirmed receipts without reusing a nonce", async () => {
  await Promise.allSettled(ids.map((id) => service.processSweepForPayment(environment(), id)));
  expect(prepared).toHaveLength(1);
  expect(accepted.size).toBe(1);
  let all = await rows();
  const first = all.find((row) => row.prepared_transaction)!;
  const second = all.find((row) => !row.prepared_transaction)!;
  expect(all.map((row) => row.state)).toEqual(["pending", "pending"]);
  mine(first.sweep_transaction_hash!);
  advance();
  expect(await service.processSweepForPayment(environment(), first.payment_id)).toBe(true);
  await expect(service.processSweepForPayment(environment(), second.payment_id)).rejects.toThrow(
    "awaiting",
  );
  all = await rows();
  expect(all.find((row) => row.payment_id === second.payment_id)?.evm_nonce).toBe(8);
  expect(prepared.map((row) => row.nonce)).toEqual([7, 8]);
  const last = all.find((row) => row.payment_id === second.payment_id)!;
  mine(last.sweep_transaction_hash!);
  advance();
  expect(await service.processSweepForPayment(environment(), last.payment_id)).toBe(true);
  expect((await rows()).map((row) => row.state)).toEqual(["delivered", "delivered"]);
  const confirmations = (
    await dbWrite.execute(
      sql`SELECT evm_confirmed_at,evm_confirmed_receipt,sweep_transaction_hash FROM crypto_sweep_outbox`,
    )
  ).rows;
  for (const confirmation of confirmations) {
    expect(confirmation.evm_confirmed_at).not.toBeNull();
    expect(confirmation.evm_confirmed_receipt).toMatchObject({
      status: "success",
      transactionHash: confirmation.sweep_transaction_hash,
      blockNumber: "100",
    });
  }
});
test("pending visibility does not release the wallet or exhaust its failure budget", async () => {
  await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow("awaiting");
  for (let i = 0; i < 14; i++) {
    advance();
    await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow("awaiting");
  }
  expect((await rows())[0].state).toBe("pending");
  expect((await rows())[0].attempts).toBe(0);
  expect(prepared).toHaveLength(1);
  expect(submissions).toHaveLength(1);
  advance();
  await expect(service.processSweepForPayment(environment(), ids[1])).rejects.toThrow("nonce");
  expect(prepared).toHaveLength(1);
});
test("lost submission acknowledgement retains and retries exact signed bytes", async () => {
  failAfterAcceptance = true;
  await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow(
    "lost provider response",
  );
  const original = (await rows())[0].prepared_transaction;
  expect(original).toBeTruthy();
  advance();
  await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow("awaiting");
  expect((await rows())[0].prepared_transaction).toBe(original);
  expect(prepared).toHaveLength(1);
  expect(submissions).toHaveLength(1);
  mine((await rows())[0].sweep_transaction_hash!);
  advance();
  expect(await service.processSweepForPayment(environment(), ids[0])).toBe(true);
});
test("unknown provider pending nonce defers preparation without allocating past the gap", async () => {
  state(environment().CRYPTO_DIRECT_BASE_RECEIVE_ADDRESS).pending = 9;
  await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow(
    "pending nonce",
  );
  expect(prepared).toHaveLength(0);
  expect((await rows())[0].prepared_transaction).toBeNull();
  expect((await rows())[0].attempts).toBe(0);
  state(environment().CRYPTO_DIRECT_BASE_RECEIVE_ADDRESS).pending = 7;
  advance();
  await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow("awaiting");
  expect(prepared[0].nonce).toBe(7);
});
test("another sender on the same chain is not blocked by this wallet", async () => {
  await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow("awaiting");
  await expect(service.processSweepForPayment(environment(OTHER_KEY), ids[1])).rejects.toThrow(
    "awaiting",
  );
  expect(prepared.map((row) => row.nonce)).toEqual([7, 7]);
  expect(new Set((await rows()).map((row) => row.evm_sender)).size).toBe(2);
  expect(accepted.size).toBe(2);
});
test("expiry before preparation commit emits no transaction and retains no nonce", async () => {
  expireDuringPreparation = true;
  await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow("expired");
  expect((await rows())[0].prepared_transaction).toBeNull();
  expect(submissions).toHaveLength(0);
  advance();
  await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow("awaiting");
  expect(prepared.map((row) => row.nonce)).toEqual([7, 7]);
});
test("a failed persistence rolls back preparation before any provider submission", async () => {
  const pg = getPgliteClientForTests();
  await pg.exec(
    "CREATE FUNCTION reject_signed_sweep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.prepared_transaction IS NOT NULL THEN RAISE EXCEPTION 'injected signed persistence failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_signed_sweep BEFORE UPDATE ON crypto_sweep_outbox FOR EACH ROW EXECUTE FUNCTION reject_signed_sweep()",
  );
  try {
    await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow();
    expect((await rows())[0].prepared_transaction).toBeNull();
    expect(submissions).toHaveLength(0);
  } finally {
    await pg.exec(
      "DROP TRIGGER reject_signed_sweep ON crypto_sweep_outbox; DROP FUNCTION reject_signed_sweep()",
    );
  }
  advance();
  await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow("awaiting");
  expect(prepared.map((row) => row.nonce)).toEqual([7, 7]);
});
test("prepared bytes and wallet nonce identity are immutable in the database", async () => {
  await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow("awaiting");
  const row = (await rows())[0];
  for (const change of [
    sql`evm_nonce=8`,
    sql`evm_sender=NULL`,
    sql`payload=payload || '{"changed":true}'::jsonb`,
    sql`payload_digest='changed'`,
    sql`prepared_transaction='0x00'`,
    sql`prepared_metadata='{}'::jsonb`,
  ])
    await expect(
      Promise.resolve(
        dbWrite.execute(sql`UPDATE crypto_sweep_outbox SET ${change} WHERE id=${row.id}`),
      ),
    ).rejects.toThrow();
  expect((await rows())[0].prepared_transaction).toBe(row.prepared_transaction);
});

test("legacy signed bytes recover their actual sender and keep an unconfirmed nonce reserved", async () => {
  await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow("awaiting");
  const [first] = await rows();
  const [{ payload, payload_digest, prepared_metadata }] = (
    await dbWrite.execute(
      sql`SELECT payload,payload_digest,prepared_metadata FROM crypto_sweep_outbox WHERE id=${first.id}`,
    )
  ).rows as Array<{
    payload: object;
    payload_digest: string;
    prepared_metadata: Record<string, unknown>;
  }>;
  const { sender: _sender, ...legacyMetadata } = prepared_metadata;
  // Reconstruct a pre-migration fixture. TRUNCATE is confined to this isolated database.
  await dbWrite.execute(sql`TRUNCATE crypto_sweep_outbox`);
  await seed(ids[1], 200);
  await dbWrite.execute(sql`INSERT INTO crypto_sweep_outbox(payment_id,payload,payload_digest,state,delivered_at,prepared_transaction,sweep_transaction_hash,prepared_metadata)
    VALUES (${first.payment_id},${JSON.stringify(payload)}::jsonb,${payload_digest},'delivered',now(),${first.prepared_transaction},${first.sweep_transaction_hash},${JSON.stringify(legacyMetadata)}::jsonb)`);
  await expect(
    Promise.resolve(
      dbWrite.execute(
        sql`UPDATE crypto_sweep_outbox SET prepared_transaction='0x00' WHERE payment_id=${first.payment_id}`,
      ),
    ),
  ).rejects.toHaveProperty("cause.message", "Prepared EVM sweep authority is immutable");
  await expect(service.processSweepForPayment(environment(), ids[1])).rejects.toThrow("nonce");
  const legacy = (await rows()).find((row) => row.payment_id === ids[0])!;
  expect(legacy.evm_sender).toBe(environment().CRYPTO_DIRECT_BASE_RECEIVE_ADDRESS.toLowerCase());
  expect(legacy.prepared_transaction).toBe(first.prepared_transaction);
  expect(prepared).toHaveLength(1);
  await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow("read-only");
  expect(submissions).toHaveLength(1);
  mine(first.sweep_transaction_hash!);
  advance();
  expect(await service.processSweepForPayment(environment(), ids[0])).toBe(true);
  await expect(service.processSweepForPayment(environment(), ids[1])).rejects.toThrow("awaiting");
  expect(prepared.map((row) => row.nonce)).toEqual([7, 8]);
});

test("a provider nonce advance without the original receipt cannot release an unresolved sweep", async () => {
  await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow("awaiting");
  const wallet = state(environment().CRYPTO_DIRECT_BASE_RECEIVE_ADDRESS);
  wallet.latest = wallet.pending = 8;
  await expect(service.processSweepForPayment(environment(), ids[1])).rejects.toThrow("nonce");
  expect((await rows())[1].prepared_transaction).toBeNull();
  expect(prepared).toHaveLength(1);
});

test("a confirmed receipt survives a crash before local acknowledgement", async () => {
  await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow("awaiting");
  const first = (await rows())[0];
  mine(first.sweep_transaction_hash!);
  advance();
  await expect(
    service.processSweepForPayment(environment(), ids[0], {
      afterExternalSweep: async () => {
        throw new Error("injected crash after receipt");
      },
    }),
  ).rejects.toThrow("injected crash");
  expect((await rows())[0].state).toBe("pending");
  advance();
  expect(await service.processSweepForPayment(environment(), ids[0])).toBe(true);
  expect(prepared).toHaveLength(1);
  expect(submissions).toHaveLength(1);
});

test("account deletion retains unconfirmed EVM authority through both ownership cascades", async () => {
  const { countUnconfirmedAccountEvmSweeps } = await import("./account-deletion-crypto-sweeps");
  expect(await countUnconfirmedAccountEvmSweeps(userId, organizationId)).toBe(0);
  await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow("awaiting");
  const first = (await rows())[0];
  expect(await countUnconfirmedAccountEvmSweeps(userId, organizationId)).toBe(1);
  expect(await countUnconfirmedAccountEvmSweeps(crypto.randomUUID(), crypto.randomUUID())).toBe(0);
  await expect(
    Promise.resolve(dbWrite.execute(sql`DELETE FROM organizations WHERE id=${organizationId}`)),
  ).rejects.toHaveProperty("cause.message", "Unconfirmed EVM sweep authority cannot be erased");
  await expect(
    Promise.resolve(dbWrite.execute(sql`DELETE FROM users WHERE id=${userId}`)),
  ).rejects.toHaveProperty("cause.message", "Unconfirmed EVM sweep authority cannot be erased");
  expect((await rows())[0].prepared_transaction).toBe(first.prepared_transaction);
  mine(first.sweep_transaction_hash!);
  advance();
  expect(await service.processSweepForPayment(environment(), ids[0])).toBe(true);
  expect(await countUnconfirmedAccountEvmSweeps(userId, organizationId)).toBe(0);
  await dbWrite.execute(sql`DELETE FROM organizations WHERE id=${organizationId}`);
  expect(await rows()).toHaveLength(0);
});

for (const prior of ["terminal", "delivered"] as const)
  for (const interrupted of [false, true])
    test(`${prior} EVM recovery remains read-only after ${interrupted ? "an interrupted claim" : "a clean claim"}`, async () => {
      await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow(
        "awaiting",
      );
      const first = (await rows())[0];
      await dbWrite.execute(
        sql`UPDATE crypto_sweep_outbox SET state=${interrupted ? "processing" : prior},
      terminal_at=CASE WHEN ${prior}='terminal' THEN now() ELSE NULL END,
      delivered_at=CASE WHEN ${prior}='delivered' THEN now() ELSE NULL END,
      lease_expires_at=now()-interval '1 second', next_attempt_at=now() WHERE id=${first.id}`,
      );
      await dbWrite.execute(
        sql`UPDATE crypto_sweep_outbox SET next_attempt_at=now()+interval '1 day' WHERE payment_id=${ids[1]}`,
      );
      accepted.delete(first.sweep_transaction_hash!);
      advance();
      expect(await service.drainSweepOutbox(environment())).toEqual({
        processed: 1,
        delivered: 0,
        deferred: 1,
      });
      expect((await rows())[0].state).toBe(prior);
      expect(submissions).toHaveLength(1);
      receipts.add(first.sweep_transaction_hash!);
      advance();
      expect(await service.drainSweepOutbox(environment())).toEqual({
        processed: 1,
        delivered: 1,
        deferred: 0,
      });
      expect((await rows())[0].state).toBe("delivered");
      expect(submissions).toHaveLength(1);
    });

test("drain recovers a processing row whose lease is absent", async () => {
  await dbWrite.execute(
    sql`UPDATE crypto_sweep_outbox SET state='processing',lease_expires_at=NULL WHERE payment_id=${ids[0]}`,
  );
  await dbWrite.execute(
    sql`UPDATE crypto_sweep_outbox SET next_attempt_at=now()+interval '1 day' WHERE payment_id=${ids[1]}`,
  );
  expect(await service.drainSweepOutbox(environment())).toEqual({
    processed: 1,
    delivered: 0,
    deferred: 1,
  });
  expect(prepared).toHaveLength(1);
  expect(submissions).toHaveLength(1);
});

test("legacy identity recovery visits the complete history across batches", async () => {
  await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow("awaiting");
  const first = (await rows())[0];
  const [saved] = (
    await dbWrite.execute(
      sql`SELECT payload,payload_digest,prepared_metadata FROM crypto_sweep_outbox WHERE id=${first.id}`,
    )
  ).rows as Array<{
    payload: object;
    payload_digest: string;
    prepared_metadata: Record<string, unknown>;
  }>;
  const foreignRaw = await privateKeyToAccount(OTHER_KEY).signTransaction({
    chainId: 8453,
    nonce: 7,
    to: environment().CRYPTO_DIRECT_BASE_SECURE_ADDRESS as Hex,
    value: 1n,
    gas: 21000n,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
    type: "eip1559",
  });
  await dbWrite.execute(sql`TRUNCATE crypto_sweep_outbox`);
  await seed(ids[1], 200);
  await dbWrite.execute(sql`INSERT INTO crypto_payments(id,status,organization_id,user_id)
    SELECT ('70000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'confirmed',${organizationId},${userId} FROM generate_series(1,150) i`);
  await dbWrite.execute(sql`INSERT INTO crypto_sweep_outbox(id,payment_id,payload,payload_digest,prepared_transaction,sweep_transaction_hash,prepared_metadata)
    SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,('70000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'{}','legacy-foreign',${foreignRaw},${viem.keccak256(foreignRaw)},${JSON.stringify({ network: "base", nonce: "7", sweepTo: environment().CRYPTO_DIRECT_BASE_SECURE_ADDRESS })}::jsonb FROM generate_series(1,150) i`);
  const { sender: _sender, ...legacyMetadata } = saved.prepared_metadata;
  await dbWrite.execute(sql`INSERT INTO crypto_sweep_outbox(id,payment_id,payload,payload_digest,prepared_transaction,sweep_transaction_hash,prepared_metadata)
    VALUES('ffffffff-ffff-4fff-8fff-ffffffffffff',${ids[0]},${JSON.stringify(saved.payload)}::jsonb,${saved.payload_digest},${first.prepared_transaction},${first.sweep_transaction_hash},${JSON.stringify(legacyMetadata)}::jsonb)`);
  await expect(service.processSweepForPayment(environment(), ids[1])).rejects.toThrow("nonce");
  const [restored] = (
    await dbWrite.execute(
      sql`SELECT evm_sender FROM crypto_sweep_outbox WHERE id='ffffffff-ffff-4fff-8fff-ffffffffffff'`,
    )
  ).rows;
  expect(restored.evm_sender).toBe(environment().CRYPTO_DIRECT_BASE_RECEIVE_ADDRESS.toLowerCase());
  expect(prepared).toHaveLength(1);
});

test("a confirmed original receipt remains recoverable after receive-wallet rotation", async () => {
  await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow("awaiting");
  const original = (await rows())[0];
  mine(original.sweep_transaction_hash!);
  advance();
  expect(await service.processSweepForPayment(environment(OTHER_KEY), ids[0])).toBe(true);
  const recovered = (await rows())[0];
  expect(recovered.evm_confirmed_at).not.toBeNull();
  expect(recovered.evm_sender).toBe(environment().CRYPTO_DIRECT_BASE_RECEIVE_ADDRESS.toLowerCase());
  expect(recovered.prepared_transaction).toBe(original.prepared_transaction);
  expect(submissions).toHaveLength(1);
  expect(prepared).toHaveLength(1);
  await dbWrite.execute(sql`DELETE FROM crypto_payments WHERE id=${ids[0]}`);
  expect((await rows()).some((row) => row.payment_id === ids[0])).toBe(false);
});

test("wallet rotation cannot authorize resending an original transaction with no receipt", async () => {
  await expect(service.processSweepForPayment(environment(), ids[0])).rejects.toThrow("awaiting");
  const original = (await rows())[0];
  accepted.delete(original.sweep_transaction_hash!);
  advance();
  await expect(service.processSweepForPayment(environment(OTHER_KEY), ids[0])).rejects.toThrow(
    "wallet requires reconciliation",
  );
  expect((await rows())[0].prepared_transaction).toBe(original.prepared_transaction);
  expect((await rows())[0].evm_confirmed_at).toBeNull();
  expect(submissions).toHaveLength(1);
  expect(prepared).toHaveLength(1);
});
