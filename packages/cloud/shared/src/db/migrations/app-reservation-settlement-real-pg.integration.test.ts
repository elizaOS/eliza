/** Exercises the 0268 first-terminal reservation lock with two real PostgreSQL connections. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

const dsn = process.env.APP_RESERVATION_SETTLEMENT_TEST_DSN;
const describeRealPg = dsn ? describe : describe.skip;
const schemaName = `app_settlement_${process.pid}_${Date.now()}`;
const migrationSql = await Bun.file(
  new URL("./0268_app_reservation_settlement_authority.sql", import.meta.url),
).text();
let admin: Client;
const backendPidByClient = new WeakMap<Client, number>();

describeRealPg("0268 app reservation settlement real PostgreSQL concurrency", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: dsn });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    await admin.query(`SET search_path TO ${schemaName}`);
    await admin.query(`
      CREATE TABLE organizations (id uuid PRIMARY KEY);
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE apps (id uuid PRIMARY KEY);
      CREATE TABLE credit_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id),
        amount numeric(16,6) NOT NULL,
        type text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}',
        stripe_payment_intent_id text UNIQUE,
        settled_at timestamptz,
        CONSTRAINT credit_transactions_id_organization_unique UNIQUE (id, organization_id)
      );
      CREATE TABLE redeemable_earnings_ledger (
        id uuid PRIMARY KEY, user_id uuid REFERENCES users(id) ON DELETE CASCADE,
        amount numeric(16,4), earnings_source text,
        source_id uuid, entry_type text, metadata jsonb NOT NULL DEFAULT '{}'
      );
      CREATE TABLE app_earnings_transactions (
        id uuid PRIMARY KEY, app_id uuid REFERENCES apps(id) ON DELETE CASCADE,
        user_id uuid, type text,
        amount numeric(16,6), metadata jsonb NOT NULL DEFAULT '{}'
      );
    `);
    await admin.query(migrationSql);
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.query("SET search_path TO public");
    await admin.query(`DROP SCHEMA ${schemaName} CASCADE`);
    await admin.end();
  });

  async function settle(
    reservationId: string,
    source: "provider" | "stale_sweep",
    actual: string,
    holdMs: number,
    onReservationLocked?: () => void,
  ) {
    const client = new Client({ connectionString: dsn });
    await client.connect();
    try {
      await client.query(`SET search_path TO ${schemaName}`);
      await client.query("BEGIN");
      const reservation = await client.query(
        "SELECT * FROM credit_transactions WHERE id = $1 FOR UPDATE",
        [reservationId],
      );
      onReservationLocked?.();
      const existing = await client.query(
        "SELECT * FROM app_reservation_settlements WHERE reservation_transaction_id = $1",
        [reservationId],
      );
      if (existing.rowCount) {
        await client.query("COMMIT");
        return existing.rows[0];
      }
      if (holdMs > 0) await client.query("SELECT pg_sleep($1)", [holdMs / 1000]);
      const org = reservation.rows[0].organization_id as string;
      const adjustment = actual === "0.01" ? "-0.02" : "-0.01";
      const adjustmentRow = await client.query(
        `INSERT INTO credit_transactions(
          organization_id, amount, type, stripe_payment_intent_id
        ) VALUES ($1, $2, 'refund', $3) RETURNING id`,
        [org, adjustment === "-0.02" ? "0.02" : "0.01", `reconcile-refund:${reservationId}`],
      );
      const inserted = await client.query(
        `INSERT INTO app_reservation_settlements(
          reservation_transaction_id, organization_id, app_id, user_id,
          terminal_source, outcome, reserved_base_cost, actual_base_cost,
          markup_percentage, reserved_total_cost, actual_total_cost,
          organization_adjustment, creator_adjustment, platform_adjustment,
          credit_transaction_id
        ) VALUES ($1,$2,$3,$4,$5,'refund',0.03,$6,0,0.03,$6,$7,0,$7,$8)
        RETURNING *`,
        [
          reservationId,
          org,
          reservation.rows[0].metadata.appId,
          reservation.rows[0].metadata.userId,
          source,
          actual,
          adjustment,
          adjustmentRow.rows[0].id,
        ],
      );
      await client.query("COMMIT");
      return inserted.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
  }

  async function seed(reservationId: string) {
    const org = crypto.randomUUID();
    const app = crypto.randomUUID();
    const user = crypto.randomUUID();
    await admin.query("INSERT INTO organizations(id) VALUES ($1)", [org]);
    await admin.query(
      `INSERT INTO credit_transactions(id, organization_id, amount, type, metadata)
       VALUES ($1,$2,-0.03,'debit',$3)`,
      [
        reservationId,
        org,
        {
          type: "app_chat_reservation",
          settlement_marker: "app_chat_reservation_v1",
          appId: app,
          userId: user,
          reserved_amount: 0.03,
        },
      ],
    );
    return { org, app, user };
  }

  async function connectedClient(): Promise<Client> {
    const client = new Client({ connectionString: dsn });
    await client.connect();
    await client.query(`SET search_path TO ${schemaName}`);
    const pidResult = await client.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid");
    const pid = pidResult.rows[0]?.pid;
    if (pid === undefined || !Number.isInteger(pid))
      throw new Error("PostgreSQL connection did not report a backend PID");
    backendPidByClient.set(client, pid);
    return client;
  }

  async function expectBackendBlocked(blocked: Client, blocker: Client): Promise<void> {
    const blockedPid = backendPidByClient.get(blocked);
    const blockerPid = backendPidByClient.get(blocker);
    if (blockedPid === undefined || blockerPid === undefined) {
      throw new Error("PostgreSQL blocking assertion requires captured backend PIDs");
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await admin.query<{ blockers: number[] }>(
        "SELECT pg_blocking_pids($1)::int[] AS blockers",
        [blockedPid],
      );
      if (result.rows[0]?.blockers.includes(blockerPid)) {
        expect(result.rows[0].blockers).toContain(blockerPid);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`backend ${blockedPid} did not block on ${blockerPid}`);
  }

  test("provider-first and sweep-first differing actuals each commit one exact receipt", async () => {
    const providerFirst = crypto.randomUUID();
    await seed(providerFirst);
    let signalProviderLocked!: () => void;
    const providerLocked = new Promise<void>((resolve) => {
      signalProviderLocked = resolve;
    });
    const provider = settle(providerFirst, "provider", "0.01", 100, signalProviderLocked);
    await providerLocked;
    const lateSweep = settle(providerFirst, "stale_sweep", "0.02", 0);
    const providerResults = await Promise.all([provider, lateSweep]);
    expect(providerResults[0].actual_base_cost).toBe("0.010000");
    expect(providerResults[1].actual_base_cost).toBe("0.010000");

    const sweepFirst = crypto.randomUUID();
    await seed(sweepFirst);
    let signalSweepLocked!: () => void;
    const sweepLocked = new Promise<void>((resolve) => {
      signalSweepLocked = resolve;
    });
    const sweep = settle(sweepFirst, "stale_sweep", "0.02", 100, signalSweepLocked);
    await sweepLocked;
    const lateProvider = settle(sweepFirst, "provider", "0.01", 0);
    const sweepResults = await Promise.all([sweep, lateProvider]);
    expect(sweepResults[0].actual_base_cost).toBe("0.020000");
    expect(sweepResults[1].actual_base_cost).toBe("0.020000");

    const counts = await admin.query(
      `SELECT reservation_transaction_id, count(*)::int AS receipts
       FROM app_reservation_settlements GROUP BY reservation_transaction_id`,
    );
    expect(counts.rows).toHaveLength(2);
    expect(counts.rows.every((row) => row.receipts === 1)).toBe(true);

    const cascadeOrg = crypto.randomUUID();
    const cascadeCreator = crypto.randomUUID();
    const cascadeApp = crypto.randomUUID();
    const cascadeUser = crypto.randomUUID();
    const cascadeReservation = crypto.randomUUID();
    const cascadeAdjustment = crypto.randomUUID();
    const cascadeLedger = crypto.randomUUID();
    const cascadeProjection = crypto.randomUUID();
    await admin.query("INSERT INTO organizations(id) VALUES ($1)", [cascadeOrg]);
    await admin.query("INSERT INTO users(id) VALUES ($1)", [cascadeCreator]);
    await admin.query("INSERT INTO apps(id) VALUES ($1)", [cascadeApp]);
    await admin.query(
      `INSERT INTO credit_transactions(id, organization_id, amount, type, metadata)
       VALUES ($1,$2,-0.06,'debit',$3)`,
      [
        cascadeReservation,
        cascadeOrg,
        {
          type: "app_chat_reservation",
          settlement_marker: "app_chat_reservation_v1",
          appId: cascadeApp,
          userId: cascadeUser,
          creatorUserId: cascadeCreator,
          reserved_amount: 0.03,
        },
      ],
    );
    await admin.query(
      `INSERT INTO credit_transactions(
         id, organization_id, amount, type, stripe_payment_intent_id, metadata
       ) VALUES ($1,$2,0.04,'refund',$3,'{}')`,
      [cascadeAdjustment, cascadeOrg, `reconcile-refund:${cascadeReservation}`],
    );
    await admin.query(
      `INSERT INTO redeemable_earnings_ledger(
         id, user_id, amount, earnings_source, entry_type
       ) VALUES ($1,$2,-0.02,'miniapp','reconciliation_reduction')`,
      [cascadeLedger, cascadeCreator],
    );
    await admin.query(
      `INSERT INTO app_earnings_transactions(id, app_id, user_id, type, amount, metadata)
       VALUES ($1,$2,$3,'inference_markup',-0.02,$4)`,
      [cascadeProjection, cascadeApp, cascadeUser, { redeemableLedgerEntryId: cascadeLedger }],
    );
    await admin.query(
      `INSERT INTO app_reservation_settlements(
         reservation_transaction_id, organization_id, app_id, user_id, creator_user_id,
         terminal_source, outcome, reserved_base_cost, actual_base_cost,
         markup_percentage, reserved_total_cost, actual_total_cost,
         organization_adjustment, creator_adjustment, platform_adjustment,
         credit_transaction_id, redeemable_ledger_entry_id, app_earnings_transaction_id
       ) VALUES ($1,$2,$3,$4,$5,'provider','refund',0.03,0.01,100,0.06,0.02,
         -0.04,-0.02,-0.02,$6,$7,$8)`,
      [
        cascadeReservation,
        cascadeOrg,
        cascadeApp,
        cascadeUser,
        cascadeCreator,
        cascadeAdjustment,
        cascadeLedger,
        cascadeProjection,
      ],
    );
    await expect(
      admin.query("DELETE FROM redeemable_earnings_ledger WHERE id = $1", [cascadeLedger]),
    ).rejects.toThrow("cannot be deleted directly");
    await expect(
      admin.query("DELETE FROM app_earnings_transactions WHERE id = $1", [cascadeProjection]),
    ).rejects.toThrow("cannot be deleted directly");
    await admin.query("DELETE FROM apps WHERE id = $1", [cascadeApp]);
    await admin.query("DELETE FROM users WHERE id = $1", [cascadeCreator]);
    const cascadeProof = await admin.query(
      `SELECT
         (SELECT count(*)::int FROM app_reservation_settlements
           WHERE reservation_transaction_id = $1) AS receipts,
         (SELECT count(*)::int FROM app_earnings_transactions WHERE id = $2) AS app_rows,
         (SELECT count(*)::int FROM redeemable_earnings_ledger WHERE id = $3) AS creator_rows`,
      [cascadeReservation, cascadeProjection, cascadeLedger],
    );
    expect(cascadeProof.rows[0]).toEqual({ receipts: 1, app_rows: 0, creator_rows: 0 });

    const quarantineReservation = crypto.randomUUID();
    await seed(quarantineReservation);
    await admin.query("UPDATE credit_transactions SET settled_at = now() WHERE id = $1", [
      quarantineReservation,
    ]);
    const quarantineFacts = await admin.query(
      "SELECT organization_id, metadata FROM credit_transactions WHERE id = $1",
      [quarantineReservation],
    );
    await expect(
      admin.query(
        `INSERT INTO app_reservation_settlements(
           reservation_transaction_id, organization_id, app_id, user_id,
           terminal_source, outcome, reserved_base_cost, actual_base_cost,
           markup_percentage, reserved_total_cost, actual_total_cost,
           organization_adjustment, creator_adjustment, platform_adjustment
         ) VALUES ($1,$2,$3,$4,'provider','none',0.03,0.03,0,0.03,0.03,0,0,0)`,
        [
          quarantineReservation,
          quarantineFacts.rows[0].organization_id,
          quarantineFacts.rows[0].metadata.appId,
          quarantineFacts.rows[0].metadata.userId,
        ],
      ),
    ).rejects.toThrow("does not match immutable reservation facts");
    const quarantineProof = await admin.query(
      `SELECT
         (SELECT count(*)::int FROM app_reservation_settlement_quarantines
           WHERE reservation_transaction_id = $1) AS quarantines,
         (SELECT count(*)::int FROM app_reservation_settlements
           WHERE reservation_transaction_id = $1) AS receipts`,
      [quarantineReservation],
    );
    expect(quarantineProof.rows[0]).toEqual({ quarantines: 1, receipts: 0 });
  });

  test("serializes receipt and quarantine contenders in both reservation-lock orders", async () => {
    const receiptFirstReservation = crypto.randomUUID();
    const receiptFirstFacts = await seed(receiptFirstReservation);
    const receiptWinner = await connectedClient();
    const legacyWaiter = await connectedClient();
    try {
      await receiptWinner.query("BEGIN");
      await receiptWinner.query(
        `INSERT INTO app_reservation_settlements(
           reservation_transaction_id, organization_id, app_id, user_id,
           terminal_source, outcome, reserved_base_cost, actual_base_cost,
           markup_percentage, reserved_total_cost, actual_total_cost,
           organization_adjustment, creator_adjustment, platform_adjustment
         ) VALUES ($1,$2,$3,$4,'provider','none',0.03,0.03,0,0.03,0.03,0,0,0)`,
        [
          receiptFirstReservation,
          receiptFirstFacts.org,
          receiptFirstFacts.app,
          receiptFirstFacts.user,
        ],
      );

      await legacyWaiter.query("BEGIN");
      const legacyAttempt = legacyWaiter
        .query("UPDATE credit_transactions SET settled_at = now() WHERE id = $1", [
          receiptFirstReservation,
        ])
        .then(
          () => ({ ok: true as const }),
          (error: Error) => ({ ok: false as const, error }),
        );
      await expectBackendBlocked(legacyWaiter, receiptWinner);
      await receiptWinner.query("COMMIT");
      expect(await legacyAttempt).toEqual({ ok: true });
      await legacyWaiter.query("COMMIT");

      const receiptFirstProof = await admin.query(
        `SELECT
           (SELECT count(*)::int FROM app_reservation_settlements
             WHERE reservation_transaction_id = $1) AS receipts,
           (SELECT count(*)::int FROM app_reservation_settlement_quarantines
             WHERE reservation_transaction_id = $1) AS quarantines`,
        [receiptFirstReservation],
      );
      expect(receiptFirstProof.rows[0]).toEqual({ receipts: 1, quarantines: 0 });
    } finally {
      await receiptWinner.query("ROLLBACK");
      await legacyWaiter.query("ROLLBACK");
      await receiptWinner.end();
      await legacyWaiter.end();
    }

    const quarantineFirstReservation = crypto.randomUUID();
    const quarantineFirstFacts = await seed(quarantineFirstReservation);
    const legacyWinner = await connectedClient();
    const receiptWaiter = await connectedClient();
    try {
      await legacyWinner.query("BEGIN");
      await legacyWinner.query("UPDATE credit_transactions SET settled_at = now() WHERE id = $1", [
        quarantineFirstReservation,
      ]);

      await receiptWaiter.query("BEGIN");
      const receiptAttempt = receiptWaiter
        .query(
          `INSERT INTO app_reservation_settlements(
             reservation_transaction_id, organization_id, app_id, user_id,
             terminal_source, outcome, reserved_base_cost, actual_base_cost,
             markup_percentage, reserved_total_cost, actual_total_cost,
             organization_adjustment, creator_adjustment, platform_adjustment
           ) VALUES ($1,$2,$3,$4,'provider','none',0.03,0.03,0,0.03,0.03,0,0,0)`,
          [
            quarantineFirstReservation,
            quarantineFirstFacts.org,
            quarantineFirstFacts.app,
            quarantineFirstFacts.user,
          ],
        )
        .then(
          () => ({ ok: true as const }),
          (error: Error) => ({ ok: false as const, error }),
        );
      await expectBackendBlocked(receiptWaiter, legacyWinner);
      await legacyWinner.query("COMMIT");
      const rejectedReceipt = await receiptAttempt;
      expect(rejectedReceipt.ok).toBe(false);
      if (rejectedReceipt.ok) throw new Error("quarantine-first receipt unexpectedly committed");
      expect(rejectedReceipt.error.message).toContain("does not match immutable reservation facts");
      await receiptWaiter.query("ROLLBACK");

      const quarantineFirstProof = await admin.query(
        `SELECT
           (SELECT count(*)::int FROM app_reservation_settlements
             WHERE reservation_transaction_id = $1) AS receipts,
           (SELECT count(*)::int FROM app_reservation_settlement_quarantines
             WHERE reservation_transaction_id = $1) AS quarantines`,
        [quarantineFirstReservation],
      );
      expect(quarantineFirstProof.rows[0]).toEqual({ receipts: 0, quarantines: 1 });
    } finally {
      await legacyWinner.query("ROLLBACK");
      await receiptWaiter.query("ROLLBACK");
      await legacyWinner.end();
      await receiptWaiter.end();
    }
  });
});
